// /admin/equipment-recalls — manufacturer recall registry + scan.
//
//   GET    /admin/equipment-recalls               — list active first
//   POST   /admin/equipment-recalls               — record a recall
//   PATCH  /admin/equipment-recalls/:id           — status (close) +
//                                                    metadata edits
//   GET    /admin/equipment-recalls/:id/scan      — fan out the match
//                                                    criteria across
//                                                    equipment_assets,
//                                                    return affected
//                                                    patients
//
// The /scan endpoint is read-only — it does NOT auto-transition any
// equipment_assets.status to 'recalled'. CSRs review the scan
// output and decide which patients to message; the per-asset
// PATCH on /patients/:id/equipment/:assetId then transitions status.
// We deliberately separate "see who's affected" from "mark the
// device recalled" so a CSR can confirm before the daily resupply
// rules start treating those devices as out-of-service.

import { Router, type IRouter } from "express";
import { z } from "zod";

import { logAudit } from "@workspace/resupply-audit";
import {
  type Database,
  getSupabaseServiceRoleClient,
} from "@workspace/resupply-db";

import { runRecallBulkMatch } from "../../lib/equipment/recall-bulk-match";
import { logger } from "../../lib/logger";
import {
  recallMatchesAsset,
  type RecallSerialMatch,
} from "../../lib/equipment/recall-match";
import { adminRateLimit } from "../../middlewares/admin-rate-limit";
import { requirePermission } from "../../middlewares/requireAdmin";

type EquipmentRecallUpdate =
  Database["resupply"]["Tables"]["equipment_recalls"]["Update"];

const router: IRouter = Router();

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const idParam = z.object({ id: z.string().uuid() });

/**
 * Escape PostgREST `ilike` wildcards (`%`, `_`) so an admin-supplied
 * manufacturer/model field can't fan the query out to every asset.
 * Backslash escapes for both wildcards mirror Postgres' standard
 * `ilike` semantics.
 */
function escapeIlikePattern(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/[%_]/g, (m) => `\\${m}`);
}

/**
 * z.string().url() accepts javascript:, data:, file:, vbscript: and
 * arbitrary custom protocols — all of which execute in the renderer's
 * origin when interpolated into <a href={...}>. Restrict to http(s)
 * so a recall's referenceUrl / evidenceUrl can't be weaponised as a
 * stored XSS that fires when other admins / patients click the link.
 */
function httpUrl() {
  return z
    .string()
    .trim()
    .url()
    .refine(
      (u) => /^https?:\/\//i.test(u),
      "URL must use http or https protocol",
    );
}

const SEVERITY_VALUES = ["urgent", "priority", "advisory"] as const;
const STATUS_VALUES = ["active", "closed"] as const;

const serialMatchSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("range"),
      from: z.string().trim().min(1).max(80),
      to: z.string().trim().min(1).max(80),
    })
    .strict(),
  z
    .object({
      kind: z.literal("list"),
      serials: z
        .array(z.string().trim().min(1).max(80))
        .min(1)
        .max(10_000),
    })
    .strict(),
]);

const createBody = z
  .object({
    recallReference: z.string().trim().min(1).max(64),
    title: z.string().trim().min(1).max(200),
    manufacturer: z.string().trim().min(1).max(80),
    modelMatch: z.string().trim().max(120).nullable().optional(),
    serialMatch: serialMatchSchema.nullable().optional(),
    severity: z.enum(SEVERITY_VALUES).optional().default("priority"),
    issuedAt: z
      .string()
      .regex(ISO_DATE, "must be YYYY-MM-DD")
      .nullable()
      .optional(),
    deadlineAt: z
      .string()
      .regex(ISO_DATE, "must be YYYY-MM-DD")
      .nullable()
      .optional(),
    referenceUrl: httpUrl().max(1000).nullable().optional(),
    description: z.string().trim().max(5000).nullable().optional(),
  })
  .strict();

