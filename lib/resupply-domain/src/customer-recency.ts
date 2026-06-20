// Customer recency windows — pure thresholds + classifier (ADR 008: no
// I/O, no Date.now() except a passed-in clock).
//
// Several growth jobs reason about how long it's been since a customer's
// last paid order: the win-back job ("lapsed but still recoverable") and
// the deductible-reset push ("still an active customer worth nudging").
// The 730-day "active customer" lookback was hardcoded independently in
// BOTH jobs (as STALE_REGISTRATION_DAYS in win-back and ACTIVE_LOOKBACK_DAYS
// in deductible-reset) — exactly the kind of constant that drifts. This
// module owns the windows so they move together, plus a small classifier a
// dashboard or future job can reuse.

/** No paid order within this many days makes a customer "lapsed". */
export const CUSTOMER_LAPSED_DAYS = 180;

/** Don't re-win-back the same customer within this many days. */
export const WINBACK_COOLDOWN_DAYS = 365;

/** A customer with a paid order within this many days is still "active";
 *  older than this they're a stale registration outreach won't recover. */
export const CUSTOMER_ACTIVE_LOOKBACK_DAYS = 730;

export type CustomerRecency = "active" | "lapsed" | "stale";

export interface CustomerRecencyThresholds {
  /** Active → lapsed boundary (default CUSTOMER_LAPSED_DAYS). */
  lapsedDays?: number;
  /** Lapsed → stale boundary (default CUSTOMER_ACTIVE_LOOKBACK_DAYS). */
  staleDays?: number;
}

/**
 * Classify a customer by whole days since their last paid order:
 *   * `active` — ordered within `lapsedDays`,
 *   * `lapsed` — beyond `lapsedDays` but within `staleDays` (recoverable),
 *   * `stale`  — beyond `staleDays`, or never ordered (`null`).
 * Pure + total.
 */
export function classifyCustomerRecency(
  daysSinceLastPaidOrder: number | null,
  thresholds: CustomerRecencyThresholds = {},
): CustomerRecency {
  const lapsedDays = thresholds.lapsedDays ?? CUSTOMER_LAPSED_DAYS;
  const staleDays = thresholds.staleDays ?? CUSTOMER_ACTIVE_LOOKBACK_DAYS;
  if (daysSinceLastPaidOrder === null) return "stale";
  if (daysSinceLastPaidOrder <= lapsedDays) return "active";
  if (daysSinceLastPaidOrder <= staleDays) return "lapsed";
  return "stale";
}
