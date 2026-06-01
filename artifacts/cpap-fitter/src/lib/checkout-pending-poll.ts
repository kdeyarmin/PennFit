// Pure decision logic for the /shop/checkout-success page's bounded
// re-poll while a Stripe charge is still settling (webhook lag can leave
// the session reading back as not-yet-paid for a few seconds after the
// customer lands). Kept in its own module — free of React/DOM imports —
// so the decision can be unit tested directly.

export const PENDING_POLL_INTERVAL_MS = 3_000;
// ~5 tries × 3s ≈ 15s of self-healing before we fall back to asking the
// customer to check the Stripe receipt email / refresh. Bounded so a
// genuinely failed charge never polls forever.
export const MAX_PENDING_POLLS = 5;

/**
 * Decide whether the checkout-success page should schedule another
 * order-summary fetch. Returns true only while the charge is still
 * pending, an order is loaded, the initial fetch has finished, and we
 * are under the attempt cap.
 */
export function shouldPollPendingPayment(args: {
  loading: boolean;
  hasOrder: boolean;
  paymentStatus: string | null | undefined;
  pollCount: number;
}): boolean {
  const { loading, hasOrder, paymentStatus, pollCount } = args;
  // Initial fetch still in flight — let it land first.
  if (loading) return false;
  // Error state (no order resolved) — nothing to re-poll.
  if (!hasOrder) return false;
  // Already settled — stop.
  if (paymentStatus === "paid") return false;
  // Bounded: give the webhook a handful of tries, then stop.
  return pollCount < MAX_PENDING_POLLS;
}
