// /admin/compliance/grievances — formal patient complaints,
// grievances, and adverse events.
//
//   GET   /admin/compliance/grievances             — triage list
//   POST  /admin/compliance/grievances             — record an issue
//   PATCH /admin/compliance/grievances/:id         — status transition
//                                                     + resolution
//                                                     + FDA report flag
//
// State machine lives in lib/compliance/training-expiry.ts (shared
// with training-records for the same accreditation surface).
//
// PHI posture: each row is patient-bound. Audit metadata records
// the row id + status transition + kind only — never the summary
// or description.

import { Router, type IRouter } from "express";
import { z } from "zod";

import { logAudit } from "@workspace/resupply-audit";
import {
  type Database,
  getSupabaseServiceRoleClient,
} from "@workspace/resupply-db";

import {
  isLegalGrievanceTransition,
  type GrievanceStatus,
} from "../../lib/compliance/training-expiry";
import { logger } from "../../lib/logger";
import { buildMedWatchSummary } from "../../lib/medwatch/build-summary";
import { adminRateLimit } from "../../middlewares/admin-rate-limit";
import { requirePermission } from "../../middlewares/requireAdmin";

type GrievanceUpdate =
  Database["resupply"]["Tables"]["patient_grievances"]["Update"];

const router: IRouter = Router();

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const idParam = z.object({ id: z.string().uuid() });

const KIND_VALUES = ["complaint", "grievance", "adverse_event"] as const;
const SEVERITY_VALUES = ["low", "moderate", "high"] as const;
const SOURCE_VALUES = [
  "phone",
  "email",
  "sms",
  "in_person",
  "letter",
  "portal",
  "other",
] as const;
const STATUS_VALUES = [
  "open",
  "acknowledged",
  "escalated",
  "resolved",
  "reopened",
] as const;
const FDA_VALUES = ["yes", "no", "not_applicable"] as const;

const createBody = z
  .object({
    patientId: z.string().uuid(),
    equipmentAssetId: z.string().uuid().nullable().optional(),
    kind: z.enum(KIND_VALUES),
    severity: z.enum(SEVERITY_VALUES).optional().default("low"),
    source: z.enum(SOURCE_VALUES),
    summary: z.string().trim().min(1).max(200),
    description: z.string().trim().max(10_000).nullable().optional(),
    receivedAt: z.string().regex(ISO_DATE),
    notes: z.string().trim().max(5_000).nullable().optional(),
  })
  .strict();

const patchBody = z
  .object({
    status: z.enum(STATUS_VALUES).optional(),
    severity: z.enum(SEVERITY_VALUES).optional(),
    resolution: z.string().trim().max(5_000).nullable().optional(),
    reportedToFda: z.enum(FDA_VALUES).optional(),
    fdaReportReference: z
      .string()
      .trim()
      .max(64)
      .nullable()
      .optional(),
    notes: z.string().trim().max(5_000).nullable().optional(),
  })
  .strict();

router.get(
  "/admin/compliance/grievances",
  // List view of the grievance queue. Exact 1:1 catalog match —
  // `grievances.read` is held by admin / supervisor / csr /
  // compliance_officer / agent. Removes fitter and fulfillment which
  // have no compliance workflow here.
  requirePermission("grievances.read"),
  async (req, res) => {
    const qSchema = z
      .object({
        status: z
          .enum([
            "open",
            "acknowledged",
            "escalated",
            "resolved",
            "reopened",
            "active", // pseudo: not resolved
            "all",
          ])
          .optional()
          .default("active"),
      })
      .safeParse(req.query);
    if (!qSchema.success) {
      res.status(400).json({ error: "invalid_query" });
      return;
    }
    const supabase = getSupabaseServiceRoleClient();
    let query = supabase
      .schema("resupply")
      .from("patient_grievances")
      .select(
        "id, patient_id, equipment_asset_id, kind, severity, source, summary, received_at, status, acknowledged_at, resolved_at, resolution, reported_to_fda, fda_report_reference, notes, created_at, updated_at",
      )
      .order("severity", { ascending: false })
      .order("received_at", { ascending: false });
    if (qSchema.data.status === "active") {
      query = query.not("status", "eq", "resolved");
    } else if (qSchema.data.status !== "all") {
      query = query.eq("status", qSchema.data.status);
    }
    const { data, error } = await query;
    if (error) throw error;

    res.json({
      grievances: (data ?? []).map((r) => ({
        id: r.id,
        patientId: r.patient_id,
        equipmentAssetId: r.equipment_asset_id,
        kind: r.kind,
        severity: r.severity,
        source: r.source,
        summary: r.summary,
        receivedAt: r.received_at,
        status: r.status,
        acknowledgedAt: r.acknowledged_at,
        resolvedAt: r.resolved_at,
        resolution: r.resolution,
        reportedToFda: r.reported_to_fda,
        fdaReportReference: r.fda_report_reference,
        notes: r.notes,
        createdAt: r.created_at,
        updatedAt: r.updated_at,
      })),
    });
  },
);

