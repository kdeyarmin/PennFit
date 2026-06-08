// pg-boss job: evaluate enabled metric_thresholds against the latest
// metrics_daily snapshot and write metric_alerts on a breach (migration
// 0194 / roadmap F2).
//
// Runs 15 min after the daily metrics-snapshot. For each enabled
// threshold it reads the most-recent value for the metric (and, for a
// delta mode, the value 7 days earlier), runs the pure evaluateThreshold
// from @workspace/resupply-domain, and — on a breach — upserts a
// metric_alert. The upsert is idempotent via the (threshold_id,
// metric_date) UNIQUE + ignoreDuplicates, so a re-run within the same
// day never double-fires. The email/in-app notifier is a follow-up
// slice; the alert row IS the in-app alert.
//
// Derives from metrics_daily (which derives from transaction tables) —
// never from audit_log (retired; see CLAUDE.md).

import type PgBoss from "pg-boss";

import { getSupabaseServiceRoleClient } from "@workspace/resupply-db";
import {
  evaluateThreshold,
  type ThresholdComparison,
  type ThresholdMode,
} from "@workspace/resupply-domain";

import { logger } from "../../lib/logger";
import { createQueueWithDlq, CRON_SCAN_QUEUE_OPTS } from "../lib/queue-options";

export const METRIC_ALERTS_EVALUATOR_JOB = "metrics.alerts-evaluator";
const METRIC_ALERTS_EVALUATOR_CRON = "45 6 * * *"; // 15 min after snapshot

/** Shift a YYYY-MM-DD date by deltaDays in UTC. Pure. */
export function shiftDateUtc(metricDate: string, deltaDays: number): string {
  const [y, m, d] = metricDate.split("-").map(Number);
  const ms = Date.UTC(y ?? 1970, (m ?? 1) - 1, d ?? 1) + deltaDays * 86_400_000;
  return new Date(ms).toISOString().slice(0, 10);
}

function fmtValue(value: number, unit: string): string {
  if (unit === "cents") return `$${(value / 100).toFixed(2)}`;
  if (unit === "pct") return `${value.toFixed(1)}%`;
  if (unit === "ratio") return value.toFixed(3);
  return String(value);
}

export interface AlertMessageInput {
  metricKey: string;
  unit: string;
  mode: ThresholdMode;
  comparison: ThresholdComparison;
  thresholdValue: number;
  observedValue: number;
  comparedValue: number;
  baselineValue: number | null;
}

/** Human-readable alert message. Pure + exported for testing. */
export function buildAlertMessage(i: AlertMessageInput): string {
  const obs = fmtValue(i.observedValue, i.unit);
  if (i.mode === "absolute") {
    return `${i.metricKey} is ${obs} (${i.comparison} threshold ${fmtValue(
      i.thresholdValue,
      i.unit,
    )}).`;
  }
  const base =
    i.baselineValue == null ? "n/a" : fmtValue(i.baselineValue, i.unit);
  if (i.mode === "delta_7d") {
    return `${i.metricKey} moved ${fmtValue(
      i.comparedValue,
      i.unit,
    )} week-over-week (now ${obs}, was ${base}).`;
  }
  return `${i.metricKey} changed ${i.comparedValue.toFixed(
    1,
  )}% week-over-week (now ${obs}, was ${base}).`;
}

export interface MetricAlertsEvaluatorStats {
  evaluated: number;
  fired: number;
}

