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
import { requireAdmin } from "../../middlewares/requireAdmin";

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
  requireAdmin,
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
  requireAdmin,
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
  requireAdmin,
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

export default router;