const patchBody = z
  .object({
    status: z.enum(STATUS_VALUES).optional(),
    title: z.string().trim().min(1).max(200).optional(),
    description: z.string().trim().max(5000).nullable().optional(),
    deadlineAt: z
      .string()
      .regex(ISO_DATE, "must be YYYY-MM-DD")
      .nullable()
      .optional(),
    referenceUrl: httpUrl().max(1000).nullable().optional(),
  })
  .strict();

router.get(
  "/admin/equipment-recalls",
  requirePermission("returns.read"),
  async (_req, res) => {
  const supabase = getSupabaseServiceRoleClient();
  const { data, error } = await supabase
    .schema("resupply")
    .from("equipment_recalls")
    .select("*")
    // Active first, then severity (urgent > priority > advisory),
    // then newest issued first.
    .order("status", { ascending: true })
    .order("severity", { ascending: false })
    .order("issued_at", { ascending: false, nullsFirst: false });
  if (error) throw error;

  res.json({
    recalls: (data ?? []).map((r) => ({
      id: r.id,
      recallReference: r.recall_reference,
      title: r.title,
      manufacturer: r.manufacturer,
      modelMatch: r.model_match,
      serialMatch: r.serial_match as RecallSerialMatch,
      severity: r.severity,
      status: r.status,
      issuedAt: r.issued_at,
      deadlineAt: r.deadline_at,
      referenceUrl: r.reference_url,
      description: r.description,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    })),
  });
});

router.post(
  "/admin/equipment-recalls",
  requirePermission("returns.manage"),
  adminRateLimit({ name: "equipment_recalls.create", preset: "sensitive" }),
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

  const { data: row, error } = await supabase
    .schema("resupply")
    .from("equipment_recalls")
    .insert({
      recall_reference: b.recallReference,
      title: b.title,
      manufacturer: b.manufacturer,
      model_match: b.modelMatch ?? null,
      serial_match: (b.serialMatch ?? null) as Database["resupply"]["Tables"]["equipment_recalls"]["Insert"]["serial_match"],
      severity: b.severity,
      issued_at: b.issuedAt ?? null,
      deadline_at: b.deadlineAt ?? null,
      reference_url: b.referenceUrl ?? null,
      description: b.description ?? null,
    })
    .select("id")
    .single();
  if (error) {
    const code = (error as { code?: string }).code;
    if (code === "23505") {
      res.status(409).json({
        error: "recall_reference_taken",
        message:
          "A recall with this reference is already on file. Edit the existing one instead of re-creating it.",
      });
      return;
    }
    throw error;
  }

  await logAudit({
    action: "equipment_recall.create",
    adminEmail: req.adminEmail ?? null,
    adminUserId: req.adminUserId ?? null,
    targetTable: "equipment_recalls",
    targetId: row.id,
    metadata: {
      recall_reference: b.recallReference,
      manufacturer: b.manufacturer,
      severity: b.severity,
    },
    ip: req.ip ?? null,
    userAgent: req.get("user-agent") ?? null,
  }).catch((err) => {
    logger.warn({ err }, "equipment_recall.create audit write failed");
  });

  res.status(201).json({ id: row.id });
});

router.patch(
  "/admin/equipment-recalls/:id",
  requirePermission("returns.manage"),
  adminRateLimit({ name: "equipment_recalls.update", preset: "sensitive" }),
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

    const updates: EquipmentRecallUpdate = {};
    if (fields.status !== undefined) updates.status = fields.status;
    if (fields.title !== undefined) updates.title = fields.title;
    if (fields.description !== undefined)
      updates.description = fields.description;
    if (fields.deadlineAt !== undefined)
      updates.deadline_at = fields.deadlineAt;
    if (fields.referenceUrl !== undefined)
      updates.reference_url = fields.referenceUrl;

    const supabase = getSupabaseServiceRoleClient();
    const { data: updated, error } = await supabase
      .schema("resupply")
      .from("equipment_recalls")
      .update(updates)
      .eq("id", params.data.id)
      .select("id");
    if (error) throw error;
    if (!updated || updated.length === 0) {
      res.status(404).json({ error: "not_found" });
      return;
    }

    await logAudit({
      action: "equipment_recall.update",
      adminEmail: req.adminEmail ?? null,
      adminUserId: req.adminUserId ?? null,
      targetTable: "equipment_recalls",
      targetId: params.data.id,
      metadata: {
        updated_fields: Object.keys(fields),
      },
      ip: req.ip ?? null,
      userAgent: req.get("user-agent") ?? null,
    }).catch((err) => {
      logger.warn({ err }, "equipment_recall.update audit write failed");
    });

    res.status(200).json({ id: params.data.id, changed: true });
  },
);

