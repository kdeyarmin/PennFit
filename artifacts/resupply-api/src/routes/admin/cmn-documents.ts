// /admin/.../cmn-documents — Certificate of Medical Necessity / DIF,
// the structured-form layer (Biller #29).
//
//   GET   /admin/patients/:id/cmn-documents        (patients.read)
//   POST  /admin/patients/:id/cmn-documents         (patients.update)
//   PATCH /admin/cmn-documents/:cmnId               (patients.update)
//   GET   /admin/billing/cmn-catalog                (reports.read)
//   GET   /admin/billing/cmn-worklist               (reports.read)
//
// The form's structured Q&A lives in `answers` (jsonb); a CMN can only be
// marked 'completed' when validateCmnAnswers passes for its form type.
// The worklist surfaces drafts/incomplete CMNs the biller must finish.
// Complements dwo_documents (which holds the signed PDF + expiry).

import { Router, type IRouter } from "express";
import { z } from "zod";

import { logAudit } from "@workspace/resupply-audit";
import { getSupabaseServiceRoleClient } from "@workspace/resupply-db";

import { renderCmnPdf } from "../../lib/billing/cmn-pdf";
import {
  CMN_FORMS,
  isCmnFormType,
  validateCmnAnswers,
} from "../../lib/billing/cmn-forms";
import { resolveBillingIdentity } from "../../lib/billing/identity-resolver";
import { logger } from "../../lib/logger";
import { adminReadRateLimiter } from "../../middlewares/admin-rate-limit";
import { requirePermission } from "../../middlewares/requireAdmin";

const router: IRouter = Router();

const answersSchema = z.record(z.string(), z.unknown());

const createSchema = z
  .object({
    formType: z.string().refine(isCmnFormType, "unknown form_type"),
    hcpcsCode: z.string().min(2).max(12),
    claimId: z.string().uuid().nullable().optional(),
    dwoDocumentId: z.string().uuid().nullable().optional(),
    physicianName: z.string().max(200).nullable().optional(),
    physicianNpi: z
      .string()
      .regex(/^\d{10}$/u)
      .nullable()
      .optional(),
    initialDate: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/u)
      .nullable()
      .optional(),
    recertDate: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/u)
      .nullable()
      .optional(),
    lengthOfNeedMonths: z.coerce
      .number()
      .int()
      .min(0)
      .max(120)
      .nullable()
      .optional(),
    answers: answersSchema.optional(),
  })
  .strip();

const patchSchema = z
  .object({
    status: z.enum(["draft", "completed", "on_file", "voided"]).optional(),
    physicianName: z.string().max(200).nullable().optional(),
    physicianNpi: z
      .string()
      .regex(/^\d{10}$/u)
      .nullable()
      .optional(),
    initialDate: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/u)
      .nullable()
      .optional(),
    recertDate: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/u)
      .nullable()
      .optional(),
    lengthOfNeedMonths: z.coerce
      .number()
      .int()
      .min(0)
      .max(120)
      .nullable()
      .optional(),
    answers: answersSchema.optional(),
  })
  .strip();

// Static catalog — lets the SPA render the right questions per form type.
router.get(
  "/admin/billing/cmn-catalog",
  adminReadRateLimiter,
  requirePermission("reports.read"),
  (_req, res) => {
    res.json({
      forms: Object.values(CMN_FORMS).map((f) => ({
        formType: f.formType,
        label: f.label,
        hcpcsCodes: f.hcpcsCodes,
        requiredKeys: f.requiredKeys,
        questions: f.questions,
      })),
    });
  },
);

router.get(
  "/admin/patients/:id/cmn-documents",
  adminReadRateLimiter,
  requirePermission("patients.read"),
  async (req, res) => {
    const idOk = z.string().uuid().safeParse(req.params.id);
    if (!idOk.success) {
      res.status(400).json({ error: "invalid_patient_id" });
      return;
    }
    const supabase = getSupabaseServiceRoleClient();
    const { data, error } = await supabase
      .schema("resupply")
      .from("cmn_documents")
      .select("*")
      .eq("patient_id", idOk.data)
      .order("created_at", { ascending: false });
    if (error) {
      res.status(500).json({ error: "query_failed", message: error.message });
      return;
    }
    const rows = (data ?? []) as Array<{
      form_type: string;
      answers: Record<string, unknown> | null;
    }>;
    res.json({
      documents: rows.map((d) => ({
        ...d,
        validation: validateCmnAnswers(d.form_type, d.answers),
      })),
    });
  },
);

