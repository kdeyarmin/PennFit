// pg-boss job: daily prune of expired idempotency_keys rows.
//
// Why this exists:
//   The withIdempotency middleware stores replay records in the
//   idempotency_keys table with a 24-hour TTL. On replay, expired
//   rows are treated as misses and overwritten via ON CONFLICT DO UPDATE
//   — so the table is functionally correct without pruning. But without
//   a periodic DELETE, the table grows without bound on long-running
//   deployments: every write endpoint hit with an Idempotency-Key adds
//   a row, and expired rows are never removed.
//
// What this job does:
//   Deletes all rows where expires_at <= now() in a single DELETE
//   statement. The idempotency_keys_expires_at_idx index makes the
//   WHERE clause O(log n + deleted rows) regardless of table size.
//   The job runs daily at 02:07 UTC (off-peak, before the smart-trigger
//   evaluator at 03:23).
//
// Safety:
//   Only deletes rows past their TTL — active replay records are
//   never touched. The DELETE is non-transactional relative to the
//   middleware's ON CONFLICT DO UPDATE: in the vanishingly unlikely
//   event a prune and an overwrite race on the same key, the net
//   result is either a fresh row or a deleted-then-re-inserted row,
//   both correct outcomes.

import type PgBoss from "pg-boss";

import { getSupabaseServiceRoleClient } from "@workspace/resupply-db";

import { logger } from "../../lib/logger";

const PRUNE_JOB = "idempotency-keys.prune";
const PRUNE_CRON = "7 2 * * *";

export async function registerIdempotencyKeysPruneJob(
  boss: PgBoss,
): Promise<void> {
  await boss.createQueue(PRUNE_JOB);

  await boss.work(PRUNE_JOB, async () => {
    const supabase = getSupabaseServiceRoleClient();
    try {
      // PostgREST returns the deleted rows when we ask for `.select()`,
      // so we ask for just the composite-PK fields and count them.
      // Cheaper than a head=true count followed by a delete.
      const { data: deletedRows, error } = await supabase
        .schema("resupply")
        .from("idempotency_keys")
        .delete()
        .lte("expires_at", new Date().toISOString())
        .select("user_id");
      if (error) throw error;
      const deleted = (deletedRows ?? []).length;
      logger.info({ deleted }, "idempotency-keys.prune: completed");
    } catch (err) {
      logger.error(
        {
          err:
            err instanceof Error
              ? { name: err.name, message: err.message }
              : err,
        },
        "idempotency-keys.prune: failed",
      );
      throw err;
    }
  });

  await boss.schedule(PRUNE_JOB, PRUNE_CRON);
  logger.info({ cron: PRUNE_CRON }, "idempotency-keys.prune scheduled");
}