/**
 * GET /admin/equipment-recalls/:id/scan
 *
 * Read-only — load candidate assets matching the recall's
 * (manufacturer, model?) tuple, then run each through the pure
 * recallMatchesAsset() helper to decide whether to include it.
 *
 * Returns the affected assets with patient_id + serial + model + status
 * so the CSR can paginate to outreach. Does NOT mutate
 * equipment_assets — see the route file's preamble for why.
 *
 * Audited per call with non-PHI metadata (recall id + affected count).
 */
router.get(
  "/admin/equipment-recalls/:id/scan",
  requirePermission("returns.read"),
  async (req, res) => {
    const params = idParam.safeParse(req.params);
    if (!params.success) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    const supabase = getSupabaseServiceRoleClient();
    const { data: recall, error: recallErr } = await supabase
      .schema("resupply")
      .from("equipment_recalls")
      .select("id, manufacturer, model_match, serial_match")
      .eq("id", params.data.id)
      .limit(1)
      .maybeSingle();
    if (recallErr) throw recallErr;
    if (!recall) {
      res.status(404).json({ error: "not_found" });
      return;
    }

    // Pull every active or recalled asset matching the (mfr, model?)
    // tuple. The index `equipment_assets_manufacturer_model_status_idx`
    // covers this query. We exclude 'returned' / 'retired' because
    // those devices are already out of service.
    let query = supabase
      .schema("resupply")
      .from("equipment_assets")
      .select(
        "id, patient_id, manufacturer, model, serial_number, status, dispensed_at",
      )
      // Escape `%` and `_` in admin-supplied recall fields so an admin
      // entering `%` doesn't sweep every asset into the recall set.
      // The JS-side `recallMatchesAsset` filter narrows further, but
      // the DB-side fan-out matters for the bulk-notify path.
      .ilike("manufacturer", escapeIlikePattern(recall.manufacturer))
      .in("status", ["active", "recalled"])
      .order("created_at", { ascending: true });
    if (recall.model_match) {
      query = query.ilike("model", escapeIlikePattern(recall.model_match));
    }
    const { data: candidates, error: cErr } = await query;
    if (cErr) throw cErr;

    const affected = (candidates ?? []).filter((asset) =>
      recallMatchesAsset({
        asset: {
          manufacturer: asset.manufacturer,
          model: asset.model,
          serialNumber: asset.serial_number,
        },
        recall: {
          manufacturer: recall.manufacturer,
          modelMatch: recall.model_match,
          serialMatch: recall.serial_match as RecallSerialMatch,
        },
      }),
    );

    await logAudit({
      action: "equipment_recall.scan",
      adminEmail: req.adminEmail ?? null,
      adminUserId: req.adminUserId ?? null,
      targetTable: "equipment_recalls",
      targetId: recall.id,
      metadata: {
        candidates_count: candidates?.length ?? 0,
        affected_count: affected.length,
        // Patient ids and serials are NOT included in audit
        // metadata — the audit log captures the FACT of a scan; the
        // bytes the CSR saw are the response payload, not the
        // audit row.
      },
      ip: req.ip ?? null,
      userAgent: req.get("user-agent") ?? null,
    }).catch((err) => {
      logger.warn({ err }, "equipment_recall.scan audit write failed");
    });

    res.json({
      recallId: recall.id,
      candidatesScanned: candidates?.length ?? 0,
      affectedCount: affected.length,
      affected: affected.map((a) => ({
        id: a.id,
        patientId: a.patient_id,
        manufacturer: a.manufacturer,
        model: a.model,
        serialNumber: a.serial_number,
        status: a.status,
        dispensedAt: a.dispensed_at,
      })),
    });
  },
);

