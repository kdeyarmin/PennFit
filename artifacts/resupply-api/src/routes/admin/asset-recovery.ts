// /admin/asset-recovery — worklist of CPAP-machine recovery cases for
// patients who have discontinued therapy, so the device can be
// refurbished and redeployed.
//
//   GET   /admin/asset-recovery            — list cases (optional ?status=)
//   POST  /admin/asset-recovery            — open a new recovery case
//   PATCH /admin/asset-recovery/:id        — advance status / edit fields
//   POST  /admin/asset-recovery/:id/label  — mint a return shipping label
//
// CareMetric Breathe DETECTS likely discontinuation (low-usage smart triggers +
// lapsed-customer win-back); the nightly `asset-recovery.auto-populate`
// worker opens cases from those signals (flag-gated). This route is the
// human worklist that moves a device from "identified" to "received" /
// "redeployed", and (when a carrier vendor is configured) mints the
// return label.
//
// Gating: `cases.read` for the list, `cases.manage` for mutations.
// Tenancy: org-scoped via getOrgScopedClient(req.orgId) — every read is
// filtered to the caller's org and every insert is tagged with it.
//
// PHI / log posture: patient_label / notes may carry PHI and are stored
// as plaintext. The audit row records the case id + status only — never
// the patient label, notes, serial, or tracking number.

import { Router, type IRouter } from "express";
import { z } from "zod";

import { logAudit } from "@workspace/resupply-audit";
import { getOrgScopedClient } from "@workspace/resupply-db";

import { selectAdapter } from "../../lib/carrier-labels";
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

// Statuses from which a return label may still be minted (the device
// hasn't shipped yet). Past these the label already exists or the case
// is closed.
const LABELABLE_STATUSES = new Set<string>(["identified", "outreach"]);

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
    // Fail closed: never widen to all tenants on a missing orgId.
    const orgId = req.orgId;
    if (!orgId) {
      res.status(500).json({ error: "tenant_context_missing" });
      return;
    }
    const { status, limit } = parsed.data;
    const db = getOrgScopedClient(orgId);

    let q = db
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
    const { data: openRows, error: countErr } = await db
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
      cases: (data ?? []).map((r: CaseRow) => toDto(r)),
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
    const orgId = req.orgId;
    if (!orgId) {
      res.status(500).json({ error: "tenant_context_missing" });
      return;
    }
    const v = parsed.data;
    const db = getOrgScopedClient(orgId);

    // org_id is injected by the org-scoped client.
    const { data, error } = await db
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
    const orgId = req.orgId;
    if (!orgId) {
      res.status(500).json({ error: "tenant_context_missing" });
      return;
    }
    const v = parsed.data;
    const db = getOrgScopedClient(orgId);

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

    const { data, error } = await db
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

// Mint a return shipping label for a case via the carrier-label adapter.
// Degrades to 503 `vendor_not_configured` until CARRIER_LABEL_VENDOR is
// wired (same posture as /admin/shop/returns/:id/label). On success the
// case advances to `label_sent` with the tracking number; the label
// bytes are returned inline for the operator to print. (Persisting the
// label to object storage + populating return_label_url is a follow-up.)
router.post(
  "/admin/asset-recovery/:id/label",
  requirePermission("cases.manage"),
  adminRateLimit({ name: "asset_recovery.label", preset: "mutation" }),
  async (req, res) => {
    const idCheck = idParam.safeParse(req.params.id);
    if (!idCheck.success) {
      res.status(400).json({ error: "invalid_id" });
      return;
    }
    const orgId = req.orgId;
    if (!orgId) {
      res.status(500).json({ error: "tenant_context_missing" });
      return;
    }
    const db = getOrgScopedClient(orgId);

    const { data: existing, error: fetchErr } = await db
      .from("asset_recovery_cases")
      .select(SELECT_COLS)
      .eq("id", idCheck.data)
      .maybeSingle();
    if (fetchErr) {
      res
        .status(500)
        .json({ error: "query_failed", message: fetchErr.message });
      return;
    }
    if (!existing) {
      res.status(404).json({ error: "case_not_found" });
      return;
    }
    const current = existing as CaseRow;
    if (!LABELABLE_STATUSES.has(current.status)) {
      res.status(409).json({
        error: "wrong_state",
        message: `A label can only be minted while the case is 'identified' or 'outreach' (current: ${current.status}).`,
      });
      return;
    }

    // Address resolution + real carrier integration land with the
    // vendor wiring; the adapter is a null adapter today (503), so the
    // placeholder addresses are never transmitted. Mirrors the existing
    // /admin/shop/returns/:id/label posture.
    const adapter = selectAdapter();
    const result = await adapter.createLabel({
      kind: "return",
      to: {
        name: "PennPaps Returns",
        line1: "—",
        city: "—",
        state: "—",
        postalCode: "—",
        country: "US",
      },
      from: {
        name: current.patient_label ?? "Patient",
        line1: "—",
        city: "—",
        state: "—",
        postalCode: "—",
        country: "US",
      },
      weightOz: 16,
    });
    if (!result.ok) {
      const status = result.error === "vendor_not_configured" ? 503 : 502;
      res.status(status).json({ error: result.error, message: result.message });
      return;
    }

    const { data: updated, error: updateErr } = await db
      .from("asset_recovery_cases")
      .update({
        status: "label_sent",
        tracking_number: result.trackingNumber,
        updated_at: new Date().toISOString(),
        updated_by_email: req.adminEmail ?? null,
      })
      .eq("id", idCheck.data)
      .select(SELECT_COLS)
      .maybeSingle();
    if (updateErr || !updated) {
      res.status(500).json({
        error: "update_failed",
        message: updateErr?.message ?? "unknown",
      });
      return;
    }
    const row = updated as CaseRow;

    await logAudit({
      action: "asset_recovery.label.created",
      adminEmail: req.adminEmail ?? null,
      adminUserId: req.adminUserId ?? null,
      targetTable: "asset_recovery_cases",
      targetId: row.id,
      // Carrier name only — never the tracking number or any PHI.
      metadata: { carrier: result.carrier, status: row.status },
      ip: req.ip ?? null,
      userAgent: req.get("user-agent") ?? null,
    }).catch((err) => {
      logger.warn({ err }, "asset_recovery.label.created audit write failed");
    });

    res.json({
      case: toDto(row),
      carrier: result.carrier,
      trackingNumber: result.trackingNumber,
      labelMime: result.labelMime,
      labelBase64: result.labelBase64,
      shippingCostCents: result.shippingCostCents,
    });
  },
);

export default router;