router.post(
  "/admin/patients/:id/cmn-documents",
  requirePermission("patients.update"),
  async (req, res) => {
    const idOk = z.string().uuid().safeParse(req.params.id);
    if (!idOk.success) {
      res.status(400).json({ error: "invalid_patient_id" });
      return;
    }
    const parsed = createSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(400).json({ error: "invalid_body" });
      return;
    }
    const b = parsed.data;
    const supabase = getSupabaseServiceRoleClient();
    const { data, error } = await supabase
      .schema("resupply")
      .from("cmn_documents")
      .insert({
        patient_id: idOk.data,
        claim_id: b.claimId ?? null,
        dwo_document_id: b.dwoDocumentId ?? null,
        form_type: b.formType,
        hcpcs_code: b.hcpcsCode.toUpperCase(),
        status: "draft",
        answers: (b.answers ?? {}) as never,
        physician_name: b.physicianName ?? null,
        physician_npi: b.physicianNpi ?? null,
        initial_date: b.initialDate ?? null,
        recert_date: b.recertDate ?? null,
        length_of_need_months: b.lengthOfNeedMonths ?? null,
        created_by_email: req.adminEmail ?? "unknown",
      } as never)
      .select("id")
      .maybeSingle();
    if (error || !data) {
      res.status(500).json({ error: "create_failed" });
      return;
    }
    res.status(201).json({ id: (data as { id: string }).id });
  },
);

router.patch(
  "/admin/cmn-documents/:cmnId",
  requirePermission("patients.update"),
  async (req, res) => {
    const idOk = z.string().uuid().safeParse(req.params.cmnId);
    if (!idOk.success) {
      res.status(400).json({ error: "invalid_id" });
      return;
    }
    const parsed = patchSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(400).json({ error: "invalid_body" });
      return;
    }
    const supabase = getSupabaseServiceRoleClient();

    const { data: existing, error: loadErr } = await supabase
      .schema("resupply")
      .from("cmn_documents")
      .select("id, form_type, answers")
      .eq("id", idOk.data)
      .maybeSingle();
    if (loadErr) {
      res.status(500).json({ error: "query_failed", message: loadErr.message });
      return;
    }
    if (!existing) {
      res.status(404).json({ error: "not_found" });
      return;
    }

    const b = parsed.data;
    const nextAnswers =
      b.answers ??
      (existing as { answers: Record<string, unknown> | null }).answers ??
      {};

    // Refuse to complete an incomplete form — return the gaps.
    if (b.status === "completed") {
      const v = validateCmnAnswers(
        (existing as { form_type: string }).form_type,
        nextAnswers,
      );
      if (!v.ready) {
        res.status(409).json({ error: "incomplete", missing: v.missing });
        return;
      }
    }

    const update: Record<string, unknown> = {
      updated_at: new Date().toISOString(),
    };
    if (b.status !== undefined) update.status = b.status;
    if (b.answers !== undefined) update.answers = b.answers;
    if (b.physicianName !== undefined) update.physician_name = b.physicianName;
    if (b.physicianNpi !== undefined) update.physician_npi = b.physicianNpi;
    if (b.initialDate !== undefined) update.initial_date = b.initialDate;
    if (b.recertDate !== undefined) update.recert_date = b.recertDate;
    if (b.lengthOfNeedMonths !== undefined)
      update.length_of_need_months = b.lengthOfNeedMonths;

    const { error: updErr } = await supabase
      .schema("resupply")
      .from("cmn_documents")
      .update(update as never)
      .eq("id", idOk.data);
    if (updErr) {
      res.status(500).json({ error: "update_failed", message: updErr.message });
      return;
    }
    res.json({ ok: true });
  },
);

