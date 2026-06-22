// Medicare ADR / audit-response SLA classification — pure date logic
// (ADR 008: no I/O, no Date.now() except a passed-in clock).
//
// When a payer or its audit contractor (RAC / CERT / TPE / UPIC / payer
// medical review) issues an Additional Documentation Request, the supplier
// must return the requested records by a hard deadline — for Medicare FFS,
// 30 calendar days after receipt of the ADR. Missing it is an automatic
// denial / recoupment. This module owns the deadline classification so the
// nightly sweep, a worklist preview, and a UI badge all agree:
//
//   * the pre-deadline heads-up windows (ADR_HEADS_UP_DAYS),
//   * the at-risk threshold (ADR_AT_RISK_DAYS), and
//   * `classifyAdrSla`, an on_track / at_risk / overdue / decided classifier.
//
// It builds on `classifyExpiry` (authorization-expiry) for the raw day math
// so there is one date-diff implementation, then maps to ADR vocabulary.

import { classifyExpiry } from "./authorization-expiry";

/** Heads-up windows, in days before `response_due`, at which the sweep
 *  emits a pre-deadline alert. Tighter than prior-auth because the ADR
 *  clock is short (≈30 days) and unforgiving. */
export const ADR_HEADS_UP_DAYS = [14, 7, 2] as const;

/** Days-out at or below which an open, undecided ADR is "at risk" (the
 *  worklist surfaces it as needing attention now). */
export const ADR_AT_RISK_DAYS = 7;

/** ADR lifecycle SLA state, denormalised onto `claim_adr_requests.sla_status`
 *  and recomputed by the sweep. */
export type AdrSlaStatus = "on_track" | "at_risk" | "overdue" | "decided";

export interface AdrSlaClassification {
  status: AdrSlaStatus;
  /** Whole days from `today` to `response_due` (negative once past due).
   *  `null` when there is no due date or it can't be parsed. */
  daysOut: number | null;
  /** The heads-up window the due date lands on EXACTLY (so the sweep fires
   *  one alert per window), or `null`. */
  matchedWindow: number | null;
}

export interface ClassifyAdrSlaOptions {
  /** True once the ADR has been submitted/closed — its clock has stopped
   *  and it is `decided` regardless of the date. */
  decided?: boolean;
  /** Override the at-risk threshold (defaults to ADR_AT_RISK_DAYS). */
  atRiskDays?: number;
}

/**
 * Classify an ADR's response deadline relative to `today`. Pure + total:
 * a decided ADR is always `decided`; a missing/unparseable due date is
 * `on_track` with a null `daysOut` (nothing to flag), never a fabricated
 * deadline.
 */
export function classifyAdrSla(
  responseDue: string | Date | null,
  today: string | Date,
  options: ClassifyAdrSlaOptions = {},
): AdrSlaClassification {
  if (options.decided) {
    return { status: "decided", daysOut: null, matchedWindow: null };
  }

  const atRiskDays = options.atRiskDays ?? ADR_AT_RISK_DAYS;
  // At-risk window must be one of the heads-up windows we test for an exact
  // match, plus the configured threshold, so a due date inside the window is
  // always flagged even on a day that is not itself a heads-up day.
  const windows = Array.from(
    new Set<number>([...ADR_HEADS_UP_DAYS, atRiskDays]),
  );
  const base = classifyExpiry(responseDue, today, windows);

  if (base.daysOut === null) {
    return { status: "on_track", daysOut: null, matchedWindow: null };
  }
  if (base.state === "expired") {
    return { status: "overdue", daysOut: base.daysOut, matchedWindow: null };
  }
  if (base.daysOut <= atRiskDays) {
    return {
      status: "at_risk",
      daysOut: base.daysOut,
      matchedWindow: base.matchedWindow,
    };
  }
  return {
    status: "on_track",
    daysOut: base.daysOut,
    matchedWindow: base.matchedWindow,
  };
}
