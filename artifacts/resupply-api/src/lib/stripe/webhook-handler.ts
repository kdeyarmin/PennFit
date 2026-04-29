// Stripe webhook handler — verifies signature, dispatches events to
// the local shop_orders mirror.
//
// Mounting contract (see app.ts):
//   * Route is /resupply-api/stripe/webhook.
//   * Body parser MUST be express.raw({type: "application/json"}) and
//     MUST be registered BEFORE express.json() — Stripe signature
//     verification is computed over the exact bytes Stripe sent, and
//     express.json mutates `req.body` to a parsed object that we
//     can't re-serialize byte-identically.
//   * Stripe's signing secret rotates independently of the API key,
//     so we re-read `STRIPE_WEBHOOK_SIGNING_SECRET` per-request via
//     readStripeConfigOrNull() rather than capturing it at boot.
//
// Error contract (Stripe-side):
//   * 200 = "got it, do not retry". We return 200 even for events we
//     don't care about (default branch) so Stripe stops re-delivering.
//   * 400 = "your signature/body is malformed". Stripe will retry
//     with exponential backoff, which is the right behaviour for a
//     genuine config error (we want noisy retries until we fix the
//     secret).
//   * 503 = "we know who you are but the shop isn't configured".
//     Returned only when Stripe sent a real signed payload but the
//     server itself is mid-outage. Stripe retries — exactly what we
//     want.
//
// We intentionally do NOT log the raw event body — Stripe events can
// contain customer email + shipping address, both of which are
// sensitive. We log event id + type + amount only.

