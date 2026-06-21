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
    // Guard a non-finite current value (NaN / ±Infinity). A NaN compared
    // against any threshold is always false, so without this guard a
    // broken metric reads back as "not breached" — silently hiding the
    // exact breakage an alerting system exists to surface. Make it
    // explicit instead of letting it be swallowed.
    if (!Number.isFinite(currentValue)) {
      return {
        breached: false,
        comparedValue: null,
        reason: "current value is not finite",
      };
    }
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
    // delta_pct_7d — percent change relative to the baseline MAGNITUDE.
    if (baselineValue === 0) {
      return {
        breached: false,
        comparedValue: null,
        reason: "baseline is zero; percent change is undefined",
      };
    }
    // Sign convention for a NEGATIVE baseline: we divide by
    // `Math.abs(baselineValue)` so the SIGN of the percent change tracks
    // the SIGN of the raw movement (currentValue − baselineValue), not the
    // sign of the baseline. Example: baseline −100 → current −80 is a raw
    // +20 move; dividing by |−100| = 100 yields +20% ("up 20%"), which is
    // what an operator expects ("the number got less negative"). Dividing
    // by the signed −100 would flip that to −20% and invert every
    // gt/lt comparison for negative-baseline metrics. Keeping the
    // denominator a magnitude makes "X% up / down" mean the intuitive
    // thing regardless of which side of zero the baseline sits on.
    comparedValue =
      ((currentValue - baselineValue) / Math.abs(baselineValue)) * 100;
  }

  const breached = compare(comparedValue, rule.comparison, rule.thresholdValue);
  const reason = breached
    ? `${rule.mode} value ${comparedValue} ${rule.comparison} threshold ${rule.thresholdValue}`
    : `${rule.mode} value ${comparedValue} within threshold ${rule.thresholdValue}`;

  return { breached, comparedValue, reason };
}

/**
 * Hysteresis helper for noise suppression. Given the chronological history
 * of per-evaluation breach flags (oldest → newest), returns true only when
 * the most recent `minConsecutive` entries are ALL true — i.e. the metric
 * has breached on every one of the last N evaluations, not just spiked for
 * a single noisy day. The worker uses this to decide whether a breach is
 * persistent enough to alert on.
 *
 * Pure + total: never throws, never reads a clock. Defensive on inputs:
 *   * `minConsecutive` is clamped to a positive integer (a value of 0,
 *     negative, or non-finite is treated as 1 — "at least one breach").
 *   * If the history is SHORTER than `minConsecutive` there cannot yet be
 *     enough consecutive breaches, so it returns false (we don't treat a
 *     short, brand-new history as a satisfied streak).
 */
export function breachPersists(
  history: readonly boolean[],
  minConsecutive: number,
): boolean {
  const need =
    Number.isFinite(minConsecutive) && minConsecutive > 0
      ? Math.trunc(minConsecutive)
      : 1;

  // Not enough data points to form a streak of the required length.
  if (history.length < need) return false;

  // Inspect only the most recent `need` entries; every one must be true.
  for (let i = history.length - need; i < history.length; i += 1) {
    if (!history[i]) return false;
  }
  return true;
}
