// pg-boss job: hourly post-purchase review-request sweep.
//
// Why this exists
// ---------------
// Before this job, POST /admin/shop/review-requests/send-due was the ONLY
// way to send the 14-day post-purchase review-request email — an admin had
// to click the dispatcher. In practice the window passed before anyone
// triggered it. The dispatcher's atomic review_request_sent_at claim already
// enforces one-send-per-order, so running the same code hourly is safe and
// just removes the human latency. Mirrors cart-abandonment.scan exactly.
//
// Feature flag / env gate
// -----------------------
// Off by default. Set RESUPPLY_REVIEW_REQUEST_CRON_ENABLED=1 to register the
// cron (so a staging deploy with a real SendGrid key doesn't start emailing
// real customers the moment this lands). The per-tenant
// storefront.reviews_collection flag is resolved inside the dispatcher, so a
// tenant with reviews off is swept but does no work.
//
// Idempotency / parallelism
// -------------------------
// The dispatcher's NULL-guarded review_request_sent_at stamp makes the cron
// safe to run concurrently with the admin button: both SELECT-then-UPDATE,
// Postgres serialises the UPDATEs, the loser matches zero rows.

import type PgBoss from "pg-boss";

import { logger } from "../../lib/logger";
import { runReviewRequestDispatch } from "../../lib/review-requests/run-dispatch";
import { forEachActiveOrg } from "../lib/for-each-active-org.js";
import { createQueueWithDlq, CRON_SCAN_QUEUE_OPTS } from "../lib/queue-options";

export const REVIEW_REQUEST_JOB = "review-request.scan";

export interface ReviewRequestScanSummary {
  tenants: number;
  succeeded: number;
  failedOrgIds: string[];
  scanned: number;
  sent: number;
  skippedNoConfig: number;
  skippedFailed: number;
  skippedOptOut: number;
}

/**
 * Run the review-request dispatcher once for EVERY active tenant, isolating
 * per-tenant failures, and return the aggregate summary. Single-tenant:
 * listActiveOrgIds() returns just the seed org, so this is the prior sweep.
 */
export async function runReviewRequestScanAllOrgs(): Promise<ReviewRequestScanSummary> {
  const agg = {
    scanned: 0,
    sent: 0,
    skippedNoConfig: 0,
    skippedFailed: 0,
    skippedOptOut: 0,
  };
  const fan = await forEachActiveOrg(
    async (orgId) => {
      const stats = await runReviewRequestDispatch({ orgId, log: logger });
      agg.scanned += stats.scanned;
      agg.sent += stats.sent;
      agg.skippedNoConfig += stats.skippedNoConfig;
      agg.skippedFailed += stats.skippedFailed;
      agg.skippedOptOut += stats.skippedOptOut;
    },
    { jobName: REVIEW_REQUEST_JOB },
  );
  return {
    tenants: fan.total,
    succeeded: fan.succeeded,
    failedOrgIds: fan.failedOrgIds,
    ...agg,
  };
}

/**
 * Hourly at :23 — an unused minute slot, staggered from reminders.scan (:07),
 * cart-abandonment.scan (:13), and fitter-lead (:19) to spread DB load.
 */
export const REVIEW_REQUEST_CRON = "23 * * * *";

export async function registerReviewRequestJob(boss: PgBoss): Promise<void> {
  if (process.env.RESUPPLY_REVIEW_REQUEST_CRON_ENABLED !== "1") {
    logger.info(
      { event: "review-request.scan.disabled" },
      "review-request.scan: not registered (RESUPPLY_REVIEW_REQUEST_CRON_ENABLED!=1)",
    );
    // Clear any previously-persisted schedule so disabling the flag actually
    // stops the cron (table-guard pattern; typeof-guarded for test doubles).
    if (typeof boss.unschedule === "function") {
      await boss.unschedule(REVIEW_REQUEST_JOB).catch(() => undefined);
    }
    return;
  }
  await createQueueWithDlq(boss, REVIEW_REQUEST_JOB, CRON_SCAN_QUEUE_OPTS);
  await boss.work(REVIEW_REQUEST_JOB, async () => {
    try {
      const summary = await runReviewRequestScanAllOrgs();
      logger.info(
        { event: "review-request.scan.completed", ...summary },
        "review-request.scan: completed",
      );
    } catch (err) {
      logger.error(
        {
          err:
            err instanceof Error
              ? { name: err.name, message: err.message }
              : err,
        },
        "review-request.scan: failed",
      );
      throw err;
    }
  });
  await boss.schedule(REVIEW_REQUEST_JOB, REVIEW_REQUEST_CRON);
  logger.info({ cron: REVIEW_REQUEST_CRON }, "review-request.scan scheduled");
}
