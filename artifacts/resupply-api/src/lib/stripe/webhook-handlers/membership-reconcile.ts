// Cash-pay membership reconciliation from customer.subscription.* events.
//
// shop_customers.membership_tier (+ renewal stamp + linked Stripe
// subscription id) is set by a CSR via /admin/shop/customers/:id/membership
// and gives the patient member pricing/perks. But until now NOTHING cleared
// it when the backing Stripe subscription was canceled or lapsed — so a
// customer kept their paid tier (and its discounts) forever after they
// stopped paying. This is the revenue-protection half of the membership
// feature the shop_subscriptions mirror never covered (that mirror keys off
// metadata for the /account UI; membership subscriptions can be created
// out-of-band and carry no metadata, so we key off the subscription id
// stored on the shop_customers row instead).
//
//   * terminal status (canceled / unpaid / incomplete_expired) or the
//     `customer.subscription.deleted` event  -> downgrade to "payg", clear
//     the renewal stamp + the subscription link.
//   * active / trialing  -> refresh membership_renews_at from the period end.
//
// Idempotent: downgrade clears the subscription link, so a replayed
// `deleted` (Stripe re-delivers for up to 30 days) finds no matching row and
// no-ops — and a re-subscribe that points the row at a NEW subscription id is
// never clobbered by a stale event for the OLD one. The caller wraps this in
// a try/catch so a reconcile failure never fails the shop_subscriptions
// mirror or the webhook ACK. PHI/log posture: logs customer + subscription
// ids only, never names or contact info.

import type Stripe from "stripe";

import { getOrgScopedClient } from "@workspace/resupply-db";

import { isPaidMembershipTier } from "../membership-config";
import { resolveWebhookOrgId } from "../webhook-org-context";
import { readCustomerIdFromMetadata } from "./shared";

type SubscriptionLogger =
  | {
      info?: (...args: unknown[]) => void;
      warn?: (...args: unknown[]) => void;
    }
  | undefined;

// A subscription in any of these states is no longer collecting money, so the
// membership perks it backed must end.
const TERMINAL_STATUSES = new Set<Stripe.Subscription.Status>([
  "canceled",
  "unpaid",
  "incomplete_expired",
]);

// Stripe moved the billing-period boundary onto each subscription item (since
// 2025-11-05). Take the earliest item period_end so the renewal date is
// honest when items roll on different schedules.
function earliestPeriodEndIso(
  subscription: Stripe.Subscription,
): string | null {
  const unix = subscription.items.data.reduce<number | null>((acc, it) => {
    const value = (it as unknown as { current_period_end?: number | null })
      .current_period_end;
    if (typeof value !== "number") return acc;
    if (acc === null) return value;
    return Math.min(acc, value);
  }, null);
  return unix !== null ? new Date(unix * 1000).toISOString() : null;
}

/**
 * Reconcile a customer's cash-pay membership against the state of the Stripe
 * subscription that backs it. No-op (no DB write) when the subscription id
 * isn't linked to any shop_customers row — i.e. it's a Subscribe & Save or
 * unrelated subscription, not a membership.
 */
export async function reconcileMembershipFromSubscription(
  subscription: Stripe.Subscription,
  isDeletedEvent: boolean,
  log: SubscriptionLogger,
): Promise<void> {
  const orgId = await resolveWebhookOrgId();
  if (!orgId) return;
  const supabase = getOrgScopedClient(orgId);

  const { data: customer, error } = await supabase
    .from("shop_customers")
    .select("customer_id, membership_tier")
    .eq("membership_stripe_subscription_id", subscription.id)
    .limit(1)
    .maybeSingle();
  // Not a membership subscription we track (or a transient read error — the
  // caller's fail-soft wrapper logs it).
  if (error) throw error;
  if (!customer) return;

  const nowIso = new Date().toISOString();
  const terminal = isDeletedEvent || TERMINAL_STATUSES.has(subscription.status);

  if (terminal) {
    const { error: updErr } = await supabase
      .from("shop_customers")
      .update({
        membership_tier: "payg",
        membership_renews_at: null,
        membership_stripe_subscription_id: null,
        updated_at: nowIso,
      })
      .eq("customer_id", customer.customer_id)
      // Concurrency/idempotency guard: only clear the row still pointing at
      // THIS subscription.
      .eq("membership_stripe_subscription_id", subscription.id);
    if (updErr) throw updErr;
    log?.info?.(
      {
        customerId: customer.customer_id,
        subscriptionId: subscription.id,
        status: subscription.status,
      },
      "membership downgraded to payg — backing subscription ended",
    );
    return;
  }

  if (subscription.status === "active" || subscription.status === "trialing") {
    const renewsAt = earliestPeriodEndIso(subscription);
    if (!renewsAt) return;
    const { error: updErr } = await supabase
      .from("shop_customers")
      .update({ membership_renews_at: renewsAt, updated_at: nowIso })
      .eq("customer_id", customer.customer_id)
      .eq("membership_stripe_subscription_id", subscription.id);
    if (updErr) throw updErr;
    log?.info?.(
      {
        customerId: customer.customer_id,
        subscriptionId: subscription.id,
        renewsAt,
      },
      "membership renewal date refreshed from subscription period",
    );
  }
}

/**
 * Set a customer's membership tier from a SELF-SERVE join subscription —
 * the complement to reconcileMembershipFromSubscription's
 * downgrade-on-cancel. The storefront membership-checkout route stamps
 * `subscription_data.metadata = { customer_id, membership_tier }`; once the
 * subscription goes active/trialing we set the tier + link it on the
 * shop_customers row (keyed by the metadata customer_id, since the row isn't
 * linked to this subscription yet). No-op for non-membership subscriptions
 * (no membership_tier metadata) and for non-active states (the cancel/lapse
 * path is owned by reconcileMembershipFromSubscription).
 *
 * Idempotent: re-delivery re-writes the same tier + link; membership_started_at
 * is preserved if already set, so a replay never resets the join date.
 */
export async function joinMembershipFromSubscription(
  subscription: Stripe.Subscription,
  log: SubscriptionLogger,
): Promise<void> {
  const tier = subscription.metadata?.membership_tier;
  if (!isPaidMembershipTier(tier)) return;
  if (subscription.status !== "active" && subscription.status !== "trialing") {
    return;
  }
  const customerId = readCustomerIdFromMetadata(subscription.metadata);
  if (!customerId) return;

  const orgId = await resolveWebhookOrgId();
  if (!orgId) return;
  const supabase = getOrgScopedClient(orgId);

  // Preserve an existing join date (idempotent replay) — read first.
  const { data: existing, error } = await supabase
    .from("shop_customers")
    .select("customer_id, membership_started_at")
    .eq("customer_id", customerId)
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  if (!existing) return; // unknown customer — drop (no synthetic row)

  const nowIso = new Date().toISOString();
  const { error: updErr } = await supabase
    .from("shop_customers")
    .update({
      membership_tier: tier,
      membership_stripe_subscription_id: subscription.id,
      membership_started_at: existing.membership_started_at ?? nowIso,
      membership_renews_at: earliestPeriodEndIso(subscription),
      updated_at: nowIso,
    })
    .eq("customer_id", customerId);
  if (updErr) throw updErr;
  log?.info?.(
    { customerId, subscriptionId: subscription.id, tier },
    "membership tier set from self-serve join",
  );
}
