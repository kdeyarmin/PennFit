// pg-boss job: scheduled eligibility re-verification (Biller #31).
//
// Walks active insurance coverages, ranks them by re-verification
// urgency, and fires a fresh 270 for the most urgent (throttled per
// coverage, capped per run) through the existing `verifyEligibility`
// round-trip. See `lib/billing/eligibility-batch.ts` for the selection
// + run core.
//
// SAFETY — this is the one job that emits OUTBOUND clearinghouse traffic
// on a schedule, so the cron is OPT-IN. The queue + worker always
// register (so the admin "run now" trigger and manual enqueues work),
// but the recurring schedule only attaches when ELIGIBILITY_REVERIFY_CRON
// is set to a 5-field cron expression. Dev / preview / a fresh prod never
// auto-send 270s until an operator deliberately turns it on.

import type PgBoss from "pg-boss";

import { logAudit } from "@workspace/resupply-audit";

import { runEligibilityReverificationBatch } from "../../lib/billing/eligibility-batch.js";
import { isFeatureEnabled } from "../../lib/feature-flags.js";
import { logger } from "../../lib/logger.js";
import {
  createQueueWithDlq,
  VENDOR_SEND_QUEUE_OPTS,
} from "../lib/queue-options.js";

export const ELIGIBILITY_REVERIFY_BATCH_JOB = "eligibility.reverify-batch";

const SYSTEM_ACTOR_EMAIL = "system:worker:eligibility-reverify";

export async function registerEligibilityReverifyBatchJob(
  boss: PgBoss,
): Promise<void> {
  await createQueueWithDlq(
    boss,
    ELIGIBILITY_REVERIFY_BATCH_JOB,
    VENDOR_SEND_QUEUE_OPTS,
  );
  await boss.work(ELIGIBILITY_REVERIFY_BATCH_JOB, async () => {
    // Runtime kill switch (admin Control Center). The env cron controls
    // scheduling; this flag pauses the unattended 270s without a deploy.
    // The operator "Run batch now" route calls the run core directly and
    // is intentionally not gated here.
    if (!(await isFeatureEnabled("eligibility.auto_reverify"))) {
      logger.info(
        { queue: ELIGIBILITY_REVERIFY_BATCH_JOB },
        "eligibility reverify-batch: feature flag off — skipping",
      );
      return;
    }
    const result = await runEligibilityReverificationBatch();
    await logAudit({
      action: "billing.eligibility.reverify_batch.completed",
      adminEmail: SYSTEM_ACTOR_EMAIL,
      adminUserId: null,
      targetTable: null,
      targetId: null,
      metadata: { ...result, trigger: "cron" },
      ip: null,
      userAgent: null,
    }).catch((err) => {
      logger.warn({ err }, "reverify-batch completion audit failed");
    });
  });

  const cron = process.env.ELIGIBILITY_REVERIFY_CRON?.trim();
  if (cron) {
    await boss.schedule(ELIGIBILITY_REVERIFY_BATCH_JOB, cron);
    logger.info(
      { queue: ELIGIBILITY_REVERIFY_BATCH_JOB, cron },
      "eligibility reverify-batch scheduled",
    );
  } else {
    // boss.schedule() persists the cron in pg-boss; merely not
    // re-scheduling does NOT stop a previously-attached schedule.
    // Clear any stale row so removing the env var actually turns
    // the cron off (same pattern as worker/lib/table-guard.ts).
    await boss
      .unschedule(ELIGIBILITY_REVERIFY_BATCH_JOB)
      .catch(() => undefined);
    logger.info(
      { queue: ELIGIBILITY_REVERIFY_BATCH_JOB },
      "eligibility reverify-batch registered (cron opt-in unset; manual-trigger only)",
    );
  }
}
