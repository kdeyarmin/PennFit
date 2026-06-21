// Authorization / order expiry heads-up — pure date classification
// (ADR 008: no I/O, no Date.now() except a passed-in clock).
//
// Prior authorizations and DME written orders (DWOs) both need a
// pre-expiry "heads-up" so staff renew them before they lapse and claims
// start denying. Two nightly worker sweeps did this independently and
// EACH hardcoded its own heads-up windows and its own severity band — the
// kind of duplication that drifts. This module owns:
//
//   * the per-document heads-up windows (PRIOR_AUTH_HEADS_UP_DAYS,
//     DWO_HEADS_UP_DAYS) — exported so the sweeps share one definition,
//   * the severity band (critical within HEADS_UP_CRITICAL_DAYS, else
//     warning), and
//   * `classifyExpiry`, a small ok/expiring/expired classifier a UI badge
//     or a renewal-worklist preview can call with the same windows.
//
// The sweeps keep their own DB queries and keyset pagination; they just
// stop redeclaring these constants.

/** Prior-auth heads-up windows, in days before `approved_through`. */
export const PRIOR_AUTH_HEADS_UP_DAYS = [30, 14, 7] as const;

/** DWO heads-up windows, in days before `expires_on`. */
export const DWO_HEADS_UP_DAYS = [60, 30, 7] as const;

/** Days-out at or below which a heads-up is "critical" rather than
 *  "warning". */
export const HEADS_UP_CRITICAL_DAYS = 7;

export type HeadsUpSeverity = "warning" | "critical";

/** Severity for a heads-up `daysOut` days before expiry. */
export function headsUpSeverity(daysOut: number): HeadsUpSeverity {
  return daysOut <= HEADS_UP_CRITICAL_DAYS ? "critical" : "warning";
}

export type ExpiryState = "ok" | "expiring" | "expired";

export interface ExpiryClassification {
  state: ExpiryState;
  /** Whole days from `today` to `endDate` (negative once expired). `null`
   *  when there is no end date or it can't be parsed. */
  daysOut: number | null;
  /** The heads-up window the end date lands on EXACTLY (matching how the
   *  sweeps fire one alert per window), or `null`. */
  matchedWindow: number | null;
  /** Severity when expiring/expired; `null` when ok. */
  severity: HeadsUpSeverity | null;
}

const DAY_MS = 24 * 60 * 60 * 1000;

function toUtcDay(value: string | Date): number | null {
  if (value instanceof Date) {
    const t = value.getTime();
    if (Number.isNaN(t)) return null;
    return Date.parse(new Date(t).toISOString().slice(0, 10));
  }
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(value);
  if (!m) return null;
  const t = Date.parse(`${m[1]}-${m[2]}-${m[3]}`);
  return Number.isNaN(t) ? null : t;
}

/**
 * Classify a document's expiry relative to `today` and a set of heads-up
 * windows. Pure + total: a missing/unparseable end date is `ok` with a
 * null `daysOut` (nothing to flag), never a fabricated expiry.
 */
export function classifyExpiry(
  endDate: string | Date | null,
  today: string | Date,
  windows: readonly number[],
): ExpiryClassification {
  const ok: ExpiryClassification = {
    state: "ok",
    daysOut: null,
    matchedWindow: null,
    severity: null,
  };
  if (endDate == null) return ok;
  const end = toUtcDay(endDate);
  const now = toUtcDay(today);
  if (end === null || now === null) return ok;

  const daysOut = Math.round((end - now) / DAY_MS);
  if (daysOut < 0) {
    return {
      state: "expired",
      daysOut,
      matchedWindow: null,
      severity: "critical",
    };
  }

  const maxWindow = windows.length > 0 ? Math.max(...windows) : 0;
  const matchedWindow = windows.includes(daysOut) ? daysOut : null;
  if (daysOut <= maxWindow) {
    return {
      state: "expiring",
      daysOut,
      matchedWindow,
      severity: headsUpSeverity(daysOut),
    };
  }
  return { state: "ok", daysOut, matchedWindow: null, severity: null };
}
