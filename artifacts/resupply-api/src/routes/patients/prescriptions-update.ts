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

import { eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { Router, type IRouter } from "express";
import { z } from "zod";

import { logAudit } from "@workspace/resupply-audit";
import { getDbPool, prescriptions } from "@workspace/resupply-db";

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

  const db = drizzle(getDbPool());

  const existing = await db
    .select({
      id: prescriptions.id,
      patientId: prescriptions.patientId,
      itemSku: prescriptions.itemSku,
      status: prescriptions.status,
    })
    .from(prescriptions)
    .where(eq(prescriptions.id, rxId))
    .limit(1);
  const rx = existing[0];
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

  await db
    .update(prescriptions)
    .set({ status: nextStatus, updatedAt: sql`now()` })
    .where(eq(prescriptions.id, rxId));

  await logAudit({
    action: "patient.prescription.status_changed",
    adminEmail: req.adminEmail ?? null,
    adminClerkId: req.adminClerkId ?? null,
    targetTable: "prescriptions",
    targetId: rxId,
    metadata: {
      patient_id: rx.patientId,
      item_sku: rx.itemSku,
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
