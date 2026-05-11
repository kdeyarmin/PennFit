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

import { logger } from "../../lib/logger";
import {
  recallMatchesAsset,
  type RecallSerialMatch,
} from "../../lib/equipment/recall-match";
import { requireAdmin } from "../../middlewares/requireAdmin";

type EquipmentRecallUpdate =
  Database["resupply"]["Tables"]["equipment_recalls"]["Update"];

const router: IRouter = Router();

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const idParam = z.object({ id: z.string().uuid() });

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
    referenceUrl: z.string().trim().url().max(1000).nullable().optional(),
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
    referenceUrl: z.string().trim().url().max(1000).nullable().optional(),
  })
  .strict();

router.get("/admin/equipment-recalls", requireAdmin, async (_req, res) => {
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

router.post("/admin/equipment-recalls", requireAdmin, async (req, res) => {
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
  requireAdmin,
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
      .ilike("manufacturer", recall.manufacturer)
      .in("status", ["active", "recalled"])
      .order("created_at", { ascending: true });
    if (recall.model_match) {
      query = query.ilike("model", recall.model_match);
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

export default router;
