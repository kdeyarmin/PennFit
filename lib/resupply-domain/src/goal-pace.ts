// Goal pace-to-target — pure value-object logic (ADR 008: no I/O).
//
// The owner sets a target for a headline KPI per period (business_targets,
// migration 0190); the F2 metrics_daily series provides the actuals. This
// is the shared, tested core that turns (target, period, actual-to-date)
// into a pace verdict — "are we ahead of / on / behind the linear track to
// hit this by period end, and where will we land at this run-rate?" — so
// every owner surface (the Goals page, the weekly digest) computes pace
// one way (Owner #8).
//
// Linear pro-rata is the model: expected-by-now = target × (days elapsed ÷
// days in period). It deliberately makes no seasonality assumption — a
// simple, explainable baseline the owner can reason about.

export type GoalPaceStatus = "ahead" | "on_track" | "behind" | "unknown";

export interface PeriodRange {
  /** Inclusive start, YYYY-MM-DD. */
  startDate: string;
  /** Exclusive end, YYYY-MM-DD (first day after the period). */
  endExclusiveDate: string;
}

const DAY_MS = 86_400_000;

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

/**
 * Parse a target `period` string into a UTC date range. Supports
 * "YYYY-MM" (calendar month) and "YYYY" (calendar year). Anything else
 * (a quarter label, free text) returns null → the caller reports
 * "pace unknown" rather than guessing a window.
 */
export function parsePeriodRange(period: string): PeriodRange | null {
  const month = /^(\d{4})-(\d{2})$/.exec(period);
  if (month) {
    const year = Number(month[1]);
    const mon = Number(month[2]);
    if (mon < 1 || mon > 12) return null;
    const startDate = `${month[1]}-${month[2]}-01`;
    const nextMonth = mon === 12 ? 1 : mon + 1;
    const nextYear = mon === 12 ? year + 1 : year;
    return {
      startDate,
      endExclusiveDate: `${nextYear}-${pad2(nextMonth)}-01`,
    };
  }
  const yearOnly = /^(\d{4})$/.exec(period);
  if (yearOnly) {
    const year = Number(yearOnly[1]);
    return {
      startDate: `${year}-01-01`,
      endExclusiveDate: `${year + 1}-01-01`,
    };
  }
  return null;
}

export interface GoalPaceInput {
  /** The target value for the whole period (≥ 0). */
  targetValue: number;
  /** Inclusive period start, YYYY-MM-DD. */
  startDate: string;
  /** Exclusive period end, YYYY-MM-DD. */
  endExclusiveDate: string;
  /** Cumulative actual recorded so far this period (≥ 0). */
  actualToDate: number;
  /** "Now" for the elapsed calculation; defaults to the current time. */
  asOf?: string;
}

export interface GoalPaceResult {
  daysInPeriod: number;
  daysElapsed: number;
  actualToDate: number;
  /** target × (elapsed ÷ total) — the linear "where we should be" mark. */
  expectedToDate: number | null;
  /** actualToDate ÷ expectedToDate (> 1 = ahead). null before any days elapse. */
  paceRatio: number | null;
  /** actualToDate ÷ targetValue (fraction of the goal reached). */
  attainmentRatio: number | null;
  /** Run-rate projection to period end (actual ÷ elapsed × total). */
  projectedValue: number | null;
  status: GoalPaceStatus;
}

/**
 * Compute pace-to-goal. The status band is ±10% around the linear track:
 * ≥ 1.1 ahead, ≥ 0.9 on_track, otherwise behind; "unknown" before the
 * period starts (no days elapsed yet) or with a non-positive window.
 */
export function computeGoalPace(input: GoalPaceInput): GoalPaceResult {
  const startMs = Date.parse(input.startDate);
  const endMs = Date.parse(input.endExclusiveDate);
  const asOfMs = input.asOf ? Date.parse(input.asOf) : Date.now();

  const unknown: GoalPaceResult = {
    daysInPeriod: 0,
    daysElapsed: 0,
    actualToDate: input.actualToDate,
    expectedToDate: null,
    paceRatio: null,
    attainmentRatio:
      input.targetValue > 0 ? input.actualToDate / input.targetValue : null,
    projectedValue: null,
    status: "unknown",
  };

  if (Number.isNaN(startMs) || Number.isNaN(endMs) || endMs <= startMs) {
    return unknown;
  }
  const effectiveAsOf = Number.isNaN(asOfMs) ? Date.now() : asOfMs;

  const daysInPeriod = Math.round((endMs - startMs) / DAY_MS);
  const elapsedMs = Math.min(
    Math.max(effectiveAsOf - startMs, 0),
    endMs - startMs,
  );
  const daysElapsed = Math.min(Math.round(elapsedMs / DAY_MS), daysInPeriod);

  if (daysElapsed <= 0 || daysInPeriod <= 0) {
    return { ...unknown, daysInPeriod };
  }

  const expectedToDate = input.targetValue * (daysElapsed / daysInPeriod);
  const paceRatio =
    expectedToDate > 0 ? input.actualToDate / expectedToDate : null;
  const attainmentRatio =
    input.targetValue > 0 ? input.actualToDate / input.targetValue : null;
  const projectedValue = input.actualToDate * (daysInPeriod / daysElapsed);

  const status: GoalPaceStatus =
    paceRatio == null
      ? "unknown"
      : paceRatio >= 1.1
        ? "ahead"
        : paceRatio >= 0.9
          ? "on_track"
          : "behind";

  return {
    daysInPeriod,
    daysElapsed,
    actualToDate: input.actualToDate,
    expectedToDate,
    paceRatio,
    attainmentRatio,
    projectedValue,
    status,
  };
}
