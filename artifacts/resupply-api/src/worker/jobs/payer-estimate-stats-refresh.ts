// pg-boss job: weekly refresh of the learned per-payer OOP estimate
// stats (owner #O2).
//
// Recomputes P50/P90 patient out-of-pocket per storefront payer slug
// from the last 365 days of adjudicated claims and replaces the small
// payer_estimate_stats table the public /shop/insurance-estimates route
// reads. All the logic lives in lib/insurance-estimates/refresh-stats;
// this file only wires the cron.
//
// Not env-gated: it's a read-only computation that writes an 11-row
// aggregate table (no PHI, no patient contact), so it's safe to run
// unconditionally. Registered via registerIfProvisioned so it stays
// inert until the 0224 table exists (forward-deploy safe).

import type PgBoss from "pg-boss";

import { logger } from "../../lib/logger";
import { refreshPayerEstimateStats } from "../../lib/insurance-estimates/refresh-stats";
import { createQueueWithDlq, CRON_SCAN_QUEUE_OPTS } from "../lib/queue-options";

export const PAYER_STATS_JOB = "insurance-estimate.stats-refresh";

/** Weekly, Monday 06:37 UTC — off the busy top-of-hour cron slots. */
export const PAYER_STATS_CRON = "37 6 * * 1";

export async function registerPayerEstimateStatsJob(
  boss: PgBoss,
): Promise<void> {
  await createQueueWithDlq(boss, PAYER_STATS_JOB, CRON_SCAN_QUEUE_OPTS);
  await boss.work(PAYER_STATS_JOB, async () => {
    try {
      const stats = await refreshPayerEstimateStats();
      logger.info(
        { event: "insurance-estimate.stats-refresh.completed", ...stats },
        "insurance-estimate.stats-refresh: completed",
      );
    } catch (err) {
      logger.error(
        {
          err:
            err instanceof Error
              ? { name: err.name, message: err.message }
              : err,
        },
        "insurance-estimate.stats-refresh: failed",
      );
      throw err;
    }
  });
  await boss.schedule(PAYER_STATS_JOB, PAYER_STATS_CRON);
  logger.info(
    { cron: PAYER_STATS_CRON },
    "insurance-estimate.stats-refresh scheduled",
  );
}