router.post(
  "/admin/compliance/grievances",
  // Records a new grievance — write-tier. `grievances.resolve` is
  // held by admin / supervisor / compliance_officer. Removes csr /
  // agent (who can READ to escalate but should not author new
  // grievance rows directly — surveyors expect a compliance-officer
  // chain-of-custody on the write path).
  requirePermission("grievances.resolve"),
  adminRateLimit({ name: "grievances.create", preset: "sensitive" }),
  async (req, res) => {
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
    const b = parsed.data;
    const supabase = getSupabaseServiceRoleClient();

    const { data: patient, error: patientErr } = await supabase
      .schema("resupply")
      .from("patients")
      .select("id")
      .eq("id", b.patientId)
      .limit(1)
      .maybeSingle();
    if (patientErr) {
      logger.error({ err: patientErr }, "compliance.grievance.create: patient lookup failed");
      res.status(500).json({
        error: "patient_lookup_failed",
        message: "Failed to verify patient — database error.",
      });
      return;
    }
    if (!patient) {
      res.status(404).json({ error: "patient_not_found" });
      return;
    }

    const { data: row, error } = await supabase
      .schema("resupply")
      .from("patient_grievances")
      .insert({
        patient_id: b.patientId,
        equipment_asset_id: b.equipmentAssetId ?? null,
        kind: b.kind,
        severity: b.severity,
        source: b.source,
        summary: b.summary,
        description: b.description ?? null,
        received_at: b.receivedAt,
        notes: b.notes ?? null,
      })
      .select("id")
      .single();
    if (error) throw error;

    await logAudit({
      action: "compliance.grievance.create",
      adminEmail: req.adminEmail ?? null,
      adminUserId: req.adminUserId ?? null,
      targetTable: "patient_grievances",
      targetId: row.id,
      metadata: {
        kind: b.kind,
        severity: b.severity,
        source: b.source,
        // summary/description/patient_id withheld — PHI.
      },
      ip: req.ip ?? null,
      userAgent: req.get("user-agent") ?? null,
    }).catch((err) => {
      logger.warn({ err }, "compliance.grievance.create audit failed");
    });

    res.status(201).json({ id: row.id });
  },
);