// Render the answered clinical questionnaire as a PDF (A5). Complements
// the DWO/CMN *cover* (dwo-documents.ts) by printing the Section B Q&A from
// the catalog paired with the stored answers, plus the physician
// attestation + signature line. GET (deterministic projection); no-store
// so the PHI bytes don't land in a cache.
router.get(
  "/admin/cmn-documents/:cmnId/pdf",
  requirePermission("patients.read"),
  async (req, res) => {
    const idOk = z.string().uuid().safeParse(req.params.cmnId);
    if (!idOk.success) {
      res.status(400).json({ error: "invalid_id" });
      return;
    }
    const supabase = getSupabaseServiceRoleClient();
    const { data: cmn, error } = await supabase
      .schema("resupply")
      .from("cmn_documents")
      .select(
        "id, patient_id, form_type, hcpcs_code, status, answers, physician_name, physician_npi, initial_date, recert_date, length_of_need_months",
      )
      .eq("id", idOk.data)
      .limit(1)
      .maybeSingle();
    if (error) {
      res.status(500).json({ error: "query_failed", message: error.message });
      return;
    }
    if (!cmn) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    const c = cmn as {
      patient_id: string;
      form_type: string;
      hcpcs_code: string;
      status: string;
      answers: Record<string, unknown> | null;
      physician_name: string | null;
      physician_npi: string | null;
      initial_date: string | null;
      recert_date: string | null;
      length_of_need_months: number | null;
    };
    if (!isCmnFormType(c.form_type)) {
      res.status(409).json({ error: "unrenderable_form_type" });
      return;
    }

    const { data: patient } = await supabase
      .schema("resupply")
      .from("patients")
      .select("legal_first_name, legal_last_name, date_of_birth, address")
      .eq("id", c.patient_id)
      .limit(1)
      .maybeSingle();
    if (!patient) {
      res.status(404).json({ error: "patient_not_found" });
      return;
    }

    const identity = await resolveBillingIdentity({ supabase });
    const supplierName =
      identity.source !== "stub"
        ? identity.billingProvider.organizationName
        : process.env.RESUPPLY_PRACTICE_NAME?.trim() || "PennPaps";

    const pdf = await renderCmnPdf({
      formType: c.form_type,
      hcpcsCode: c.hcpcs_code,
      status: c.status,
      answers: c.answers,
      physicianName: c.physician_name,
      physicianNpi: c.physician_npi,
      initialDate: c.initial_date,
      recertDate: c.recert_date,
      lengthOfNeedMonths: c.length_of_need_months,
      patient: {
        legalFirstName: patient.legal_first_name,
        legalLastName: patient.legal_last_name,
        dateOfBirth: patient.date_of_birth,
        address: (patient.address ?? null) as never,
      },
      supplierName,
      generatedOn: new Date(),
    });

    res.setHeader("Content-Type", "application/pdf");
    res.setHeader(
      "Content-Disposition",
      `inline; filename="cmn-${c.form_type}-${idOk.data.slice(0, 8)}.pdf"`,
    );
    res.setHeader("Cache-Control", "no-store");
    res.send(pdf);

    await logAudit({
      action: "cmn_document.pdf_rendered",
      adminEmail: req.adminEmail ?? null,
      adminUserId: req.adminUserId ?? null,
      targetTable: "cmn_documents",
      targetId: idOk.data,
      metadata: {
        patient_id: c.patient_id,
        form_type: c.form_type,
        hcpcs_code: c.hcpcs_code,
      },
      ip: req.ip ?? null,
      userAgent: req.get("user-agent") ?? null,
    }).catch((err) => {
      logger.warn({ err }, "cmn_document.pdf_rendered audit write failed");
    });
  },
);

// Worklist — draft / incomplete CMNs the biller must finish, newest first.
router.get(
  "/admin/billing/cmn-worklist",
  adminReadRateLimiter,
  requirePermission("reports.read"),
  async (_req, res) => {
    const supabase = getSupabaseServiceRoleClient();
    const { data, error } = await supabase
      .schema("resupply")
      .from("cmn_documents")
      .select(
        "id, patient_id, form_type, hcpcs_code, status, answers, created_at",
      )
      .eq("status", "draft")
      .order("created_at", { ascending: false })
      .limit(500);
    if (error) {
      res.status(500).json({ error: "query_failed", message: error.message });
      return;
    }
    const rows = (data ?? []) as Array<{
      id: string;
      patient_id: string;
      form_type: string;
      hcpcs_code: string;
      status: string;
      answers: Record<string, unknown> | null;
      created_at: string;
    }>;
    const items = rows.map((r) => {
      const v = validateCmnAnswers(r.form_type, r.answers);
      return {
        id: r.id,
        patientId: r.patient_id,
        formType: r.form_type,
        hcpcsCode: r.hcpcs_code,
        createdAt: r.created_at,
        ready: v.ready,
        missingCount: v.missing.length,
      };
    });
    res.json({
      items,
      count: items.length,
      readyToComplete: items.filter((i) => i.ready).length,
    });
  },
);

export default router;
