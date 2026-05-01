// POST /patients/bulk-status — admin-driven multi-patient lifecycle change.
//
// Why a dedicated endpoint (not "loop PATCH /patients/:id N times" client-side):
//   * Admins routinely re-categorise dozens of patients after a payer
//     contract change ("close all patients on Plan X"). Issuing N
//     sequential PATCHes from the dashboard is slow, exhausts the
//     session token's per-second budget, and produces N audit
//     rows with no batch-summary to show "I changed 47 in one click".
//   * One server-side loop also keeps the audit trail honest: a
//     summary `patient.bulk_status_change` row records the admin's
//     intent (count + requested status) alongside the per-patient
//     `patient.update` rows, so a future auditor can reconstruct
//     "this was one bulk action" vs "these were 47 individual edits".
//
// Why no precondition (vs the single-patient PATCH's expectedUpdatedAt):
//   * Bulk actions are by design "I want all of these in this state",
//     so an admin override of any in-flight change is the desired
//     behaviour. Surfacing a 409-stale per row would force the admin
//     to refetch + retry the whole batch repeatedly with no clear
//     resolution path. The audit row records the admin who did it,
//     which is what we'd ask for if anyone later objected.
//
// Why max 100 ids per call:
//   * 100 patients × ~1ms per UPDATE in a single statement is
//     comfortably under the express body-parser timeout AND the
//     session refresh window. Larger batches need to be
//     chunked client-side.
//
// Errors:
//   * Per-row errors come back as `{id, error: "not_found"}`. We
//     don't currently surface other reasons (the only validated
//     constraint is "id must exist") but the response shape is
//     forward-compatible with adding `"forbidden"` etc.
//
// PHI handling:
//   * The `ids` array contains opaque uuids. The audit summary row
//     records `requestedStatus`, `count`, `updatedCount`,
//     `failedCount` — no PHI.

import { inArray, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { Router, type IRouter } from "express";
import { z } from "zod";

import { logAudit } from "@workspace/resupply-audit";
import { getDbPool, patients } from "@workspace/resupply-db";

import { logger } from "../../lib/logger";
import { withIdempotency } from "../../middlewares/idempotency";
import { requireAdmin } from "../../middlewares/requireAdmin";

const MAX_BATCH = 100;

const bodySchema = z
  .object({
    ids: z
      .array(z.string().uuid())
      .min(1, "At least one patient id is required.")
      .max(MAX_BATCH, `At most ${MAX_BATCH} patient ids per call.`),
    status: z.enum(["active", "paused", "closed"]),
  })
  .strict();

interface UpdatedItem {
  id: string;
  status: string;
  updatedAt: string;
}

interface FailedItem {
  id: string;
  error: "not_found";
}

const router: IRouter = Router();

router.post(
  "/patients/bulk-status",
  requireAdmin,
  withIdempotency("POST /patients/bulk-status"),
  async (req, res) => {
    const parsed = bodySchema.safeParse(req.body);
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

    // Dedupe ids client-side bugs sometimes send the same id twice
    // (e.g. checkbox toggle bug). We treat the dedupe as silent —
    // the admin meant "set this id to status X" and we did, once.
    const ids = Array.from(new Set(parsed.data.ids));
    const { status } = parsed.data;

    const db = drizzle(getDbPool());

    // Single UPDATE with id = ANY($::uuid[]) is the correct shape:
    // the database does the row-by-row work atomically and we get
    // back the rows that actually matched. Anything missing from
    // the returning set is a "not_found" failure.
    const updated = await db
      .update(patients)
      // Truncate to ms precision so subsequent PATCH calls (which
      // gate on `updated_at = $expected` from the JS-Date round-trip)
      // can match. See update.ts for the rationale.
      .set({ status, updatedAt: sql`date_trunc('milliseconds', now())` })
      .where(inArray(patients.id, ids))
      .returning({ id: patients.id, updatedAt: patients.updatedAt });

    const updatedIds = new Set(updated.map((r) => r.id));
    const updatedItems: UpdatedItem[] = updated.map((r) => ({
      id: r.id,
      status,
      updatedAt: r.updatedAt.toISOString(),
    }));
    const failedItems: FailedItem[] = ids
      .filter((id) => !updatedIds.has(id))
      .map((id) => ({ id, error: "not_found" as const }));

    // Per-row audit: one `patient.update` per successful update so
    // the per-patient timeline shows the change with the right
    // actor. The summary row records the bulk intent.
    for (const row of updatedItems) {
      try {
        await logAudit({
          action: "patient.update",
          adminEmail: req.adminEmail ?? null,
          adminUserId: req.adminUserId ?? null,
          targetTable: "patients",
          targetId: row.id,
          ip: req.ip ?? null,
          userAgent: req.get("user-agent") ?? null,
          metadata: { columns: ["status"], via: "bulk_status_change" },
        });
      } catch (err) {
        logger.warn(
          { err: err instanceof Error ? { name: err.name, message: err.message } : err, patient_id: row.id },
          "patients/bulk-status: per-row audit write failed",
        );
      }
    }

    try {
      await logAudit({
        action: "patient.bulk_status_change",
        adminEmail: req.adminEmail ?? null,
        adminUserId: req.adminUserId ?? null,
        targetTable: "patients",
        targetId: null,
        ip: req.ip ?? null,
        userAgent: req.get("user-agent") ?? null,
        metadata: {
          requested_status: status,
          requested_count: ids.length,
          updated_count: updatedItems.length,
          failed_count: failedItems.length,
        },
      });
    } catch (err) {
      logger.warn(
        { err: err instanceof Error ? { name: err.name, message: err.message } : err },
        "patients/bulk-status: summary audit write failed",
      );
    }

    res.status(200).json({
      updated: updatedItems,
      failed: failedItems,
    });
  },
);

export default router;
