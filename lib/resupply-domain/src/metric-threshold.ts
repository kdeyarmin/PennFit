// Metric threshold evaluation — pure value-object logic (ADR 008: no I/O).
//
// The shared, side-effect-free core the F2 alert-evaluator job runs
// through (migration 0194 / docs/feature-roadmap-2026-05-31.md). Keeping
// "did this metric breach its threshold?" in one tested place means the
// worker job is just plumbing: read today's value (+ the 7-days-ago
// baseline for delta modes), call evaluateThreshold, persist a
// metric_alert on a breach.
//
// Three comparison MODES:
//   * absolute     — compare today's value directly to the threshold.
//   * delta_7d     — compare (today − 7d-ago) in raw units (e.g.
//                    "denial rate up > 5 points week-over-week").
//   * delta_pct_7d — compare the percent change vs 7d-ago (e.g.
//                    "net revenue down > 20% week-over-week").
//
// A delta mode with no usable baseline (missing, or zero for a percent
// change) evaluates to NOT breached — we never fabricate an alert from
// an undefined comparison.

export const THRESHOLD_COMPARISONS = ["gt", "gte", "lt", "lte"] as const;
export type ThresholdComparison = (typeof THRESHOLD_COMPARISONS)[number];

export const THRESHOLD_MODES = [
  "absolute",
  "delta_7d",
  "delta_pct_7d",
] as const;
export type ThresholdMode = (typeof THRESHOLD_MODES)[number];

export interface ThresholdRule {
  comparison: ThresholdComparison;
  thresholdValue: number;
  mode: ThresholdMode;
}

export interface ThresholdEvalResult {
  breached: boolean;
  /**
   * The value actually compared against the threshold: the absolute
   * value, the 7-day delta, or the 7-day percent delta. null when a
   * delta mode has no usable baseline (cannot evaluate → not breached).
   */
  comparedValue: number | null;
  /** Human-readable explanation, for the alert message + debugging. */
  reason: string;
}

function compare(a: number, op: ThresholdComparison, b: number): boolean {
  switch (op) {
    case "gt":
      return a > b;
    case "gte":
      return a >= b;
    case "lt":
      return a < b;
    case "lte":
      return a <= b;
  }
}

/**
 * Evaluate one threshold rule against today's metric value (and, for
 * delta modes, the 7-days-ago baseline). Pure + total — never throws,
 * never fabricates a breach from a missing baseline.
 */
export function evaluateThreshold(
  rule: ThresholdRule,
  currentValue: number,
  baselineValue?: number | null,
): ThresholdEvalResult {
  let comparedValue: number;

  if (rule.mode === "absolute") {
    comparedValue = currentValue;
  } else if (baselineValue == null || !Number.isFinite(baselineValue)) {
    return {
      breached: false,
      comparedValue: null,
      reason: "no baseline to compare against",
    };
  } else if (rule.mode === "delta_7d") {
    comparedValue = currentValue - baselineValue;
  } else {
    // delta_pct_7d — percent change relative to the baseline magnitude.
    if (baselineValue === 0) {
      return {
        breached: false,
        comparedValue: null,
        reason: "baseline is zero; percent change is undefined",
      };
    }
    comparedValue =
      ((currentValue - baselineValue) / Math.abs(baselineValue)) * 100;
  }

  const breached = compare(comparedValue, rule.comparison, rule.thresholdValue);
  const reason = breached
    ? `${rule.mode} value ${comparedValue} ${rule.comparison} threshold ${rule.thresholdValue}`
    : `${rule.mode} value ${comparedValue} within threshold ${rule.thresholdValue}`;

  return { breached, comparedValue, reason };
}
