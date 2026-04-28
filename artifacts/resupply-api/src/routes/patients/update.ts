// PATCH /patients/:id — admin-editable settings.
//
// Updates these admin-managed fields:
//   - insurance_payer        (free text, ≤ 120 chars)
//   - cadence_override_days  (positive integer, or null to clear)
//   - channel_preference     (sms | email | voice, or null to clear)
//   - status                 (active | paused | closed) — drives the
//                            eligibility scan suppression. `paused`
//                            removes the patient from outreach until
//                            an admin transitions back to `active`.
//                            `closed` is the lifecycle-terminal value
//                            (moved off program / declined / deceased).
//
// All non-status fields accept `null` to explicitly clear an override;
// `status` does not — there is no "no status" state. A missing key in
// the request body leaves the column unchanged. We model "leave alone"
// with `.optional()` and "set to NULL" with `.nullable()` — the
// standard PATCH-with-nullable-clears idiom matches what the
// dashboard's "reset to default" button needs.
//
// PHI handling: none of these columns hold PHI. The audit log entry
// records *which* columns changed but never the new values — admin
// edits are auditable as activity, but the values themselves are
// dashboard-visible and don't need to be re-keyed into the audit log.

import { eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { Router, type IRouter } from "express";
import { z } from "zod";

import { logAudit } from "@workspace/resupply-audit";
import { getDbPool, patients } from "@workspace/resupply-db";

import { logger } from "../../lib/logger";
import { requireAdmin } from "../../middlewares/requireAdmin";

const idParam = z.object({ id: z.string().uuid() });

// Body schema. `.strict()` so unknown keys fail loudly during
// dashboard development — easier to catch typos than to silently
// accept and ignore them.
const bodySchema = z
  .object({
    insurancePayer: z
      .string()
      .trim()
      .max(120)
      .nullable()
      .optional()
      .transform((v) => (v === "" ? null : v)),
    cadenceOverrideDays: z
      .number()
      .int()
      .min(1)
      .max(365)
      .nullable()
      .optional(),
    channelPreference: z
      .enum(["sms", "email", "voice"])
      .nullable()
      .optional(),
    status: z.enum(["active", "paused", "closed"]).optional(),
  })
  .strict();

const router: IRouter = Router();

router.patch("/patients/:id", requireAdmin, async (req, res) => {
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

  const { id } = idParsed.data;
  const body = bodyParsed.data;

  // Build the set of columns to update. Only keys actually present
  // in the body are touched; absent keys leave the column alone.
  const updates: Record<string, unknown> = {};
  if ("insurancePayer" in body) updates.insurancePayer = body.insurancePayer ?? null;
  if ("cadenceOverrideDays" in body)
    updates.cadenceOverrideDays = body.cadenceOverrideDays ?? null;
  if ("channelPreference" in body)
    updates.channelPreference = body.channelPreference ?? null;
  if ("status" in body && body.status) updates.status = body.status;

  if (Object.keys(updates).length === 0) {
    // Empty body is a no-op rather than an error so dashboards don't
    // have to special-case "user clicked save without changing
    // anything".
    res.status(200).json({ id, changed: [] });
    return;
  }

  updates.updatedAt = sql`now()`;

  const db = drizzle(getDbPool());

  const result = await db
    .update(patients)
    .set(updates)
    .where(eq(patients.id, id))
    .returning({ id: patients.id });

  if (result.length === 0) {
    res.status(404).json({ error: "not_found" });
    return;
  }

  // Audit: record which columns changed; do NOT record the new values
  // (they round-trip in the dashboard already; logging values would
  // duplicate state into the audit log unnecessarily).
  const changedColumns = Object.keys(updates).filter((k) => k !== "updatedAt");
  try {
    await logAudit({
      action: "patient.update",
      adminEmail: req.adminEmail ?? null,
      adminClerkId: req.adminClerkId ?? null,
      targetTable: "patients",
      targetId: id,
      ip: req.ip ?? null,
      userAgent: req.get("user-agent") ?? null,
      metadata: { columns: changedColumns },
    });
  } catch (err) {
    logger.error(
      { err: err instanceof Error ? { name: err.name, message: err.message } : err },
      "patients.update: audit write failed",
    );
  }

  res.status(200).json({ id, changed: changedColumns });
});

export default router;