router.patch(
  "/admin/compliance/grievances/:id",
  // Move state (resolved / closed / escalated). `grievances.resolve`
  // is the catalog's resolution permission — same scope as POST.
  requirePermission("grievances.resolve"),
  adminRateLimit({ name: "grievances.update", preset: "sensitive" }),
  async (req, res) => {
    const params = idParam.safeParse(req.params);
    if (!params.success) {
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
    const fields = parsed.data;
    if (Object.keys(fields).length === 0) {
      res.status(200).json({ changed: false });
      return;
    }
    const supabase = getSupabaseServiceRoleClient();

    let prevStatus: GrievanceStatus | null = null;
    if (fields.status !== undefined) {
      const { data: existing, error: existingErr } = await supabase
        .schema("resupply")
        .from("patient_grievances")
        .select("status")
        .eq("id", params.data.id)
        .limit(1)
        .maybeSingle();
      if (existingErr) {
        logger.error({ err: existingErr }, "compliance.grievance.update: status lookup failed");
        res.status(500).json({
          error: "status_lookup_failed",
          message: "Failed to verify current status — database error.",
        });
        return;
      }
      if (!existing) {
        res.status(404).json({ error: "not_found" });
        return;
      }
      prevStatus = existing.status;
      if (!isLegalGrievanceTransition(prevStatus, fields.status)) {
        res.status(400).json({
          error: "invalid_transition",
          message: `Cannot transition grievance from "${prevStatus}" to "${fields.status}".`,
        });
        return;
      }
    }

    const updates: GrievanceUpdate = {};
    if (fields.status !== undefined) {
      updates.status = fields.status;
      // Stamp acknowledged_at on first move out of `open`.
      if (
        prevStatus === "open" &&
        fields.status !== "open" &&
        fields.status !== "resolved"
      ) {
        updates.acknowledged_at = new Date().toISOString();
        updates.acknowledged_by_user_id = req.adminUserId ?? null;
      }
      // Stamp resolved_at on transition into `resolved`.
      if (fields.status === "resolved") {
        updates.resolved_at = new Date().toISOString();
        updates.resolved_by_user_id = req.adminUserId ?? null;
      }
    }
    if (fields.severity !== undefined) updates.severity = fields.severity;
    if (fields.resolution !== undefined)
      updates.resolution = fields.resolution;
    if (fields.reportedToFda !== undefined)
      updates.reported_to_fda = fields.reportedToFda;
    if (fields.fdaReportReference !== undefined)
      updates.fda_report_reference = fields.fdaReportReference;
    if (fields.notes !== undefined) updates.notes = fields.notes;

    const { data: updated, error } = await supabase
      .schema("resupply")
      .from("patient_grievances")
      .update(updates)
      .eq("id", params.data.id)
      .select("id");
    if (error) throw error;
    if (!updated || updated.length === 0) {
      res.status(404).json({ error: "not_found" });
      return;
    }

    await logAudit({
      action: "compliance.grievance.update",
      adminEmail: req.adminEmail ?? null,
      adminUserId: req.adminUserId ?? null,
      targetTable: "patient_grievances",
      targetId: params.data.id,
      metadata: {
        updated_fields: Object.keys(fields),
        ...(prevStatus
          ? { from_status: prevStatus, to_status: fields.status }
          : {}),
      },
      ip: req.ip ?? null,
      userAgent: req.get("user-agent") ?? null,
    }).catch((err) => {
      logger.warn({ err }, "compliance.grievance.update audit failed");
    });
    res.status(200).json({ id: params.data.id, changed: true });
  },
);

// ────────────────────────────────────────────────────────────────
// GET /admin/compliance/grievances/:id/medwatch-summary — render a
// print-friendly MedWatch voluntary-report summary that the CSR
// can copy-paste into the FDA online form. Only valid for
// kind=adverse_event rows; refuses anything else.
//
// ?format=html (default) returns the print-friendly HTML.
// ?format=json returns the structured field bag.
// ────────────────────────────────────────────────────────────────
router.get(
  "/admin/compliance/grievances/:id/medwatch-summary",
  // FDA MedWatch summary view — read-tier. Same scope as the list.
  requirePermission("grievances.read"),
  async (req, res) => {
    const params = z.object({ id: z.string().uuid() }).safeParse(req.params);
    if (!params.success) {
      res.status(404).json({ error: "grievance_not_found" });
      return;
    }
    const format = req.query.format === "json" ? "json" : "html";
    const supabase = getSupabaseServiceRoleClient();
    const { data: grievance, error: gErr } = await supabase
      .schema("resupply")
      .from("patient_grievances")
      .select(
        "id, patient_id, equipment_asset_id, kind, severity, summary, description, received_at, fda_report_reference",
      )
      .eq("id", params.data.id)
      .limit(1)
      .maybeSingle();
    if (gErr) throw gErr;
    if (!grievance) {
      res.status(404).json({ error: "grievance_not_found" });
      return;
    }
    if (grievance.kind !== "adverse_event") {
      res.status(409).json({
        error: "not_adverse_event",
        message:
          "MedWatch summaries are only produced for kind=adverse_event rows.",
      });
      return;
    }

    const { data: patient, error: pErr } = await supabase
      .schema("resupply")
      .from("patients")
      .select(
        "id, legal_first_name, legal_last_name, date_of_birth",
      )
      .eq("id", grievance.patient_id)
      .limit(1)
      .maybeSingle();
    if (pErr) throw pErr;
    if (!patient) {
      res.status(404).json({ error: "patient_not_found" });
      return;
    }
    let asset: {
      manufacturer: string;
      model: string;
      serialNumber: string;
      dispensedAt: string | null;
    } | null = null;
    if (grievance.equipment_asset_id) {
      const { data: a } = await supabase
        .schema("resupply")
        .from("equipment_assets")
        .select("manufacturer, model, serial_number, dispensed_at")
        .eq("id", grievance.equipment_asset_id)
        .limit(1)
        .maybeSingle();
      if (a) {
        asset = {
          manufacturer: a.manufacturer,
          model: a.model,
          serialNumber: a.serial_number,
          dispensedAt: a.dispensed_at,
        };
      }
    }

    const summary = buildMedWatchSummary({
      grievance: {
        id: grievance.id,
        summary: grievance.summary,
        description: grievance.description,
        severity: grievance.severity as "low" | "moderate" | "high",
        receivedAt: grievance.received_at,
        fdaReportReference: grievance.fda_report_reference,
        kind: grievance.kind as
          | "complaint"
          | "grievance"
          | "adverse_event",
      },
      patient: {
        id: patient.id,
        legalFirstName: patient.legal_first_name,
        legalLastName: patient.legal_last_name,
        dateOfBirth: patient.date_of_birth,
        // patients schema has no sex column today — the MedWatch
        // form accepts blank here; CSR fills it on the FDA side.
        sex: null,
      },
      asset,
      practiceName:
        process.env.RESUPPLY_PRACTICE_NAME?.trim() || "PennPaps",
    });

    await logAudit({
      action: "compliance.medwatch.summary_generated",
      adminEmail: req.adminEmail ?? null,
      adminUserId: req.adminUserId ?? null,
      targetTable: "patient_grievances",
      targetId: grievance.id,
      metadata: { patient_id: grievance.patient_id, format },
      ip: req.ip ?? null,
      userAgent: req.get("user-agent") ?? null,
    }).catch((err) => {
      logger.warn(
        { err },
        "compliance.medwatch.summary_generated audit failed",
      );
    });

    if (format === "json") {
      res.json({ fields: summary.fields });
      return;
    }
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.send(summary.html);
  },
);

export default router;
