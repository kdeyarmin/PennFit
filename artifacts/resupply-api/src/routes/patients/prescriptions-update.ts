// PATCH /prescriptions/:rxId — admin transitions a prescription's
// lifecycle status.
//
// Only `status` is mutable here, and the only legal transitions are:
//   active   -> expired
//   active   -> revoked
//   expired  -> active   (admin un-expires after a renewal)
//   revoked  -> active   (admin un-revokes — rare, but allowed)
//
// Why so restrictive:
//   The clinical fields (SKU, cadence, validity dates, prescriber)
//   are the doctor's order. Once recorded, they should not be
//   re-written by the admin console — instead, an updated
//   prescription should be created via POST and the prior one
//   marked `expired`. This keeps the audit history honest and
//   avoids "the prescription cadence silently changed mid-cycle"
//   debugging surprises.

import { Router, type IRouter } from "express";
import { z } from "zod";

import { logAudit } from "@workspace/resupply-audit";
import { getSupabaseServiceRoleClient } from "@workspace/resupply-db";

import { logger } from "../../lib/logger";
import { requireAdmin } from "../../middlewares/requireAdmin";

const idParam = z.object({ rxId: z.string().uuid() });

const bodySchema = z
  .object({
    status: z.enum(["active", "expired", "revoked"]),
  })
  .strict();

const router: IRouter = Router();

router.patch("/prescriptions/:rxId", requireAdmin, async (req, res) => {
  const idParsed = idParam.safeParse(req.params);
  if (!idParsed.success) {
    res.status(404).json({ error: "not_found" });
    return;
  }
  const bodyParsed = bodySchema.safeParse(req.body);
  if (!bodyParsed.success) {
    res.status(400).json({
      error: "invalid_body",
      issues: bodyParsed.error.issues.map((i) => ({
        path: i.path.join("."),
        message: i.message,
      })),
    });
    return;
  }

  const { rxId } = idParsed.data;
  const { status: nextStatus } = bodyParsed.data;

  const supabase = getSupabaseServiceRoleClient();

  const { data: rx } = await supabase
    .schema("resupply")
    .from("prescriptions")
    .select("id, patient_id, item_sku, status")
    .eq("id", rxId)
    .limit(1)
    .maybeSingle();
  if (!rx) {
    res.status(404).json({ error: "not_found" });
    return;
  }

  if (rx.status === nextStatus) {
    // No-op rather than 400 — dashboards may double-click. Mirrors
    // the "empty PATCH is a no-op" rule in patients/update.ts.
    res.status(200).json({ id: rx.id, status: rx.status, changed: false });
    return;
  }

  // Enforce documented lifecycle transitions (see module comment).
  // Any other combination (e.g. expired→revoked) is rejected so the
  // audit history remains meaningful.
  const VALID_TRANSITIONS: Record<string, string[]> = {
    active: ["expired", "revoked"],
    expired: ["active"],
    revoked: ["active"],
  };
  if (!VALID_TRANSITIONS[rx.status]?.includes(nextStatus)) {
    res.status(400).json({
      error: "invalid_transition",
      message: `Cannot transition prescription from "${rx.status}" to "${nextStatus}".`,
    });
    return;
  }

  const { error } = await supabase
    .schema("resupply")
    .from("prescriptions")
    .update({ status: nextStatus, updated_at: new Date().toISOString() })
    .eq("id", rxId);
  if (error) throw error;

  await logAudit({
    action: "patient.prescription.status_changed",
    adminEmail: req.adminEmail ?? null,
    adminUserId: req.adminUserId ?? null,
    targetTable: "prescriptions",
    targetId: rxId,
    metadata: {
      patient_id: rx.patient_id,
      item_sku: rx.item_sku,
      from_status: rx.status,
      to_status: nextStatus,
    },
    ip: req.ip ?? null,
    userAgent: req.get("user-agent") ?? null,
  }).catch((err) => {
    logger.warn({ err }, "patient.prescription.status_changed audit failed");
  });

  res.status(200).json({ id: rxId, status: nextStatus, changed: true });
});

export default router;