import type { Request, RequestHandler, Response } from "express";
import { eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import type Stripe from "stripe";

import {
  getDbPool,
  shopCustomers,
  shopOrders,
  shopSubscriptions,
  type ShopSubscriptionItemSnapshot,
} from "@workspace/resupply-db";

import { getStripeClient, readStripeConfigOrNull, type StripeConfig } from "./config";
import { readDefaultPaymentMethod } from "./customer";
import { formatIntervalLabel } from "./products-meta";

export const stripeWebhookHandler: RequestHandler = async (
  req: Request,
  res: Response,
) => {
  const config = readStripeConfigOrNull();
  if (!config || !config.webhookSigningSecret) {
    req.log?.warn(
      { hasConfig: !!config },
      "stripe webhook hit while shop is not fully configured",
    );
    res.status(503).json({ error: "shop_unavailable" });
    return;
  }

  const signature = req.headers["stripe-signature"];
  if (typeof signature !== "string") {
    res.status(400).json({ error: "missing_stripe_signature" });
    return;
  }

  // express.raw gives us a Buffer here. constructEvent accepts both
  // Buffer and string; Buffer is preferred so we don't risk a
  // double-encode on platforms where the raw bytes aren't pure UTF-8
  // (Stripe payloads always are, but defence in depth is cheap).
  const rawBody = req.body;
  if (!Buffer.isBuffer(rawBody)) {
    req.log?.error(
      { bodyType: typeof rawBody },
      "stripe webhook: raw body was not a Buffer — body parser order is wrong",
    );
    res.status(400).json({ error: "raw_body_missing" });
    return;
  }

  const stripe = getStripeClient(config);
  let event: Stripe.Event;
  try {
    event = stripe.webhooks.constructEvent(
      rawBody,
      signature,
      config.webhookSigningSecret,
    );
  } catch (err) {
    // Returning 400 (not 401) is what Stripe's docs ask for — it's
    // their convention for "I refuse this delivery, try again".
    req.log?.warn(
      { err: err instanceof Error ? err.message : String(err) },
      "stripe webhook signature verification failed",
    );
    res.status(400).json({ error: "invalid_signature" });
    return;
  }

  const log = req.log?.child?.({ stripeEventId: event.id, type: event.type });

  try {
    switch (event.type) {
      case "checkout.session.completed":
      case "checkout.session.async_payment_succeeded": {
        const session = event.data.object as Stripe.Checkout.Session;
        await markPaid(session, log);
        // Best-effort sync of saved customer info. Failures here MUST
        // NOT throw out of the webhook — the order is paid; failing
        // to refresh "saved card last4" is recoverable on the next
        // /shop/me hit (which will re-pull from Stripe).
        try {
          await syncCustomerAfterCheckout(config, session, log);
        } catch (syncErr) {
          log?.warn?.(
            { err: syncErr instanceof Error ? syncErr.message : String(syncErr) },
            "stripe webhook: customer sync failed (non-fatal)",
          );
        }
        break;
      }
      case "checkout.session.expired": {
        const session = event.data.object as Stripe.Checkout.Session;
        await markStatus(session.id, "expired", log);
        break;
      }
      case "checkout.session.async_payment_failed": {
        const session = event.data.object as Stripe.Checkout.Session;
        await markStatus(session.id, "failed", log);
        break;
      }
      case "customer.subscription.created":
      case "customer.subscription.updated":
      case "customer.subscription.deleted": {
        // Subscribe & Save mirror. The patient-facing /account UI
        // reads from shop_subscriptions; Stripe stays the billing
        // source of truth. We upsert on stripe_subscription_id so
        // out-of-order delivery (created arriving after updated)
        // doesn't double-insert. The upsert is gated on
        // last_stripe_event_at so a replayed/late event can never
        // overwrite newer state — see upsertSubscription for the
        // ordering guard.
        const subscription = event.data.object as Stripe.Subscription;
        const eventCreatedAt = new Date(event.created * 1000);
        await upsertSubscription(subscription, eventCreatedAt, log);
        break;
      }
      case "charge.refunded": {
        // charge.refunded gives us a Charge, not a Session. Resolve
        // back to our row via payment_intent — that field is set on
        // the row by markPaid().
        const charge = event.data.object as Stripe.Charge;
        if (charge.payment_intent && typeof charge.payment_intent === "string") {
          await markStatusByPaymentIntent(
            charge.payment_intent,
            "refunded",
            log,
          );
        }
        break;
      }
      default: {
        // Ack everything else — Stripe may deliver many event types we
        // don't subscribe to in the dashboard, and we don't want it
        // to retry them just because we returned non-200.
        log?.debug?.("ignoring stripe event type");
        break;
      }
    }
  } catch (err) {
    log?.error?.(
      { err: err instanceof Error ? err.message : String(err) },
      "stripe webhook handler threw — Stripe will retry",
    );
    res.status(500).json({ error: "internal_error" });
    return;
  }

  res.status(200).json({ received: true });
};

async function markPaid(
  session: Stripe.Checkout.Session,
  log: { info?: (...args: unknown[]) => void } | undefined,
): Promise<void> {
  const db = drizzle(getDbPool());
  const paymentIntentId =
    typeof session.payment_intent === "string"
      ? session.payment_intent
      : session.payment_intent?.id ?? null;

  // Re-stamp clerk_user_id from session metadata. The route that
  // created this Session also wrote it locally — this is belt-and-
  // suspenders in case the local write was lost (crash mid-request,
  // sequencing issue, etc.).
  const clerkUserId =
    (typeof session.metadata?.clerk_user_id === "string" &&
      session.metadata.clerk_user_id) ||
    null;

  await db
    .update(shopOrders)
    .set({
      status: "paid",
      stripePaymentIntentId: paymentIntentId,
      amountTotalCents: session.amount_total ?? null,
      currency: session.currency ?? null,
      ...(clerkUserId ? { clerkUserId } : {}),
      paidAt: sql`now()`,
      updatedAt: sql`now()`,
    })
    .where(eq(shopOrders.stripeSessionId, session.id));

  log?.info?.(
    { amountCents: session.amount_total },
    "shop order marked paid",
  );
}

/**
 * Sync the buyer's saved card + shipping address back to
 * shop_customers so the next /shop/me render includes the freshly
 * saved details. Runs only when the Session has both a
 * `clerk_user_id` in metadata AND a `customer` attached.
 *
 * Order of operations:
 *   1. Best-effort: read the Customer's default payment method and
 *      persist its display crumbs (brand/last4/exp).
 *   2. Best-effort: persist Stripe's collected shipping_details as
 *      our default address — but only if the user doesn't already
 *      have one (don't clobber an explicit /shop/me edit with an
 *      auto-collected one).
 */
async function syncCustomerAfterCheckout(
  config: StripeConfig,
  session: Stripe.Checkout.Session,
  log: { info?: (...args: unknown[]) => void; warn?: (...args: unknown[]) => void } | undefined,
): Promise<void> {
  const clerkUserId =
    typeof session.metadata?.clerk_user_id === "string"
      ? session.metadata.clerk_user_id
      : null;
  const stripeCustomerId =
    typeof session.customer === "string"
      ? session.customer
      : session.customer?.id ?? null;
  if (!clerkUserId || !stripeCustomerId) return;

  const db = drizzle(getDbPool());

  const dpm = await readDefaultPaymentMethod(config, stripeCustomerId);
  const shipping =
    session.collected_information?.shipping_details ??
    (
      session as unknown as {
        shipping_details?: {
          address?: {
            line1?: string | null;
            line2?: string | null;
            city?: string | null;
            state?: string | null;
            postal_code?: string | null;
            country?: string | null;
          };
        };
      }
    ).shipping_details ??
    null;

  // Read existing row to decide whether to backfill the shipping
  // address (only when empty — never overwrite a deliberate edit).
  const existingRows = await db
    .select({
      shippingAddress: shopCustomers.shippingAddress,
      stripeCustomerId: shopCustomers.stripeCustomerId,
    })
    .from(shopCustomers)
    .where(eq(shopCustomers.clerkUserId, clerkUserId))
    .limit(1);
  const existing = existingRows[0];

  const shouldSetShipping =
    !!shipping?.address?.line1 &&
    !!shipping.address.city &&
    !!shipping.address.state &&
    !!shipping.address.postal_code &&
    (existing?.shippingAddress ?? null) === null;

  const updates: Partial<typeof shopCustomers.$inferInsert> & {
    updatedAt: Date;
  } = { updatedAt: new Date() };

  if (!existing?.stripeCustomerId) {
    updates.stripeCustomerId = stripeCustomerId;
  }
  if (dpm) {
    updates.defaultPaymentMethodId = dpm.id;
    updates.defaultPaymentMethodBrand = dpm.brand;
    updates.defaultPaymentMethodLast4 = dpm.last4;
    updates.defaultPaymentMethodExpMonth = dpm.expMonth;
    updates.defaultPaymentMethodExpYear = dpm.expYear;
  }
  if (shouldSetShipping && shipping?.address) {
    updates.shippingAddress = {
      line1: shipping.address.line1!,
      line2: shipping.address.line2 ?? null,
      city: shipping.address.city!,
      state: shipping.address.state!,
      postalCode: shipping.address.postal_code!,
      country: "US",
    };
  }

  // Upsert: handle the (rare) case where the row doesn't exist yet
  // because this user is checking out for the first time without
  // ever having loaded /shop/me.
  await db
    .insert(shopCustomers)
    .values({
      clerkUserId,
      stripeCustomerId,
      defaultPaymentMethodId: updates.defaultPaymentMethodId ?? null,
      defaultPaymentMethodBrand: updates.defaultPaymentMethodBrand ?? null,
      defaultPaymentMethodLast4: updates.defaultPaymentMethodLast4 ?? null,
      defaultPaymentMethodExpMonth: updates.defaultPaymentMethodExpMonth ?? null,
      defaultPaymentMethodExpYear: updates.defaultPaymentMethodExpYear ?? null,
      shippingAddress: updates.shippingAddress ?? null,
    })
    .onConflictDoUpdate({
      target: shopCustomers.clerkUserId,
      set: updates,
    });

  log?.info?.(
    {
      clerkUserId,
      hasCard: !!dpm,
      savedShipping: shouldSetShipping,
    },
    "shop customer synced after checkout",
  );
}

async function markStatus(
  sessionId: string,
  status: "expired" | "failed",
  log: { info?: (...args: unknown[]) => void } | undefined,
): Promise<void> {
  const db = drizzle(getDbPool());
  await db
    .update(shopOrders)
    .set({ status, updatedAt: sql`now()` })
    .where(eq(shopOrders.stripeSessionId, sessionId));
  log?.info?.({ status }, "shop order status updated");
}

/**
 * Upsert one customer.subscription.* event into shop_subscriptions.
 *
 * `clerk_user_id` is recovered from the subscription's metadata
 * (stamped at Session creation time in checkout.ts). If it's
 * missing — which can happen for legacy subscriptions or for events
 * Stripe emits without our prior context — we still insert the row
 * with a synthetic placeholder so we don't lose the Stripe-side
 * source of truth, but log a warning. The /shop/me/subscriptions
 * endpoint filters by clerk_user_id, so an unowned row won't
 * accidentally surface to the wrong patient.
 */
async function upsertSubscription(
  subscription: Stripe.Subscription,
  eventCreatedAt: Date,
  log: { info?: (...args: unknown[]) => void; warn?: (...args: unknown[]) => void } | undefined,
): Promise<void> {
  const db = drizzle(getDbPool());

  const clerkUserId =
    typeof subscription.metadata?.clerk_user_id === "string" &&
    subscription.metadata.clerk_user_id.length > 0
      ? subscription.metadata.clerk_user_id
      : null;
  if (!clerkUserId) {
    log?.warn?.(
      { subscriptionId: subscription.id },
      "stripe subscription event missing clerk_user_id metadata; storing with __unknown placeholder",
    );
  }

  const stripeCustomerId =
    typeof subscription.customer === "string"
      ? subscription.customer
      : subscription.customer?.id ?? null;

  // Snapshot line items for offline rendering on /account.
  const items: ShopSubscriptionItemSnapshot[] = subscription.items.data.map(
    (it) => {
      const price = it.price;
      const product = price.product;
      const productId = typeof product === "string" ? product : product?.id ?? null;
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
  const result = await db
    .insert(shopSubscriptions)
    .values({
      clerkUserId: clerkUserId ?? "__unknown",
      stripeSubscriptionId: subscription.id,
      stripeCustomerId,
      status: subscription.status,
      items,
      currentPeriodEnd,
      cancelAtPeriodEnd: subscription.cancel_at_period_end ?? false,
      canceledAt,
      initialAmountTotalCents: null,
      lastStripeEventAt: eventCreatedAt,
    })
    .onConflictDoUpdate({
      target: shopSubscriptions.stripeSubscriptionId,
      set: {
        // Don't overwrite a known clerk_user_id with __unknown — the
        // creation event always carries it; later updates may come
        // from system events (e.g. invoice retry) that may not.
        ...(clerkUserId ? { clerkUserId } : {}),
        stripeCustomerId,
        status: subscription.status,
        items,
        currentPeriodEnd,
        cancelAtPeriodEnd: subscription.cancel_at_period_end ?? false,
        canceledAt,
        lastStripeEventAt: eventCreatedAt,
        updatedAt: sql`now()`,
      },
      where: sql`${shopSubscriptions.lastStripeEventAt} IS NULL OR ${shopSubscriptions.lastStripeEventAt} <= ${eventCreatedAt}`,
    })
    .returning({ id: shopSubscriptions.id });

  if (result.length === 0) {
    log?.warn?.(
      {
        subscriptionId: subscription.id,
        status: subscription.status,
        eventCreatedAt: eventCreatedAt.toISOString(),
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

async function markStatusByPaymentIntent(
  paymentIntentId: string,
  status: "refunded",
  log: { info?: (...args: unknown[]) => void } | undefined,
): Promise<void> {
  const db = drizzle(getDbPool());
  await db
    .update(shopOrders)
    .set({ status, updatedAt: sql`now()` })
    .where(eq(shopOrders.stripePaymentIntentId, paymentIntentId));
  log?.info?.({ status }, "shop order marked refunded");
}
