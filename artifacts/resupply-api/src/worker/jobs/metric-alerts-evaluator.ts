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

  for (const t of thresholds) {
    evaluated += 1;
    const metricKey = String(t.metric_key);
    const comparison = String(t.comparison) as ThresholdComparison;
    const mode = String(t.mode) as ThresholdMode;
    const thresholdValue = Number(t.threshold_value);
    const severity = String(t.severity);
    const thresholdId = String(t.id);

    // Latest snapshot for this metric.
    const { data: latestData } = await supabase
      .schema("resupply")
      .from("metrics_daily")
      .select("metric_date, metric_value, unit")
      .eq("metric_key", metricKey)
      .order("metric_date", { ascending: false })
      .limit(1)
      .maybeSingle();
    const latest = latestData as Record<string, unknown> | null;
    if (!latest) continue; // no data yet

    const metricDate = String(latest.metric_date);
    const currentValue = Number(latest.metric_value);
    const unit = String(latest.unit);

    let baselineValue: number | null = null;
    if (mode !== "absolute") {
      const baselineDate = shiftDateUtc(metricDate, -7);
      const { data: baseData } = await supabase
        .schema("resupply")
        .from("metrics_daily")
        .select("metric_value")
        .eq("metric_key", metricKey)
        .eq("metric_date", baselineDate)
        .maybeSingle();
      const base = baseData as Record<string, unknown> | null;
      baselineValue = base == null ? null : Number(base.metric_value);
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
