// /admin/asset-recovery — worklist of CPAP-machine recovery cases for
// patients who have discontinued therapy, so the device can be
// refurbished and redeployed.
//
//   GET   /admin/asset-recovery            — list cases (optional ?status=)
//   POST  /admin/asset-recovery            — open a new recovery case
//   PATCH /admin/asset-recovery/:id        — advance status / edit fields
//
// PennFit already DETECTS likely discontinuation (low-usage smart
// triggers + lapsed-customer win-back). This is the ACTION half — the
// human worklist that moves a device from "identified" to "received" /
// "redeployed". Carrier-label purchase and auto-population from the
// detection signals are tracked as follow-ups; v1 is manual case
// management with a free-form return_label_url + tracking_number.
//
// Gating: `cases.read` for the list, `cases.manage` for mutations.
//
// PHI / log posture: patient_label / notes may carry PHI and are stored
// as plaintext. The audit row records the case id + status only — never
// the patient label, notes, serial, or tracking number.

import { Router, type IRouter } from "express";
import { z } from "zod";

import { logAudit } from "@workspace/resupply-audit";
import { getSupabaseServiceRoleClient } from "@workspace/resupply-db";

import { logger } from "../../lib/logger";
import { adminRateLimit } from "../../middlewares/admin-rate-limit";
import { requirePermission } from "../../middlewares/requireAdmin";

const router: IRouter = Router();

const STATUSES = [
  "identified",
  "outreach",
  "label_sent",
  "in_transit",
  "received",
  "redeployed",
  "closed_unrecovered",
] as const;

const REASONS = [
  "discontinued",
  "non_compliant",
  "deceased",
  "upgraded",
  "insurance_change",
  "other",
] as const;

const listQuerySchema = z
  .object({
    status: z.enum(STATUSES).optional(),
    limit: z.coerce.number().int().min(1).max(200).optional(),
  })
  .strict();

const createSchema = z
  .object({
    patientId: z.string().uuid().optional(),
    patientLabel: z.string().trim().min(1).max(200).optional(),
    deviceLabel: z.string().trim().max(160).optional(),
    deviceSerial: z.string().trim().max(120).optional(),
    reason: z.enum(REASONS).optional(),
    notes: z.string().trim().max(4000).optional(),
  })
  .strict()
  // Require at least one way to identify the case subject.
  .refine((v) => v.patientId || v.patientLabel, {
    message: "Provide a patientId or a patientLabel.",
  });

const patchSchema = z
  .object({
    status: z.enum(STATUSES).optional(),
    reason: z.enum(REASONS).optional(),
    deviceLabel: z.string().trim().max(160).optional(),
    deviceSerial: z.string().trim().max(120).optional(),
    trackingNumber: z.string().trim().max(120).optional(),
    returnLabelUrl: z.string().trim().url().max(2000).optional(),
    notes: z.string().trim().max(4000).optional(),
  })
  .strict()
  .refine((v) => Object.keys(v).length > 0, {
    message: "Provide at least one field to update.",
  });

const idParam = z.string().uuid();

interface CaseRow {
  id: string;
  patient_id: string | null;
  patient_label: string | null;
  device_label: string | null;
  device_serial: string | null;
  status: string;
  reason: string;
  tracking_number: string | null;
  return_label_url: string | null;
  notes: string | null;
  created_by_email: string | null;
  updated_by_email: string | null;
  created_at: string;
  updated_at: string;
}