export async function runMetricAlertsEvaluator(): Promise<MetricAlertsEvaluatorStats> {
  const supabase = getSupabaseServiceRoleClient();
  const { data: thresholdData, error } = await supabase
    .schema("resupply")
    .from("metric_thresholds")
    .select("*")
    .eq("enabled", true);
  if (error) throw error;

  const thresholds = (thresholdData ?? []) as Array<Record<string, unknown>>;
  let evaluated = 0;
  let fired = 0;

  // Batch the latest-snapshot reads. The prior loop issued one
  // ordered-limit-1 `metrics_daily` read per threshold (N+1). The
  // metrics_daily_latest RPC (mig 0232) returns the most-recent row per
  // metric_key in one call; the key set is the small distinct set of
  // enabled thresholds' metrics.
  const metricKeys = Array.from(
    new Set(thresholds.map((t) => String(t.metric_key))),
  );
  const latestByKey = new Map<
    string,
    { metric_date: string; metric_value: number; unit: string }
  >();
  if (metricKeys.length > 0) {
    const { data: latestRows, error: latestErr } = await supabase
      .schema("resupply")
      .rpc("metrics_daily_latest", { p_metric_keys: metricKeys });
    if (latestErr) throw latestErr;
    for (const r of (latestRows ?? []) as Array<{
      metric_key: string;
      metric_date: string;
      metric_value: number | string;
      unit: string;
    }>) {
      latestByKey.set(r.metric_key, {
        metric_date: String(r.metric_date),
        metric_value: Number(r.metric_value),
        unit: String(r.unit),
      });
    }
  }

  // Batch the delta-mode baselines (the value 7 days before each metric's
  // latest date). One `.in()` over the distinct delta keys + baseline
  // dates, matched back per (key, date). Bounded by the small number of
  // delta-mode thresholds.
  const baselineByKeyDate = new Map<string, number>();
  const deltaKeys = new Set<string>();
  const baselineDates = new Set<string>();
  for (const t of thresholds) {
    if (String(t.mode) === "absolute") continue;
    const latest = latestByKey.get(String(t.metric_key));
    if (!latest) continue;
    deltaKeys.add(String(t.metric_key));
    baselineDates.add(shiftDateUtc(latest.metric_date, -7));
  }
  if (deltaKeys.size > 0 && baselineDates.size > 0) {
    const { data: baseRows, error: baseErr } = await supabase
      .schema("resupply")
      .from("metrics_daily")
      .select("metric_key, metric_date, metric_value")
      .in("metric_key", Array.from(deltaKeys))
      .in("metric_date", Array.from(baselineDates));
    if (baseErr) throw baseErr;
    for (const r of baseRows ?? []) {
      baselineByKeyDate.set(
        `${r.metric_key}|${r.metric_date}`,
        Number(r.metric_value),
      );
    }
  }

  for (const t of thresholds) {
    evaluated += 1;
    const metricKey = String(t.metric_key);
    const comparison = String(t.comparison) as ThresholdComparison;
    const mode = String(t.mode) as ThresholdMode;
    const thresholdValue = Number(t.threshold_value);
    const severity = String(t.severity);
    const thresholdId = String(t.id);

    // Latest snapshot for this metric (pre-fetched above).
    const latest = latestByKey.get(metricKey);
    if (!latest) continue; // no data yet

    const metricDate = latest.metric_date;
    const currentValue = latest.metric_value;
    const unit = latest.unit;

    let baselineValue: number | null = null;
    if (mode !== "absolute") {
      const baselineDate = shiftDateUtc(metricDate, -7);
      const base = baselineByKeyDate.get(`${metricKey}|${baselineDate}`);
      baselineValue = base == null ? null : base;
    }

    const result = evaluateThreshold(
      { comparison, thresholdValue, mode },
      currentValue,
      baselineValue,
    );
    if (!result.breached) continue;

    const comparedValue = result.comparedValue ?? currentValue;
    const message = buildAlertMessage({
      metricKey,
      unit,
      mode,
      comparison,
      thresholdValue,
      observedValue: currentValue,
      comparedValue,
      baselineValue,
    });

    const { data: insData, error: insErr } = await supabase
      .schema("resupply")
      .from("metric_alerts")
      .upsert(
        {
          threshold_id: thresholdId,
          metric_key: metricKey,
          metric_date: metricDate,
          observed_value: currentValue,
          compared_value: comparedValue,
          baseline_value: baselineValue,
          severity,
          message,
          status: "open",
        },
        { onConflict: "threshold_id,metric_date", ignoreDuplicates: true },
      )
      .select("id");
    if (insErr) {
      logger.warn(
        { err: insErr.message, metricKey },
        "metric-alerts-evaluator: alert upsert failed (non-fatal)",
      );
      continue;
    }
    // ignoreDuplicates returns [] on conflict — a returned row means a
    // genuinely NEW alert (what the notifier slice will email).
    if (Array.isArray(insData) && insData.length > 0) fired += 1;
  }

  return { evaluated, fired };
}

export async function registerMetricAlertsEvaluatorJob(
  boss: PgBoss,
): Promise<void> {
  await createQueueWithDlq(
    boss,
    METRIC_ALERTS_EVALUATOR_JOB,
    CRON_SCAN_QUEUE_OPTS,
  );
  await boss.work(METRIC_ALERTS_EVALUATOR_JOB, async () => {
    try {
      const stats = await runMetricAlertsEvaluator();
      logger.info(
        { event: "metrics.alerts-evaluator.completed", ...stats },
        "metric-alerts-evaluator: completed",
      );
    } catch (err) {
      logger.error(
        {
          err:
            err instanceof Error
              ? { name: err.name, message: err.message }
              : err,
        },
        "metric-alerts-evaluator: failed",
      );
      throw err;
    }
  });
  await boss.schedule(
    METRIC_ALERTS_EVALUATOR_JOB,
    METRIC_ALERTS_EVALUATOR_CRON,
  );
  logger.info(
    { queue: METRIC_ALERTS_EVALUATOR_JOB, cron: METRIC_ALERTS_EVALUATOR_CRON },
    "metrics alerts-evaluator worker registered",
  );
}