// ────────────────────────────────────────────────────────────────
// POST /admin/equipment-recalls/:id/match-assets — run the bulk
// matcher: stamp every affected equipment_asset and upsert a
// recall_notifications row in 'queued' state. Idempotent — re-
// running returns alreadyQueuedCount rather than duplicating.
// ────────────────────────────────────────────────────────────────
router.post(
  "/admin/equipment-recalls/:id/match-assets",
  requirePermission("returns.manage"),
  adminRateLimit({ name: "equipment_recalls.match_assets", preset: "bulk" }),
  async (req, res) => {
    const idCheck = z.string().uuid().safeParse(req.params.id);
    if (!idCheck.success) {
      res.status(404).json({ error: "recall_not_found" });
      return;
    }
    const supabase = getSupabaseServiceRoleClient();
    let result;
    try {
      result = await runRecallBulkMatch(supabase, idCheck.data);
    } catch (err) {
      if (
        err instanceof Error &&
        /recall .* not found/.test(err.message)
      ) {
        res.status(404).json({ error: "recall_not_found" });
        return;
      }
      throw err;
    }

    await logAudit({
      action: "equipment_recall.match_assets",
      adminEmail: req.adminEmail ?? null,
      adminUserId: req.adminUserId ?? null,
      targetTable: "equipment_recalls",
      targetId: idCheck.data,
      metadata: {
        matchedCount: result.matchedCount,
        newlyQueuedCount: result.newlyQueuedCount,
        alreadyQueuedCount: result.alreadyQueuedCount,
      },
      ip: req.ip ?? null,
      userAgent: req.get("user-agent") ?? null,
    }).catch((err) => {
      logger.warn({ err }, "equipment_recall.match_assets audit failed");
    });

    res.json(result);
  },
);

// ────────────────────────────────────────────────────────────────
// GET /admin/equipment-recalls/:id/notifications — list the
// per-asset notification rows for a recall. Used by the SPA to
// render the "X queued, Y sent, Z failed" view.
// ────────────────────────────────────────────────────────────────
router.get(
  "/admin/equipment-recalls/:id/notifications",
  requirePermission("returns.read"),
  async (req, res) => {
    const idCheck = z.string().uuid().safeParse(req.params.id);
    if (!idCheck.success) {
      res.status(404).json({ error: "recall_not_found" });
      return;
    }
    const supabase = getSupabaseServiceRoleClient();
    const { data, error } = await supabase
      .schema("resupply")
      .from("recall_notifications")
      .select(
        "id, asset_id, patient_id, status, channel, notified_at, failed_at, failed_reason, created_at",
      )
      .eq("recall_id", idCheck.data)
      .order("created_at", { ascending: false })
      .limit(2000);
    if (error) throw error;

    // Group counts by status so the SPA can render a summary row
    // without doing the arithmetic itself.
    const counts = (data ?? []).reduce(
      (acc, r) => {
        acc[r.status] = (acc[r.status] ?? 0) + 1;
        return acc;
      },
      {} as Record<string, number>,
    );

    res.json({
      counts,
      notifications: (data ?? []).map((r) => ({
        id: r.id,
        assetId: r.asset_id,
        patientId: r.patient_id,
        status: r.status,
        channel: r.channel,
        notifiedAt: r.notified_at,
        failedAt: r.failed_at,
        failedReason: r.failed_reason,
        createdAt: r.created_at,
      })),
    });
  },
);

// ────────────────────────────────────────────────────────────────
// Remediation actions — per-asset record of what we DID once the
// recall notification reached the patient. Surveyors + FDA both
// ask for this.
// ────────────────────────────────────────────────────────────────
const REMEDIATION_ACTIONS = [
  "returned_to_manufacturer",
  "destroyed",
  "replaced",
  "patient_declined",
  "lost",
  "unreachable",
] as const;

const remediationBody = z
  .object({
    assetId: z.string().uuid(),
    action: z.enum(REMEDIATION_ACTIONS),
    evidenceUrl: httpUrl().max(2048).nullable().optional(),
    notes: z.string().trim().max(2000).nullable().optional(),
  })
  .strict();

