// Rule layer for auto-approving customer return requests (A4).
//
// Before this layer, every POST /shop/me/orders/:sessionId/returns
// landed in the `requested` queue waiting for human review. The
// historical queue contained two very different populations:
//
//   * Clear-cut cases — defects in week 1, wrong-item shipments
//     (our fulfillment error). These get human-approved ~100% of
//     the time, with the only delay being how long the admin took
//     to click. Auto-approving them eliminates a multi-day wait
//     for the patient.
//
//   * Judgment cases — fit complaints, "no longer needed", "other".
//     These DO need a human eye because the resolution (refund vs.
//     exchange, restocking fee, replacement) depends on context the
//     rules can't read.
//
// This file owns the policy boundary between the two. The route at
// artifacts/resupply-api/src/routes/shop/my-returns.ts evaluates a
// new request against `evaluateAutoApprovalRules()` and, when the
// decision is `{ autoApprove: true }`, INSERTs the row with
// `status="approved"` + `approved_at=now()` so the patient sees an
// approved return immediately. The admin UI still lists the row in
// the normal `approved` filter; the `admin_note` carries the rule
// name so an auditor can see exactly why the system approved it
// without a human signature.
//
// Conservative scope (v1)
// -----------------------
// We auto-approve exactly two patterns:
//
//   1. reason = "defective" AND age <= 7 days from paid_at.
//      Defects manifest fast. A customer reporting one in the
//      first week is almost certainly genuine; we'd rather take a
//      false positive here than make a real customer wait.
//
//   2. reason = "wrong_item" AND age <= 30 days from paid_at.
//      Shipping the wrong product is our fulfillment error. The
//      patient shouldn't have to wait for a human to confirm we
//      messed up.
//
// Everything else — fit, no_longer_needed, other, OR defective>7d,
// OR wrong_item>30d — falls through to manual review. The route
// still INSERTs with `status="requested"` and the existing admin
// approve/reject flow handles them.
//
// Fraud cap
// ---------
// A customer with >= AUTO_APPROVE_PRIOR_RETURN_CAP approved returns
// in the last 90 days does NOT get auto-approved regardless of
// reason. This catches the pathological pattern of returning every
// purchase; the human queue can ask "what's going on here?". The
// cap is intentionally generous (3) so a genuine string of bad
// luck doesn't trip it.

import type { ShopReturnReason } from "@workspace/resupply-db";

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
 * Stable rule identifier persisted into shop_returns.admin_note so an
 * auditor can grep for the exact rule that approved a row. Keep
 * machine-readable — admin UI may special-case display later.
 */
export type AutoApprovalRule =
  | "defective_within_7d"
  | "wrong_item_within_30d";

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
   * Count of this customer's PRIOR `approved` (or downstream:
   * shipped_back / received / refunded / replaced) returns in the
   * trailing 90 days. The caller resolves this against
   * shop_returns; the rule layer just compares to the cap.
   */
  priorApprovedReturnsLast90d: number;
}

/**
 * Evaluate a return request against the auto-approval policy. Pure
 * function — no DB access, no side effects. Caller is responsible
 * for resolving `priorApprovedReturnsLast90d` and `ageDays` before
 * calling.
 *
 * Returns:
 *   * `{ autoApprove: true,  rule: "defective_within_7d" | ... }`
 *     — INSERT with status="approved" + approved_at=now().
 *   * `{ autoApprove: false, rule: null }`
 *     — INSERT with status="requested" (the existing path).
 */
export function evaluateAutoApprovalRules(
  input: AutoApprovalInput,
): AutoApprovalDecision {
  // Fraud cap short-circuits everything else.
  if (input.priorApprovedReturnsLast90d >= AUTO_APPROVE_PRIOR_RETURN_CAP) {
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
 * Shape mirrors the human admin's `appendNote()` ("[<iso>] <admin> —
 * <action>: <note>") so the audit trail in the column reads
 * consistently regardless of whether a human or a rule made the
 * decision.
 */
export function formatAutoApprovalNote(opts: {
  rule: AutoApprovalRule;
  nowIso: string;
}): string {
  return `[${opts.nowIso}] system — Auto-approved by rule: ${opts.rule}`;
}
