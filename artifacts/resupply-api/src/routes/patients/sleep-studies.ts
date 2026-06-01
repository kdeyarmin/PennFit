// /patients/:id/sleep-studies — diagnostic sleep-study records.
//
//   GET    /patients/:id/sleep-studies        — list newest-first
//   POST   /patients/:id/sleep-studies        — record a study
//   PATCH  /patients/:id/sleep-studies/:sid   — narrow updates only
//                                                (status notes, doc link)
//
// What this route owns
// --------------------
//   * Recording the numeric findings (AHI / RDI / SpO2 / sleep
//     efficiency) that downstream compliance gates reference.
//   * Linking each study to the interpreting provider in the
//     central providers registry.
//
// What this route does NOT own
// ----------------------------
//   * Editing the clinical findings post-save. AHI doesn't change
//     after the lab interprets the study; if a CSR mis-keyed a
//     value, they should mark the row's `notes` and add a new row
//     with the corrected reading. We deliberately keep
//     numeric-field mutation out of the PATCH surface to preserve
//     audit-grade provenance.
//
// PHI / log posture
// -----------------
//   * Numeric findings are PHI; never logged.
//   * Audit metadata includes patient_id + which fields were
//     populated, not the values themselves.

import { Router, type IRouter } from "express";
import { z } from "zod";

import { logAudit } from "@workspace/resupply-audit";
import {
  type Database,
  getSupabaseServiceRoleClient,
} from "@workspace/resupply-db";

type SleepStudyUpdate =
  Database["resupply"]["Tables"]["sleep_studies"]["Update"];

import { logger } from "../../lib/logger";
import {
  adminReadRateLimiter,
  adminWriteRateLimiter,
} from "../../middlewares/admin-rate-limit";
import { requireAdmin } from "../../middlewares/requireAdmin";

const router: IRouter = Router();

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

const idParam = z.object({ id: z.string().uuid() });
const idAndStudyParam = z.object({
  id: z.string().uuid(),
  sid: z.string().uuid(),
});

const createBody = z
  .object({
    studyDate: z.string().regex(ISO_DATE, "must be YYYY-MM-DD"),
    studyType: z.enum(["psg", "hsat", "split_night", "re_titration"]),
    ahi: z.number().min(0).max(150),
    rdi: z.number().min(0).max(150).nullable().optional(),
    lowestSpo2Pct: z.number().int().min(0).max(100).nullable().optional(),
    sleepEfficiencyPct: z.number().int().min(0).max(100).nullable().optional(),
    diagnosisIcd10: z
      .string()
      .trim()
      .max(16)
      .nullable()
      .optional()
      .transform((v) => (v === "" || v == null ? null : v)),
    interpretingProviderId: z.string().uuid().nullable().optional(),
    facilityName: z
      .string()
      .trim()
      .max(200)
      .nullable()
      .optional()
      .transform((v) => (v === "" || v == null ? null : v)),
    source: z
      .enum(["external_lab", "home_test_vendor", "csr_entry"])
      .optional()
      .default("csr_entry"),
    documentId: z.string().uuid().nullable().optional(),
    notes: z
      .string()
      .trim()
      .max(2000)
      .nullable()
      .optional()
      .transform((v) => (v === "" || v == null ? null : v)),
  })
  .strict();

const patchBody = z
  .object({
    notes: z.string().trim().max(2000).nullable().optional(),
    documentId: z.string().uuid().nullable().optional(),
    interpretingProviderId: z.string().uuid().nullable().optional(),
  })
  .strict();

router.get(
  "/patients/:id/sleep-studies",
  adminReadRateLimiter,
  requireAdmin,
  async (req, res) => {
    const idParsed = idParam.safeParse(req.params);
    if (!idParsed.success) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    const supabase = getSupabaseServiceRoleClient();
    const { data, error } = await supabase
      .schema("resupply")
      .from("sleep_studies")
      .select(
        "id, study_date, study_type, ahi, rdi, lowest_spo2_pct, sleep_efficiency_pct, diagnosis_icd10, interpreting_provider_id, facility_name, source, document_id, notes, created_at",
      )
      .eq("patient_id", idParsed.data.id)
      .order("study_date", { ascending: false });
    if (error) throw error;

    res.json({
      studies: (data ?? []).map((r) => ({
        id: r.id,
        studyDate: r.study_date,
        studyType: r.study_type,
        // PostgREST returns numeric as string — convert for the SPA.
        ahi: Number(r.ahi),
        rdi: r.rdi == null ? null : Number(r.rdi),
        lowestSpo2Pct: r.lowest_spo2_pct,
        sleepEfficiencyPct: r.sleep_efficiency_pct,
        diagnosisIcd10: r.diagnosis_icd10,
        interpretingProviderId: r.interpreting_provider_id,
        facilityName: r.facility_name,
        source: r.source,
        documentId: r.document_id,
        notes: r.notes,
        createdAt: r.created_at,
      })),
    });
  },
);

