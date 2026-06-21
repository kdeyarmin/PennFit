// Shop return policy — pure windows + auto-approval rules (ADR 008: no I/O).
//
// Two related decisions for a customer return request, kept together
// because they share the "days since the order was paid" clock:
//
//   * COMFORT GUARANTEE — a return is only eligible at all within
//     COMFORT_GUARANTEE_DAYS of payment (the storefront's money-back
//     window). `isWithinComfortGuarantee` is the gate the request route
//     checks before accepting a return.
//
//   * AUTO-APPROVAL — within that window, two clear-cut patterns skip the
//     human queue (a defect reported in week 1, a wrong-item shipment in
//     the first month), unless a fraud cap or a high-value-order guard
//     applies. Everything else (fit, no-longer-needed, other, or the
//     clear-cut cases past their age) falls through to manual review.
//
// Pure: the route resolves `ageDays` and the prior-return count from the
// DB, then this module decides. Lives in the canonical domain package so
// the storefront SPA can show the same "you're within your guarantee /
// this will auto-approve" copy the API enforces.
//
// `ShopReturnReason` mirrors the DB enum; the API-side re-export keeps a
// compile-time assertion that the two stay in sync.

/** A return is eligible within this many days of `paid_at`. */
export const COMFORT_GUARANTEE_DAYS = 60;

/** Whether a return is still inside the comfort-guarantee window. */
export function isWithinComfortGuarantee(
  ageDays: number,
  windowDays: number = COMFORT_GUARANTEE_DAYS,
): boolean {
  return Number.isFinite(ageDays) && ageDays >= 0 && ageDays <= windowDays;
}

export type ShopReturnReason =
  | "fit"
  | "defective"
  | "wrong_item"
  | "no_longer_needed"
  | "other";

/**
 * Customers with this many or more approved returns in the trailing
 * 90 days fall through to manual review even if the reason+age
 * would have auto-approved.
 */
export const AUTO_APPROVE_PRIOR_RETURN_CAP = 3;

/** Defective claim must be within this many days of paidAt to auto-approve. */
export const AUTO_APPROVE_DEFECTIVE_MAX_AGE_DAYS = 7;

/** Wrong-item claim must be within this many days of paidAt to auto-approve. */
export const AUTO_APPROVE_WRONG_ITEM_MAX_AGE_DAYS = 30;

/**
 * Order value cap (USD cents) above which we ALWAYS route to manual
 * review regardless of reason or age. Auto-approval is a customer-
 * experience win on small consumables ($20-$80); on a high-value device
 * replacement ($500+) the multi-day human-review wait is cheaper than the
 * fraud exposure. Set to $500 — above any consumable resupply line, below
 * the smallest CPAP machine.
 */
export const AUTO_APPROVE_ORDER_VALUE_CAP_CENTS = 50_000;

/**
 * Stable rule identifier persisted into shop_returns.admin_note so an
 * auditor can grep for the exact rule that approved a row.
 */
export type AutoApprovalRule = "defective_within_7d" | "wrong_item_within_30d";

export interface AutoApprovalDecision {
  autoApprove: boolean;
  /** Set only when autoApprove === true. */
  rule: AutoApprovalRule | null;
}

export interface AutoApprovalInput {
  reason: ShopReturnReason;
  /** Days since the order was paid for. Fractional days are fine. */
  ageDays: number;
  /**
   * Count of this customer's PRIOR `approved` (or downstream) returns in
   * the trailing 90 days. The caller resolves this against shop_returns;
   * the rule layer just compares to the cap.
   */
  priorApprovedReturnsLast90d: number;
  /**
   * Order total in USD cents. When this exceeds
   * AUTO_APPROVE_ORDER_VALUE_CAP_CENTS the request routes to manual review
   * regardless of reason or age. Pass 0 when unknown — 0 never trips the
   * cap.
   */
  orderValueCents: number;
}

/**
 * Evaluate a return request against the auto-approval policy. Pure — no DB
 * access, no side effects. Caller resolves `priorApprovedReturnsLast90d`
 * and `ageDays` first.
 */
export function evaluateAutoApprovalRules(
  input: AutoApprovalInput,
): AutoApprovalDecision {
  // Fraud cap short-circuits everything else.
  if (input.priorApprovedReturnsLast90d >= AUTO_APPROVE_PRIOR_RETURN_CAP) {
    return { autoApprove: false, rule: null };
  }

  // High-value-order guard: a $500+ transaction always lands in the
  // human queue. Inclusive at the cap so "$500+ orders are queued"
  // matches the implementation.
  if (
    input.orderValueCents > 0 &&
    input.orderValueCents >= AUTO_APPROVE_ORDER_VALUE_CAP_CENTS
  ) {
    return { autoApprove: false, rule: null };
  }

  // Rule 1 — defective in the first week.
  if (
    input.reason === "defective" &&
    input.ageDays <= AUTO_APPROVE_DEFECTIVE_MAX_AGE_DAYS
  ) {
    return { autoApprove: true, rule: "defective_within_7d" };
  }

  // Rule 2 — wrong item within 30 days.
  if (
    input.reason === "wrong_item" &&
    input.ageDays <= AUTO_APPROVE_WRONG_ITEM_MAX_AGE_DAYS
  ) {
    return { autoApprove: true, rule: "wrong_item_within_30d" };
  }

  // Everything else — manual queue.
  return { autoApprove: false, rule: null };
}

/**
 * Compose the admin_note trace persisted with an auto-approved row.
 * Shape mirrors the human admin's note format so the audit trail reads
 * consistently regardless of whether a human or a rule made the decision.
 */
export function formatAutoApprovalNote(opts: {
  rule: AutoApprovalRule;
  nowIso: string;
}): string {
  return `[${opts.nowIso}] system — Auto-approved by rule: ${opts.rule}`;
}
