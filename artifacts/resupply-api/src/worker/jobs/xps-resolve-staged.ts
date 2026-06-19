// pg-boss job: resolve XPS orders that are staged but not yet booked.
//
// Why this exists
// ---------------
// XPS's REST model stages an order (Put Order) and then books it into a
// shipment (bookNumber + tracking + label) asynchronously via Webship
// rules / auto-processing. The interactive "Create label" flow polls for a
// second or two, but if XPS hasn't booked the order by then it's left in
// the `staged` state and a human has to click "Sync". This cron resolves
// those staged orders automatically so tracking + the patient shipping
// notification land without anyone watching the queue.
//
// What it does
// ------------
// Every few minutes (cron), for each active tenant: find shop_orders with
// xps_label_status = 'staged', and run the shared resolveAndPersist on each
// — the same code path as the Sync button. On a booked shipment that stamps
// tracking + shipped_at and fires the patient notification. Orders XPS
// still hasn't booked stay `staged` for the next tick.
//
// Feature flag
// ------------
// Off by default. Set XPS_RESOLVE_STAGED_CRON_ENABLED=1 to turn it on.
// The adapter itself is per-tenant and fail-soft: a tenant without XPS
// configured is swept but does no work.

import type PgBoss from "pg-boss";

import { logger } from "../../lib/logger";
import { getOrgScopedClient } from "@workspace/resupply-db";
import {
  getXpsAdapterForOrg,
  loadShippingOrder,
  resolveAndPersist,
} from "../../lib/shipping/xps-core";
import { forEachActiveOrg } from "../lib/for-each-active-org.js";
import { createQueueWithDlq, CRON_SCAN_QUEUE_OPTS } from "../lib/queue-options";

export const XPS_RESOLVE_STAGED_JOB = "xps.resolve-staged";

/** Max staged orders resolved per tenant per tick (bounds XPS request load). */
const MAX_PER_TENANT = 100;

export interface XpsResolveStagedSummary {
  tenants: number;
  succeeded: number;
  failedOrgIds: string[];
  /** Σ staged orders newly booked this tick. */
  booked: number;
  /** Σ staged orders still awaiting XPS booking. */
  stillStaged: number;
  /** Σ staged orders whose resolve returned an adapter error this tick. */
  errored: number;
}

/**
 * Resolve every staged XPS order for one tenant. A tenant whose adapter is
 * not configured returns immediately (no work). Per-order failures are
 * isolated and logged; they do not abort the tenant's sweep.
 */
async function resolveStagedForOrg(orgId: string): Promise<{
  booked: number;
  stillStaged: number;
  errored: number;
}> {
  const adapter = await getXpsAdapterForOrg(orgId);
  if (adapter.availability().status !== "configured") {
    return { booked: 0, stillStaged: 0, errored: 0 };
  }
  const supabase = getOrgScopedClient(orgId);
  const { data, error } = await supabase
    .from("shop_orders")
    .select("id")
    .eq("xps_label_status", "staged")
    .eq("status", "paid")
    .order("created_at", { ascending: true })
    .limit(MAX_PER_TENANT);
  if (error) throw error;

  let booked = 0;
  let stillStaged = 0;
  let errored = 0;
  for (const row of (data ?? []) as Array<{ id: string }>) {
    try {
      const order = await loadShippingOrder(orgId, row.id);
      if (!order) continue;
      const resolved = await resolveAndPersist({
        orgId,
        order,
        adapter,
        log: logger,
      });
      if (resolved.kind === "booked") {
        booked++;
      } else if (resolved.kind === "error") {
        // resolveAndPersist returns (not throws) on an adapter error
        // (auth/rate-limit/etc.). Surface it so a persistent failure
        // isn't hidden as "still staged".
        errored++;
        logger.warn(
          { orderId: row.id, reason: resolved.error },
          "xps.resolve-staged: shipment resolve returned an adapter error",
        );
      } else {
        stillStaged++;
      }
    } catch (err) {
      errored++;
      // Log the Error object itself so the logger's err.* redaction applies.
      logger.warn(
        { orderId: row.id, err },
        "xps.resolve-staged: order resolve failed (isolated)",
      );
    }
  }
  return { booked, stillStaged, errored };
}

export async function runXpsResolveStagedAllOrgs(): Promise<XpsResolveStagedSummary> {
  const agg = { booked: 0, stillStaged: 0, errored: 0 };
  const fan = await forEachActiveOrg(
    async (orgId) => {
      const stats = await resolveStagedForOrg(orgId);
      agg.booked += stats.booked;
      agg.stillStaged += stats.stillStaged;
      agg.errored += stats.errored;
    },
    { jobName: XPS_RESOLVE_STAGED_JOB },
  );
  return {
    tenants: fan.total,
    succeeded: fan.succeeded,
    failedOrgIds: fan.failedOrgIds,
    ...agg,
  };
}

/** Every 5 minutes at :04 — an unused slot, staggered from the other crons. */
export const XPS_RESOLVE_STAGED_CRON = "4/5 * * * *";

export async function registerXpsResolveStagedJob(boss: PgBoss): Promise<void> {
  if (process.env.XPS_RESOLVE_STAGED_CRON_ENABLED !== "1") {
    logger.info(
      { event: "xps.resolve-staged.disabled" },
      "xps.resolve-staged: not registered (XPS_RESOLVE_STAGED_CRON_ENABLED!=1)",
    );
    if (typeof boss.unschedule === "function") {
      await boss.unschedule(XPS_RESOLVE_STAGED_JOB).catch(() => undefined);
    }
    return;
  }
  await createQueueWithDlq(boss, XPS_RESOLVE_STAGED_JOB, CRON_SCAN_QUEUE_OPTS);
  await boss.work(XPS_RESOLVE_STAGED_JOB, async () => {
    try {
      const summary = await runXpsResolveStagedAllOrgs();
      logger.info(
        { event: "xps.resolve-staged.completed", ...summary },
        "xps.resolve-staged: completed",
      );
    } catch (err) {
      logger.error(
        {
          err:
            err instanceof Error
              ? { name: err.name, message: err.message }
              : err,
        },
        "xps.resolve-staged: failed",
      );
      throw err;
    }
  });
  await boss.schedule(XPS_RESOLVE_STAGED_JOB, XPS_RESOLVE_STAGED_CRON);
  logger.info(
    { cron: XPS_RESOLVE_STAGED_CRON },
    "xps.resolve-staged scheduled",
  );
}