function toDto(r: CaseRow) {
  return {
    id: r.id,
    patientId: r.patient_id,
    patientLabel: r.patient_label,
    deviceLabel: r.device_label,
    deviceSerial: r.device_serial,
    status: r.status,
    reason: r.reason,
    trackingNumber: r.tracking_number,
    returnLabelUrl: r.return_label_url,
    notes: r.notes,
    createdByEmail: r.created_by_email,
    updatedByEmail: r.updated_by_email,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

const SELECT_COLS =
  "id, patient_id, patient_label, device_label, device_serial, status, reason, tracking_number, return_label_url, notes, created_by_email, updated_by_email, created_at, updated_at";

router.get(
  "/admin/asset-recovery",
  requirePermission("cases.read"),
  async (req, res) => {
    const parsed = listQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json({ error: "invalid_query" });
      return;
    }
    const { status, limit } = parsed.data;
    const supabase = getSupabaseServiceRoleClient();

    let q = supabase
      .schema("resupply")
      .from("asset_recovery_cases")
      .select(SELECT_COLS)
      .order("updated_at", { ascending: false })
      .limit(limit ?? 100);
    if (status) q = q.eq("status", status);

    const { data, error } = await q;
    if (error) {
      res.status(500).json({ error: "query_failed", message: error.message });
      return;
    }

    // Open-case counts by status power the worklist summary tiles.
    const { data: openRows, error: countErr } = await supabase
      .schema("resupply")
      .from("asset_recovery_cases")
      .select("status");
    const counts: Record<string, number> = {};
    if (!countErr) {
      for (const row of openRows ?? []) {
        const s = (row as { status: string }).status;
        counts[s] = (counts[s] ?? 0) + 1;
      }
    }

    res.json({
      cases: (data ?? []).map((r) => toDto(r as CaseRow)),
      counts,
    });
  },
);

router.post(
  "/admin/asset-recovery",
  requirePermission("cases.manage"),
  adminRateLimit({ name: "asset_recovery.create", preset: "mutation" }),
  async (req, res) => {
    const parsed = createSchema.safeParse(req.body);
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
    const v = parsed.data;
    const supabase = getSupabaseServiceRoleClient();

    const { data, error } = await supabase
      .schema("resupply")
      .from("asset_recovery_cases")
      .insert({
        patient_id: v.patientId ?? null,
        patient_label: v.patientLabel ?? null,
        device_label: v.deviceLabel ?? null,
        device_serial: v.deviceSerial ?? null,
        reason: v.reason ?? "discontinued",
        notes: v.notes ?? null,
        created_by_email: req.adminEmail ?? null,
        updated_by_email: req.adminEmail ?? null,
      })
      .select(SELECT_COLS)
      .single();
    if (error || !data) {
      res
        .status(500)
        .json({ error: "insert_failed", message: error?.message ?? "unknown" });
      return;
    }
    const row = data as CaseRow;

    await logAudit({
      action: "asset_recovery.case.create",
      adminEmail: req.adminEmail ?? null,
      adminUserId: req.adminUserId ?? null,
      targetTable: "asset_recovery_cases",
      targetId: row.id,
      metadata: { status: row.status, reason: row.reason },
      ip: req.ip ?? null,
      userAgent: req.get("user-agent") ?? null,
    }).catch((err) => {
      logger.warn({ err }, "asset_recovery.case.create audit write failed");
    });

    res.status(201).json({ case: toDto(row) });
  },
);

router.patch(
  "/admin/asset-recovery/:id",
  requirePermission("cases.manage"),
  adminRateLimit({ name: "asset_recovery.update", preset: "mutation" }),
  async (req, res) => {
    const idCheck = idParam.safeParse(req.params.id);
    if (!idCheck.success) {
      res.status(400).json({ error: "invalid_id" });
      return;
    }
    const parsed = patchSchema.safeParse(req.body);
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
    const v = parsed.data;
    const supabase = getSupabaseServiceRoleClient();

    const update: Record<string, unknown> = {
      updated_at: new Date().toISOString(),
      updated_by_email: req.adminEmail ?? null,
    };
    if (v.status !== undefined) update.status = v.status;
    if (v.reason !== undefined) update.reason = v.reason;
    if (v.deviceLabel !== undefined) update.device_label = v.deviceLabel;
    if (v.deviceSerial !== undefined) update.device_serial = v.deviceSerial;
    if (v.trackingNumber !== undefined)
      update.tracking_number = v.trackingNumber;
    if (v.returnLabelUrl !== undefined)
      update.return_label_url = v.returnLabelUrl;
    if (v.notes !== undefined) update.notes = v.notes;

    const { data, error } = await supabase
      .schema("resupply")
      .from("asset_recovery_cases")
      .update(update)
      .eq("id", idCheck.data)
      .select(SELECT_COLS)
      .maybeSingle();
    if (error) {
      res.status(500).json({ error: "update_failed", message: error.message });
      return;
    }
    if (!data) {
      res.status(404).json({ error: "case_not_found" });
      return;
    }
    const row = data as CaseRow;

    await logAudit({
      action: "asset_recovery.case.update",
      adminEmail: req.adminEmail ?? null,
      adminUserId: req.adminUserId ?? null,
      targetTable: "asset_recovery_cases",
      targetId: row.id,
      metadata: { status: row.status },
      ip: req.ip ?? null,
      userAgent: req.get("user-agent") ?? null,
    }).catch((err) => {
      logger.warn({ err }, "asset_recovery.case.update audit write failed");
    });

    res.json({ case: toDto(row) });
  },
);

export default router;
