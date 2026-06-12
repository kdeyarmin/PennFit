// customer.subscription.* event family — Subscribe & Save mirror.
//
// The patient-facing /account UI reads from shop_subscriptions; Stripe
// stays the billing source of truth. We upsert on
// stripe_subscription_id so out-of-order delivery (created arriving
// after updated) doesn't double-insert. The upsert is gated on
// last_stripe_event_at so a replayed/late event can never overwrite
// newer state — see upsertSubscription for the ordering guard.

import type Stripe from "stripe";

import {
  getSupabaseServiceRoleClient,
  type Database,
  type Json,
  type ShopSubscriptionItemSnapshot,
} from "@workspace/resupply-db";

import { formatIntervalLabel } from "../products-meta";
import { readCustomerIdFromMetadata } from "./shared";

type ShopSubscriptionUpdate =
  Database["resupply"]["Tables"]["shop_subscriptions"]["Update"];

/**
 * Handle one customer.subscription.created / .updated / .deleted
 * event: extract the Subscription object + the event's created time
 * (which drives the ordering guard) and run the mirror upsert.
 */
export async function handleSubscriptionEvent(
  event: Stripe.Event,
  log:
    | {
        info?: (...args: unknown[]) => void;
        warn?: (...args: unknown[]) => void;
      }
    | undefined,
): Promise<void> {
  const subscription = event.data.object as Stripe.Subscription;
  const eventCreatedAt = new Date(event.created * 1000);
  await upsertSubscription(subscription, eventCreatedAt, log);
}

/**
 * Upsert one customer.subscription.* event into shop_subscriptions.
 *
 * The shop customer id is recovered from the subscription's
 * metadata (stamped at Session creation time in checkout.ts).
 * If it's missing — which can happen for legacy subscriptions or
 * for events Stripe emits without our prior context — we DROP the
 * event (no DB write) and log a warning. Operators can backfill from
 * Stripe by event id if the subscription is genuinely ours.
 *
 * (We intentionally do not write a synthetic placeholder customer_id.)
 */
