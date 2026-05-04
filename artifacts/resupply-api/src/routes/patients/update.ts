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

import { and, eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { Router, type IRouter } from "express";
import { z } from "zod";

import { logAudit } from "@workspace/resupply-audit";
import { getDbPool, patients } from "@workspace/resupply-db";

import { logger } from "../../lib/logger";
import { requireAdmin } from "../../middlewares/requireAdmin";

const idParam = z.object({ id: z.string().uuid() });

// ISO-8601 timestamp matcher used to validate `expectedUpdatedAt`.
// We accept both "Z" and "+HH:MM" suffixes — the dashboard echoes
// the value the API itself returned, which is whatever Postgres
// rendered for `updated_at`.
const ISO_TIMESTAMP_RE =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})$/;

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
    cadenceOverrideDays: z.number().int().min(1).max(365).nullable().optional(),
    channelPreference: z.enum(["sms", "email", "voice"]).nullable().optional(),
    status: z.enum(["active", "paused", "closed"]).optional(),
    // Optional optimistic-concurrency precondition. When present,
    // the UPDATE is gated on `updated_at = $expected`; if the row
    // moved underneath us we return 409 `stale_patient` so the
    // dashboard can refetch and prompt the admin to re-confirm.
    // Validation is deliberately string-only (not z.string().datetime())
    // so we can echo the exact format Postgres uses without
    // round-tripping through a Date.
    expectedUpdatedAt: z
      .string()
      .regex(ISO_TIMESTAMP_RE, "must be an ISO-8601 timestamp")
      .optional(),
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
  // `expectedUpdatedAt` is a precondition, not a column — it never
  // lands in `updates`.
  const updates: Record<string, unknown> = {};
  if ("insurancePayer" in body)
    updates.insurancePayer = body.insurancePayer ?? null;
  if ("cadenceOverrideDays" in body)
    updates.cadenceOverrideDays = body.cadenceOverrideDays ?? null;
  if ("channelPreference" in body)
    updates.channelPreference = body.channelPreference ?? null;
  if ("status" in body && body.status) updates.status = body.status;

  const db = drizzle(getDbPool());

  if (Object.keys(updates).length === 0) {
    // Empty body is a no-op rather than an error so dashboards don't
    // have to special-case "user clicked save without changing
    // anything". We still need to return a current `updatedAt` so
    // the client's optimistic-concurrency token stays usable.
    const current = await db
      .select({ id: patients.id, updatedAt: patients.updatedAt })
      .from(patients)
      .where(eq(patients.id, id))
      .limit(1);
    if (current.length === 0) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    res.status(200).json({
      id,
      changed: [],
      updatedAt: current[0].updatedAt.toISOString(),
    });
    return;
  }

  // Truncate to millisecond precision: Postgres `timestamptz` is
  // microsecond, but `pg` parses it back into a JS `Date` (ms).
  // Without truncation, a precondition value of `…123Z` (read by
  // the dashboard) would never `=` a stored value of `…123456+00`,
  // and every concurrent PATCH would 409 spuriously.
  updates.updatedAt = sql`date_trunc('milliseconds', now())`;

  // If a precondition was supplied, gate the UPDATE on
  // `updated_at = $expected`. We `date_trunc('milliseconds', ...)`
  // the column too so legacy rows written before this guard (which
  // may carry microseconds) still match values the dashboard
  // round-trips at JS `Date` precision.
  const expectedUpdatedAt = body.expectedUpdatedAt;
  const whereClause = expectedUpdatedAt
    ? and(
        eq(patients.id, id),
        sql`date_trunc('milliseconds', ${patients.updatedAt}) = ${new Date(expectedUpdatedAt)}`,
      )
    : eq(patients.id, id);

  const result = await db
    .update(patients)
    .set(updates)
    .where(whereClause)
    .returning({ id: patients.id, updatedAt: patients.updatedAt });

  if (result.length === 0) {
    if (expectedUpdatedAt) {
      // The UPDATE matched nothing — either the patient was deleted
      // or its `updated_at` moved. Re-SELECT to disambiguate so the
      // dashboard knows whether to refetch (409) or navigate away
      // (404). Without this disambiguation we'd punish a stale write
      // with the same response as a missing row, and the admin
      // would think the patient vanished.
      const exists = await db
        .select({ id: patients.id })
        .from(patients)
        .where(eq(patients.id, id))
        .limit(1);
      if (exists.length > 0) {
        res.status(409).json({
          error: "stale_patient",
          message:
            "This patient was changed by someone else since you opened it. Please refresh and re-apply your edit.",
        });
        return;
      }
    }
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
      adminUserId: req.adminUserId ?? null,
      targetTable: "patients",
      targetId: id,
      ip: req.ip ?? null,
      userAgent: req.get("user-agent") ?? null,
      metadata: { columns: changedColumns },
    });
  } catch (err) {
    logger.error(
      {
        err:
          err instanceof Error ? { name: err.name, message: err.message } : err,
      },
      "patients.update: audit write failed",
    );
  }

  res.status(200).json({
    id,
    changed: changedColumns,
    updatedAt: result[0].updatedAt.toISOString(),
  });
});

export default router;