router.post(
  "/admin/equipment-recalls/:id/remediation",
  requirePermission("returns.manage"),
  adminRateLimit({ name: "equipment_recalls.remediation", preset: "mutation" }),
  async (req, res) => {
    const idCheck = z.string().uuid().safeParse(req.params.id);
    if (!idCheck.success) {
      res.status(404).json({ error: "recall_not_found" });
      return;
    }
    const parsed = remediationBody.safeParse(req.body);
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
    // Destroyed actions require evidence — surveyors specifically
    // ask for the destruction certificate on Class I recalls.
    if (
      parsed.data.action === "destroyed" &&
      !parsed.data.evidenceUrl
    ) {
      res.status(400).json({
        error: "evidence_required",
        message:
          "evidenceUrl is required for action=destroyed (destruction certificate / photo).",
      });
      return;
    }

    const supabase = getSupabaseServiceRoleClient();
    // Confirm the recall + asset exist and the asset actually
    // belongs to this recall (preventing accidental log of an
    // action against an unrelated unit).
    const { data: notification, error: notErr } = await supabase
      .schema("resupply")
      .from("recall_notifications")
      .select("id")
      .eq("recall_id", idCheck.data)
      .eq("asset_id", parsed.data.assetId)
      .limit(1)
      .maybeSingle();
    if (notErr) throw notErr;
    if (!notification) {
      res.status(409).json({
        error: "asset_not_in_recall",
        message:
          "This asset isn't on the recall's notification roster. Run match-assets first.",
      });
      return;
    }

    // Upsert by (recall_id, asset_id) — the matcher idempotency
    // pattern, repeated. Re-logging a different action OVERWRITES
    // the prior one; we keep one final action per (recall, asset)
    // and the audit log records the history.
    const { data: row, error } = await supabase
      .schema("resupply")
      .from("recall_remediation_actions")
      .upsert(
        {
          recall_id: idCheck.data,
          asset_id: parsed.data.assetId,
          action: parsed.data.action,
          evidence_url: parsed.data.evidenceUrl ?? null,
          notes: parsed.data.notes ?? null,
          performed_by_user_id: req.adminUserId ?? null,
          performed_at: new Date().toISOString(),
        },
        { onConflict: "recall_id,asset_id" },
      )
      .select("id")
      .single();
    if (error) throw error;

    await logAudit({
      action: "equipment_recall.remediation.logged",
      adminEmail: req.adminEmail ?? null,
      adminUserId: req.adminUserId ?? null,
      targetTable: "recall_remediation_actions",
      targetId: row.id,
      metadata: {
        recall_id: idCheck.data,
        asset_id: parsed.data.assetId,
        action: parsed.data.action,
      },
      ip: req.ip ?? null,
      userAgent: req.get("user-agent") ?? null,
    }).catch((err) => {
      logger.warn(
        { err },
        "equipment_recall.remediation.logged audit failed",
      );
    });

    res.status(201).json({ id: row.id });
  },
);

router.get(
  "/admin/equipment-recalls/:id/remediation",
  requirePermission("returns.read"),
  async (req, res) => {
    const idCheck = z.string().uuid().safeParse(req.params.id);
    if (!idCheck.success) {
      res.status(404).json({ error: "recall_not_found" });
      return;
    }
    const supabase = getSupabaseServiceRoleClient();
    const { data, error } = await supabase
      .schema("resupply")
      .from("recall_remediation_actions")
      .select(
        "id, recall_id, asset_id, action, evidence_url, notes, performed_by_user_id, performed_at, created_at",
      )
      .eq("recall_id", idCheck.data)
      .order("performed_at", { ascending: false })
      .limit(2000);
    if (error) throw error;

    const counts = (data ?? []).reduce(
      (acc, r) => {
        acc[r.action] = (acc[r.action] ?? 0) + 1;
        return acc;
      },
      {} as Record<string, number>,
    );

    res.json({
      counts,
      actions: (data ?? []).map((r) => ({
        id: r.id,
        assetId: r.asset_id,
        action: r.action,
        evidenceUrl: r.evidence_url,
        notes: r.notes,
        performedByUserId: r.performed_by_user_id,
        performedAt: r.performed_at,
      })),
    });
  },
);