async function upsertSubscription(
  subscription: Stripe.Subscription,
  eventCreatedAt: Date,
  log:
    | {
        info?: (...args: unknown[]) => void;
        warn?: (...args: unknown[]) => void;
      }
    | undefined,
): Promise<void> {
  const supabase = getSupabaseServiceRoleClient();

  const customerId = readCustomerIdFromMetadata(subscription.metadata);
  if (!customerId) {
    // Previously this branch stored the row with `customer_id =
    // "__unknown"`. That collides across unrelated subscriptions
    // that all share the sentinel value, and lets an admin query
    // on `customer_id = "__unknown"` return cross-tenant data.
    // Drop the row entirely instead — surfacing the missing-
    // metadata case loudly in logs is more useful than a poisoned
    // shop_subscriptions table. Operators can backfill from Stripe
    // by event id if the subscription is genuinely ours.
    log?.warn?.(
      {
        subscriptionId: subscription.id,
        stripeCustomerId: subscription.customer,
      },
      "stripe subscription event missing customer_id metadata — dropping (no synthetic placeholder)",
    );
    return;
  }

  const stripeCustomerId =
    typeof subscription.customer === "string"
      ? subscription.customer
      : (subscription.customer?.id ?? null);

  // Snapshot line items for offline rendering on /account.
  const items: ShopSubscriptionItemSnapshot[] = subscription.items.data.map(
    (it) => {
      const price = it.price;
      const product = price.product;
      const productId =
        typeof product === "string" ? product : (product?.id ?? null);
      const productName =
        typeof product === "object" && product && !product.deleted
          ? product.name
          : null;
      const interval = price.recurring?.interval ?? null;
      const intervalCount = price.recurring?.interval_count ?? null;
      return {
        priceId: price.id,
        productId,
        quantity: it.quantity ?? 1,
        name: productName,
        unitAmountCents: price.unit_amount ?? null,
        currency: price.currency ?? null,
        intervalLabel:
          interval && intervalCount
            ? formatIntervalLabel(
                interval as "day" | "week" | "month" | "year",
                intervalCount,
              )
            : null,
      };
    },
  );

  // Stripe stores billing-period boundaries on each subscription
  // item (since 2025-11-05 the top-level current_period_end was
  // moved to per-item). Take the earliest item period_end so the
  // /account UI can render "next ship" honestly when an item ships
  // sooner than its siblings.
  const periodEndUnix = subscription.items.data.reduce<number | null>(
    (acc, it) => {
      const value = (it as unknown as { current_period_end?: number | null })
        .current_period_end;
      if (typeof value !== "number") return acc;
      if (acc === null) return value;
      return Math.min(acc, value);
    },
    null,
  );
  const currentPeriodEnd =
    periodEndUnix !== null ? new Date(periodEndUnix * 1000) : null;

  const canceledAt =
    typeof subscription.canceled_at === "number"
      ? new Date(subscription.canceled_at * 1000)
      : null;

  // Out-of-order / replay protection: only update when the incoming
  // event is at least as new as the last one we applied. Stripe can
  // legally re-deliver any event for up to 30 days, so a stale
  // `created` arriving after a real `deleted` would otherwise revive
  // a canceled subscription in our mirror. The first event for a
  // given subscription always wins (last_stripe_event_at IS NULL).
  // We compare on `event.created` (seconds-resolution Unix time);
  // ties allow the write through so a same-second cluster updates
  // monotonically.
  //
  // PostgREST has no `ON CONFLICT DO UPDATE WHERE`, so we attempt the
  // INSERT first; on 23505 we fall back to a conditional UPDATE
  // guarded by `last_stripe_event_at IS NULL OR <= eventCreatedAt`.
  const eventCreatedAtIso = eventCreatedAt.toISOString();
  const periodEndIso = currentPeriodEnd ? currentPeriodEnd.toISOString() : null;
  const canceledAtIso = canceledAt ? canceledAt.toISOString() : null;
  const itemsJson = items as unknown as Json;

  const { error: insertErr } = await supabase
    .schema("resupply")
    .from("shop_subscriptions")
    .insert({
      customer_id: customerId,
      stripe_subscription_id: subscription.id,
      stripe_customer_id: stripeCustomerId,
      status: subscription.status,
      items: itemsJson,
      current_period_end: periodEndIso,
      cancel_at_period_end: subscription.cancel_at_period_end ?? false,
      canceled_at: canceledAtIso,
      initial_amount_total_cents: null,
      last_stripe_event_at: eventCreatedAtIso,
    });
  if (!insertErr) {
    log?.info?.(
      {
        subscriptionId: subscription.id,
        status: subscription.status,
        cancelAtPeriodEnd: subscription.cancel_at_period_end,
      },
      "shop_subscriptions upserted",
    );
    return;
  }
  if ((insertErr as { code?: string }).code !== "23505") {
    throw insertErr;
  }

  // Conflict — conditional UPDATE with the ordering guard.
  const update: ShopSubscriptionUpdate = {
    stripe_customer_id: stripeCustomerId,
    status: subscription.status,
    items: itemsJson,
    current_period_end: periodEndIso,
    cancel_at_period_end: subscription.cancel_at_period_end ?? false,
    canceled_at: canceledAtIso,
    last_stripe_event_at: eventCreatedAtIso,
    updated_at: new Date().toISOString(),
  };
  // customerId is guaranteed non-null here (we return early when missing).
  update.customer_id = customerId;
  const { data: updated, error: updateErr } = await supabase
    .schema("resupply")
    .from("shop_subscriptions")
    .update(update)
    .eq("stripe_subscription_id", subscription.id)
    .or(
      `last_stripe_event_at.is.null,last_stripe_event_at.lte.${eventCreatedAtIso}`,
    )
    .select("id");
  if (updateErr) throw updateErr;

  if (!updated || updated.length === 0) {
    log?.warn?.(
      {
        subscriptionId: subscription.id,
        status: subscription.status,
        eventCreatedAt: eventCreatedAtIso,
      },
      "shop_subscriptions upsert skipped — stale or replayed event",
    );
    return;
  }

  log?.info?.(
    {
      subscriptionId: subscription.id,
      status: subscription.status,
      cancelAtPeriodEnd: subscription.cancel_at_period_end,
    },
    "shop_subscriptions upserted",
  );
}
