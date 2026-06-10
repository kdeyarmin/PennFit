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
import { createQueueWithDlq, CRON_SCAN_QUEUE_OPTS } from "../lib/queue-options";

const PRUNE_JOB = "idempotency-keys.prune";
const PRUNE_CRON = "7 2 * * *";

export async function registerIdempotencyKeysPruneJob(
  boss: PgBoss,
): Promise<void> {
  await createQueueWithDlq(boss, PRUNE_JOB, CRON_SCAN_QUEUE_OPTS);

  await boss.work(PRUNE_JOB, async () => {
    const supabase = getSupabaseServiceRoleClient();
    try {
      // PostgREST RETURNING is page-size capped (~1000 rows by
      // default). The DB DELETE removes every matching row, but the
      // `.select()` we used to "count" returned only the first
      // page — so on busy days the log claimed `deleted: 1000` while
      // the actual deletion was correct, and on very-busy days the
      // implementation could vary. Use `count: "exact"` on the
      // DELETE itself so the response carries the true deleted-row
      // count without paging.
      const { count, error } = await supabase
        .schema("resupply")
        .from("idempotency_keys")
        .delete({ count: "exact" })
        .lte("expires_at", new Date().toISOString());
      if (error) throw error;

      // worker_dedup_keys carries the same TTL shape (migration 0160
      // even promised "a separate sweeper job prunes expired rows") but
      // no sweeper ever existed: date-scoped reminder keys accumulated
      // one row per patient/episode/channel/day forever, and the
      // claim-time fix in worker/lib/dedup-keys.ts only clears expired
      // rows for keys that are actively re-claimed. This DELETE is the
      // promised sweeper (app-review 2026-06-10, P1-2).
      const { count: dedupCount, error: dedupError } = await supabase
        .schema("resupply")
        .from("worker_dedup_keys")
        .delete({ count: "exact" })
        .lte("expires_at", new Date().toISOString());
      if (dedupError) throw dedupError;

      logger.info(
        { deleted: count ?? 0, dedupDeleted: dedupCount ?? 0 },
        "idempotency-keys.prune: completed",
      );
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
