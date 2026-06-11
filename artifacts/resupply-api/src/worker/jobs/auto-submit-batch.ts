// pg-boss job: scheduled automatic claim submission to Office Ally.
//
// Selects draft claims that pass preflight with zero blocking errors AND
// have active, recent eligibility on file, batches them per payer, and
// transmits them through the same executeOfficeAllyBatchSubmit core the
// manual route uses. See lib/billing/auto-submit-engine.ts for the gate.
//
// SAFETY — two independent off switches, both required to transmit:
//
//   1. OPT-IN CRON. The queue + worker always register (so the operator
//      "approve & submit" route works), but the recurring schedule only
//      attaches when CLAIMS_AUTOSUBMIT_CRON is set. Dev / preview / a
//      fresh prod never auto-send claims.
//
//   2. RUNTIME FEATURE FLAG. Even with the cron scheduled, this job
//      checks billing.auto_submit_claims (seeded DISABLED, migration
//      0215) on every tick and no-ops when it's off. That gives ops a
//      one-click kill switch in the admin Control Center that takes
//      effect without a deploy. The operator-driven staged-approval
//      submit ignores the flag (an explicit, attended action).

import type PgBoss from "pg-boss";

import { logAudit } from "@workspace/resupply-audit";

import {
  runAutoSubmitBatch,
  type AutoSubmitRunResult,
} from "../../lib/billing/auto-submit-engine.js";
import { isFeatureEnabled } from "../../lib/feature-flags.js";
import { logger } from "../../lib/logger.js";
import {
  createQueueWithDlq,
  VENDOR_SEND_QUEUE_OPTS,
} from "../lib/queue-options.js";

export const AUTO_SUBMIT_BATCH_JOB = "billing.auto-submit-batch";

const SYSTEM_ACTOR_EMAIL = "system:worker:auto-submit";

function summarize(result: AutoSubmitRunResult): Record<string, number> {
  return {
    batchesAttempted: result.batchesAttempted,
    claimsSubmitted: result.claimsSubmitted,
    failures: result.failures.length,
    skippedNotReady: result.skippedNotReady.length,
    readyClaimCount: result.readyClaimCount,
  };
}

export async function registerAutoSubmitBatchJob(boss: PgBoss): Promise<void> {
  await createQueueWithDlq(boss, AUTO_SUBMIT_BATCH_JOB, VENDOR_SEND_QUEUE_OPTS);
  await boss.work(AUTO_SUBMIT_BATCH_JOB, async () => {
    const enabled = await isFeatureEnabled("billing.auto_submit_claims");
    if (!enabled) {
      logger.info(
        { queue: AUTO_SUBMIT_BATCH_JOB },
        "auto-submit-batch: feature flag off — nothing transmitted",
      );
      return;
    }
    const result = await runAutoSubmitBatch({
      submittedByEmail: SYSTEM_ACTOR_EMAIL,
      submittedByUserId: null,
      triggeredBy: "cron",
    });
    if (result.batchesAttempted > 0 || result.failures.length > 0) {
      logger.info(
        { event: "billing.auto-submit-batch.completed", ...summarize(result) },
        "billing.auto-submit-batch: tick",
      );
      await logAudit({
        action: "billing.auto_submit.run",
        adminEmail: SYSTEM_ACTOR_EMAIL,
        adminUserId: null,
        targetTable: "office_ally_submissions",
        targetId: null,
        metadata: { trigger: "cron", ...summarize(result) },
        ip: null,
        userAgent: null,
      }).catch((err) => {
        logger.warn({ err }, "auto-submit-batch completion audit failed");
      });
    }
  });

  const cron = process.env.CLAIMS_AUTOSUBMIT_CRON?.trim();
  if (cron) {
    await boss.schedule(AUTO_SUBMIT_BATCH_JOB, cron);
    logger.info(
      { queue: AUTO_SUBMIT_BATCH_JOB, cron },
      "auto-submit-batch scheduled",
    );
  } else {
    // boss.schedule() persists the cron in pg-boss; merely not
    // re-scheduling does NOT stop a previously-attached schedule.
    // Clear any stale row so removing the env var actually turns
    // the cron off (same pattern as worker/lib/table-guard.ts).
    // typeof-guarded like worker/lib/table-guard.ts — test
    // doubles (and old pg-boss) may not implement unschedule.
    if (typeof boss.unschedule === "function") {
      await boss.unschedule(AUTO_SUBMIT_BATCH_JOB).catch(() => undefined);
    }
    logger.info(
      { queue: AUTO_SUBMIT_BATCH_JOB },
      "auto-submit-batch registered (cron opt-in unset; manual-trigger only)",
    );
  }
}