// GET /admin/equipment-recalls/:id/roster.csv — surveyor binder
// document. One row per affected asset, joining notification +
// remediation state so the FDA visit gets a single document.
router.get(
  "/admin/equipment-recalls/:id/roster.csv",
  requirePermission("returns.read"),
  async (req, res) => {
    const idCheck = z.string().uuid().safeParse(req.params.id);
    if (!idCheck.success) {
      res.status(404).json({ error: "recall_not_found" });
      return;
    }
    const supabase = getSupabaseServiceRoleClient();
    const { data: recall } = await supabase
      .schema("resupply")
      .from("equipment_recalls")
      .select("id, recall_reference, title")
      .eq("id", idCheck.data)
      .limit(1)
      .maybeSingle();
    if (!recall) {
      res.status(404).json({ error: "recall_not_found" });
      return;
    }
    const [notifs, remediations, assets] = await Promise.all([
      supabase
        .schema("resupply")
        .from("recall_notifications")
        .select(
          "asset_id, patient_id, status, channel, notified_at, failed_at, failed_reason",
        )
        .eq("recall_id", idCheck.data)
        .limit(5000),
      supabase
        .schema("resupply")
        .from("recall_remediation_actions")
        .select("asset_id, action, evidence_url, performed_at")
        .eq("recall_id", idCheck.data)
        .limit(5000),
      // Asset detail is over-fetched via the notification list's
      // ids; PostgREST doesn't do JOINs, so we follow with an .in().
      Promise.resolve(null),
    ]);
    if (notifs.error) throw notifs.error;
    if (remediations.error) throw remediations.error;
    const notifList = notifs.data ?? [];
    const remediationByAsset = new Map<
      string,
      { action: string; evidence_url: string | null; performed_at: string }
    >();
    for (const r of remediations.data ?? []) {
      if (!remediationByAsset.has(r.asset_id)) {
        remediationByAsset.set(r.asset_id, {
          action: r.action,
          evidence_url: r.evidence_url,
          performed_at: r.performed_at,
        });
      }
    }
    void assets;
    const assetIds = Array.from(new Set(notifList.map((n) => n.asset_id)));
    let assetMeta = new Map<
      string,
      { manufacturer: string; model: string; serial_number: string }
    >();
    if (assetIds.length > 0) {
      const { data: assetData } = await supabase
        .schema("resupply")
        .from("equipment_assets")
        .select("id, manufacturer, model, serial_number")
        .in("id", assetIds);
      assetMeta = new Map(
        (assetData ?? []).map((a) => [
          a.id,
          {
            manufacturer: a.manufacturer,
            model: a.model,
            serial_number: a.serial_number,
          },
        ]),
      );
    }

    const filename = `recall-${(recall.recall_reference ?? recall.id).replace(/[^A-Za-z0-9_-]/g, "_")}-roster.csv`;
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="${filename}"`,
    );
    res.write(
      [
        "asset_id",
        "patient_id",
        "manufacturer",
        "model",
        "serial_number",
        "notification_status",
        "notification_channel",
        "notified_at",
        "remediation_action",
        "remediation_evidence_url",
        "remediation_performed_at",
      ].join(",") + "\n",
    );
    for (const n of notifList) {
      const a = assetMeta.get(n.asset_id);
      const r = remediationByAsset.get(n.asset_id);
      res.write(
        [
          n.asset_id,
          n.patient_id,
          a?.manufacturer ?? "",
          a?.model ?? "",
          a?.serial_number ?? "",
          n.status,
          n.channel ?? "",
          n.notified_at ?? "",
          r?.action ?? "",
          r?.evidence_url ?? "",
          r?.performed_at ?? "",
        ]
          .map(rosterCsvCell)
          .join(",") + "\n",
      );
    }
    res.end();
  },
);

function rosterCsvCell(value: unknown): string {
  if (value == null) return "";
  const s = String(value);
  if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

export default router;
