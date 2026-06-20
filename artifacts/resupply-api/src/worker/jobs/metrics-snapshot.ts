// pg-boss job: persist a daily snapshot of headline KPIs into
// resupply.metrics_daily (migration 0194 / roadmap F2).
//
// Runs nightly for the just-completed UTC day. The metrics substrate is
// keyed (date, metric_key) so this job is the writer the evaluator job +
// the owner digest + goal pace-tracking all read back from. Idempotent:
// upserts on the (metric_date, metric_key) PK, so a re-run for the same
// day overwrites cleanly.
//
// KPI set is deliberately a SMALL, robust starter — net revenue + order
// count from shop_orders — and is meant to GROW: add a collector for a
// billing / subscription / adherence KPI and it shows up in the time
// series + becomes thresholdable, no schema change. Each collector is
// fail-soft at the job level (a thrown query is logged + retried by the
// DLQ, never silently zeroed into the rollup).
//
// Derives from event/transaction tables + the same shape the analytics
// endpoints compute — never from audit_log (retired; see CLAUDE.md).

import type PgBoss from "pg-boss";

import { getOrgScopedClient } from "@workspace/resupply-db";

import { logger } from "../../lib/logger";
import { forEachActiveOrg } from "../lib/for-each-active-org.js";
import { createQueueWithDlq, CRON_SCAN_QUEUE_OPTS } from "../lib/queue-options";

export const METRICS_SNAPSHOT_JOB = "metrics.daily-snapshot";
// 06:30 UTC — after the midnight data settles and the earlier nightly
// jobs (therapy sync 04:30, fleet snapshot 05:00) have run.
const METRICS_SNAPSHOT_CRON = "30 6 * * *";

export type MetricUnit = "count" | "cents" | "ratio" | "pct" | "days";

export interface MetricDailyRow {
  metric_date: string; // YYYY-MM-DD
  metric_key: string;
  metric_value: number;
  unit: MetricUnit;
}

export interface DailyMetricInputs {
  ordersPaidCount: number;
  revenueGrossCents: number;
  revenueRefundedCents: number;
}

/**
 * The UTC day-window for a snapshot: the just-completed day. Pure +
 * exported so the date math is unit-testable.
 */
export function dailyWindowUtc(now: Date): {
  metricDate: string;
  startIso: string;
  endIso: string;
} {
  const startOfToday = Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth(),
    now.getUTCDate(),
  );
  const startOfYesterday = startOfToday - 86_400_000;
  return {
    metricDate: new Date(startOfYesterday).toISOString().slice(0, 10),
    startIso: new Date(startOfYesterday).toISOString(),
    endIso: new Date(startOfToday).toISOString(),
  };
}

/**
 * Assemble the metrics_daily rows for one day from the collected raw
 * numbers. Pure: net revenue is derived here (gross − refunded) so the
 * "what counts as net" rule lives in one tested place.
 */
export function buildMetricRows(
  metricDate: string,
  inputs: DailyMetricInputs,
): MetricDailyRow[] {
  const netCents = inputs.revenueGrossCents - inputs.revenueRefundedCents;
  return [
    {
      metric_date: metricDate,
      metric_key: "orders_paid_count",
      metric_value: inputs.ordersPaidCount,
      unit: "count",
    },
    {
      metric_date: metricDate,
      metric_key: "revenue_gross_cents",
      metric_value: inputs.revenueGrossCents,
      unit: "cents",
    },
    {
      metric_date: metricDate,
      metric_key: "revenue_refunded_cents",
      metric_value: inputs.revenueRefundedCents,
      unit: "cents",
    },
    {
      metric_date: metricDate,
      metric_key: "revenue_net_cents",
      metric_value: netCents,
      unit: "cents",
    },
  ];
}

export interface MetricsSnapshotStats {
  metricDate: string;
  written: number;
}

/**
 * Snapshot one tenant's headline KPIs for the given UTC day-window.
 * Extracted so the cron can fan out across every active tenant — the
 * metrics substrate (migration 0380) is now keyed (org_id, metric_date,
 * metric_key), so each tenant gets its OWN daily series: shop_orders is
 * read on the tenant's own org-scoped client and every metrics_daily row
 * is stamped with the tenant's org_id. Returns the number of rows written
 * for THIS tenant.
 */
export async function runMetricsSnapshotForOrg(
  orgId: string,
  now: Date,
): Promise<number> {
  const { metricDate, startIso, endIso } = dailyWindowUtc(now);
  const supabase = getOrgScopedClient(orgId);

  // Bounded fetch: one day of paid orders. Sum in JS (PostgREST has no
  // portable SUM here) — the daily order volume is small.
  const { data: orders, error } = await supabase
    .from("shop_orders")
    .select("amount_total_cents, amount_refunded_cents")
    .eq("status", "paid")
    .gte("paid_at", startIso)
    .lt("paid_at", endIso);
  if (error) throw error;

  let grossCents = 0;
  let refundedCents = 0;
  let count = 0;
  for (const o of orders ?? []) {
    count += 1;
    grossCents += o.amount_total_cents ?? 0;
    refundedCents += o.amount_refunded_cents ?? 0;
  }

  const rows = buildMetricRows(metricDate, {
    ordersPaidCount: count,
    revenueGrossCents: grossCents,
    revenueRefundedCents: refundedCents,
  });

  // metrics_daily is NOT in the typed Database, so reach it via raw();
  // stamp the tenant's org_id on every row and upsert on the re-keyed
  // (org_id, metric_date, metric_key) PK (migration 0380).
  const capturedAt = new Date().toISOString();
  const { error: upErr } = await supabase
    .raw()
    .schema("resupply")
    .from("metrics_daily")
    .upsert(
      rows.map((r) => ({ ...r, org_id: orgId, captured_at: capturedAt })),
      { onConflict: "org_id,metric_date,metric_key" },
    );
  if (upErr) throw upErr;

  return rows.length;
}

export async function runMetricsSnapshot(
  now: Date = new Date(),
): Promise<MetricsSnapshotStats> {
  const { metricDate } = dailyWindowUtc(now);

  // Fan out across every active tenant — each writes its own per-tenant
  // daily snapshot (migration 0380), with per-tenant failure isolation.
  let written = 0;
  await forEachActiveOrg(
    async (orgId) => {
      written += await runMetricsSnapshotForOrg(orgId, now);
    },
    { jobName: METRICS_SNAPSHOT_JOB },
  );

  return { metricDate, written };
}

export async function registerMetricsSnapshotJob(boss: PgBoss): Promise<void> {
  await createQueueWithDlq(boss, METRICS_SNAPSHOT_JOB, CRON_SCAN_QUEUE_OPTS);
  await boss.work(METRICS_SNAPSHOT_JOB, async () => {
    try {
      const stats = await runMetricsSnapshot();
      logger.info(
        { event: "metrics.daily-snapshot.completed", ...stats },
        "metrics-snapshot: completed",
      );
    } catch (err) {
      logger.error(
        {
          err:
            err instanceof Error
              ? { name: err.name, message: err.message }
              : err,
        },
        "metrics-snapshot: failed",
      );
      throw err;
    }
  });
  await boss.schedule(METRICS_SNAPSHOT_JOB, METRICS_SNAPSHOT_CRON);
  logger.info(
    { queue: METRICS_SNAPSHOT_JOB, cron: METRICS_SNAPSHOT_CRON },
    "metrics daily-snapshot worker registered",
  );
}
