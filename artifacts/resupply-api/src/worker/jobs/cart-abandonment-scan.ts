// pg-boss job: hourly cart-abandonment sweep (A1).
//
// Why this exists
// ---------------
// Before this job, `POST /admin/shop/abandoned-carts/send-due` was the
// ONLY way to nudge a stale cart — an admin had to manually click the
// dispatcher in the console. In practice, abandoned carts sat for
// days before a human triggered a sweep, by which point the customer
// had usually forgotten or bought elsewhere. The dispatcher's own
// suppression rules already enforce "one nudge per cart-event" and
// "24h cool-down before the first nudge", so running the same code
// hourly is safe and just removes the human latency.
//
// What this job does
// ------------------
// Hourly cron. Calls `runCartAbandonmentDispatch()` — the same
// helper that backs the admin button — and logs the resulting stats.
// No additional logic lives here; suppression policy, comm-prefs
// gating, DND window, and SendGrid config detection are all owned
// by the helper.
//
// Feature flag
// ------------
// Off by default. Set `RESUPPLY_CART_ABANDONMENT_CRON_ENABLED=1` to
// turn it on. Mirrors the posture of `fitter-lead.first-day-nudge` —
// staging deploys with credentialed SendGrid should NOT start
// nudging real abandoned carts the moment this code lands; production
// flips the flag once the rollout has been verified end-to-end.
//
// Idempotency / parallelism
// -------------------------
// The dispatcher's atomic `reminded_at` stamp makes the cron safe to
// run concurrently with the admin button. Two callers stamping in
// parallel both SELECT-then-UPDATE; Postgres serialises the UPDATEs,
// the second one matches zero rows, and that caller does no work.

import type PgBoss from "pg-boss";

import { logger } from "../../lib/logger";
import { runCartAbandonmentDispatch } from "../../lib/cart-abandonment/run-dispatch";
import { forEachActiveOrg } from "../lib/for-each-active-org.js";
import { createQueueWithDlq, CRON_SCAN_QUEUE_OPTS } from "../lib/queue-options";

export const CART_ABANDONMENT_JOB = "cart-abandonment.scan";

/**
 * Aggregate envelope logged per cron tick: the fan-out shape (how many
 * tenants ran / failed) plus the summed dispatcher stats across every
 * active tenant.
 */
export interface CartAbandonmentScanSummary {
  /** Active tenants swept this tick. */
  tenants: number;
  /** Tenants whose dispatch completed without throwing. */
  succeeded: number;
  /** Tenant ids whose dispatch threw (already logged, isolated). */
  failedOrgIds: string[];
  /** Σ rows stamped reminded_at across tenants. */
  scanned: number;
  /** Σ emails SendGrid accepted across tenants. */
  sent: number;
  /** Σ rows skipped because SendGrid was unconfigured. */
  skippedNoConfig: number;
  /** Σ rows whose send attempt failed for any other reason. */
  skippedFailed: number;
  /** Σ rows suppressed by comm-prefs / DND. */
  skippedOptOut: number;
}

/**
 * Run the cart-abandonment dispatcher once for EVERY active tenant,
 * isolating per-tenant failures, and return the aggregate summary.
 *
 * Each tenant's `cart_events`, `shop_customers`, and
 * `communication_preferences` are org-scoped, and the dispatcher's own
 * `cart_abandonment.dispatcher` feature gate is resolved per `orgId` —
 * so a tenant that hasn't enabled nudging is swept but does no work, and
 * a nudge only ever reaches a shopper in that cart's own tenant.
 *
 * Single-tenant: `listActiveOrgIds()` returns just the seed org, so this
 * is exactly the prior one-tenant sweep.
 */
export async function runCartAbandonmentScanAllOrgs(): Promise<CartAbandonmentScanSummary> {
  const agg = {
    scanned: 0,
    sent: 0,
    skippedNoConfig: 0,
    skippedFailed: 0,
    skippedOptOut: 0,
  };
  const fan = await forEachActiveOrg(
    async (orgId) => {
      const stats = await runCartAbandonmentDispatch({ orgId, log: logger });
      agg.scanned += stats.scanned;
      agg.sent += stats.sent;
      agg.skippedNoConfig += stats.skippedNoConfig;
      agg.skippedFailed += stats.skippedFailed;
      agg.skippedOptOut += stats.skippedOptOut;
    },
    { jobName: CART_ABANDONMENT_JOB },
  );
  return {
    tenants: fan.total,
    succeeded: fan.succeeded,
    failedOrgIds: fan.failedOrgIds,
    ...agg,
  };
}

/**
 * Hourly at :13 — staggered from the other resupply crons
 * (`reminders.scan` :07, `fitter-lead.first-day-nudge` :19) to spread
 * DB load. No business reason for :13 specifically; just an unused
 * minute slot.
 */
export const CART_ABANDONMENT_CRON = "13 * * * *";

export async function registerCartAbandonmentJob(boss: PgBoss): Promise<void> {
  if (process.env.RESUPPLY_CART_ABANDONMENT_CRON_ENABLED !== "1") {
    logger.info(
      { event: "cart-abandonment.scan.disabled" },
      "cart-abandonment.scan: not registered (RESUPPLY_CART_ABANDONMENT_CRON_ENABLED!=1)",
    );
    // A previously persisted pg-boss schedule keeps enqueueing
    // ticks into this now-worker-less queue (and replays them in
    // a burst on re-enable). Clear it so disabling the flag
    // actually stops the cron (table-guard pattern).
    // typeof-guarded like worker/lib/table-guard.ts — test
    // doubles (and old pg-boss) may not implement unschedule.
    if (typeof boss.unschedule === "function") {
      await boss.unschedule(CART_ABANDONMENT_JOB).catch(() => undefined);
    }
    return;
  }
  await createQueueWithDlq(boss, CART_ABANDONMENT_JOB, CRON_SCAN_QUEUE_OPTS);
  await boss.work(CART_ABANDONMENT_JOB, async () => {
    try {
      // Fan out across every active tenant. A single tenant's dispatch
      // failure is isolated (logged + tallied in failedOrgIds) by
      // forEachActiveOrg and does NOT abort the others; the handler only
      // rethrows if the tenant enumeration itself fails (pg-boss retry).
      const summary = await runCartAbandonmentScanAllOrgs();
      logger.info(
        { event: "cart-abandonment.scan.completed", ...summary },
        "cart-abandonment.scan: completed",
      );
    } catch (err) {
      logger.error(
        {
          err:
            err instanceof Error
              ? { name: err.name, message: err.message }
              : err,
        },
        "cart-abandonment.scan: failed",
      );
      throw err;
    }
  });
  await boss.schedule(CART_ABANDONMENT_JOB, CART_ABANDONMENT_CRON);
  logger.info(
    { cron: CART_ABANDONMENT_CRON },
    "cart-abandonment.scan scheduled",
  );
}