router.post(
  "/patients/:id/sleep-studies",
  adminWriteRateLimiter,
  requireAdmin,
  async (req, res) => {
    const idParsed = idParam.safeParse(req.params);
    if (!idParsed.success) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    const parsed = createBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({
        error: "invalid_body",
        issues: parsed.error.issues.map((i) => ({
          path: i.path.join("."),
          message: i.message,
        })),
      });
      return;
    }
    const body = parsed.data;
    const patientId = idParsed.data.id;

    const supabase = getSupabaseServiceRoleClient();
    const { data: patient } = await supabase
      .schema("resupply")
      .from("patients")
      .select("id")
      .eq("id", patientId)
      .limit(1)
      .maybeSingle();
    if (!patient) {
      res.status(404).json({ error: "not_found" });
      return;
    }

    const { data: row, error } = await supabase
      .schema("resupply")
      .from("sleep_studies")
      .insert({
        patient_id: patientId,
        study_date: body.studyDate,
        study_type: body.studyType,
        // Numeric columns accept JS numbers; PostgREST coerces them.
        ahi: body.ahi.toString(),
        rdi: body.rdi == null ? null : body.rdi.toString(),
        lowest_spo2_pct: body.lowestSpo2Pct ?? null,
        sleep_efficiency_pct: body.sleepEfficiencyPct ?? null,
        diagnosis_icd10: body.diagnosisIcd10 ?? null,
        interpreting_provider_id: body.interpretingProviderId ?? null,
        facility_name: body.facilityName ?? null,
        source: body.source,
        document_id: body.documentId ?? null,
        notes: body.notes ?? null,
      })
      .select("id")
      .single();
    if (error) throw error;

    const populated = ["studyDate", "studyType", "ahi"];
    if (body.rdi != null) populated.push("rdi");
    if (body.lowestSpo2Pct != null) populated.push("lowestSpo2Pct");
    if (body.sleepEfficiencyPct != null) populated.push("sleepEfficiencyPct");
    if (body.diagnosisIcd10) populated.push("diagnosisIcd10");
    if (body.interpretingProviderId) populated.push("interpretingProviderId");
    if (body.facilityName) populated.push("facilityName");
    if (body.documentId) populated.push("documentId");
    if (body.notes) populated.push("notes");

    await logAudit({
      action: "patient.sleep_study.create",
      adminEmail: req.adminEmail ?? null,
      adminUserId: req.adminUserId ?? null,
      targetTable: "sleep_studies",
      targetId: row.id,
      metadata: {
        patient_id: patientId,
        study_date: body.studyDate,
        study_type: body.studyType,
        source: body.source,
        populated_fields: populated,
      },
      ip: req.ip ?? null,
      userAgent: req.get("user-agent") ?? null,
    }).catch((err) => {
      logger.warn({ err }, "patient.sleep_study.create audit write failed");
    });

    res.status(201).json({ id: row.id });
  },
);

router.patch(
  "/patients/:id/sleep-studies/:sid",
  adminWriteRateLimiter,
  requireAdmin,
  async (req, res) => {
    const idParsed = idAndStudyParam.safeParse(req.params);
    if (!idParsed.success) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    const parsed = patchBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({
        error: "invalid_body",
        issues: parsed.error.issues.map((i) => ({
          path: i.path.join("."),
          message: i.message,
        })),
      });
      return;
    }
    if (Object.keys(parsed.data).length === 0) {
      res.status(200).json({ changed: false });
      return;
    }

    const { id: patientId, sid: studyId } = idParsed.data;
    const supabase = getSupabaseServiceRoleClient();

    const updates: SleepStudyUpdate = {};
    if (parsed.data.notes !== undefined) updates.notes = parsed.data.notes;
    if (parsed.data.documentId !== undefined)
      updates.document_id = parsed.data.documentId;
    if (parsed.data.interpretingProviderId !== undefined)
      updates.interpreting_provider_id = parsed.data.interpretingProviderId;

    const { data: updated, error } = await supabase
      .schema("resupply")
      .from("sleep_studies")
      .update(updates)
      .eq("id", studyId)
      .eq("patient_id", patientId)
      .select("id");
    if (error) throw error;
    if (!updated || updated.length === 0) {
      res.status(404).json({ error: "not_found" });
      return;
    }

    await logAudit({
      action: "patient.sleep_study.update",
      adminEmail: req.adminEmail ?? null,
      adminUserId: req.adminUserId ?? null,
      targetTable: "sleep_studies",
      targetId: studyId,
      metadata: {
        patient_id: patientId,
        updated_fields: Object.keys(parsed.data),
      },
      ip: req.ip ?? null,
      userAgent: req.get("user-agent") ?? null,
    }).catch((err) => {
      logger.warn({ err }, "patient.sleep_study.update audit write failed");
    });

    res.status(200).json({ id: studyId, changed: true });
  },
);

export default router;
