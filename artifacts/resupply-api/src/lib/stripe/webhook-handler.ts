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
import { and, eq, isNull, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import type Stripe from "stripe";

import {
  getDbPool,
  shopCustomers,
  shopAbandonedCarts,
  shopOrders,
  shopOrderItems,
  shopSubscriptions,
  type InsertShopOrderItemRow,
  type ShopSubscriptionItemSnapshot,
} from "@workspace/resupply-db";

import type { SavedShippingAddress } from "@workspace/resupply-db";

import { getStripeClient, readStripeConfigOrNull, type StripeConfig } from "./config";
import { readDefaultPaymentMethod } from "./customer";
import { formatIntervalLabel } from "./products-meta";
import {
  sendOrderConfirmationEmail,
  type OrderConfirmationLineItem,
} from "../order-emails/send-order-confirmation-email";

/**
 * Pull our shop-customer id out of Stripe metadata. The mapping
 * lives under `metadata.customer_id` for every Session / Subscription /
 * Customer this codebase creates. Returns null when the key is
 * absent or empty.
 */
function readCustomerIdFromMetadata(
  meta: Stripe.Metadata | null | undefined,
): string | null {
  if (!meta) return null;
  if (typeof meta.customer_id === "string" && meta.customer_id) {
    return meta.customer_id;
  }
  return null;
}

/**
 * Extract a shipping address from a Checkout Session into our
 * canonical SavedShippingAddress shape, or return null if the
 * session didn't collect one (or collected an obviously incomplete
 * address — e.g. line1 missing).
 *
 * Why we tolerate two different field locations:
 *   - The current Stripe API returns shipping under
 *     `session.collected_information.shipping_details`.
 *   - Older / legacy events delivered it directly at
 *     `session.shipping_details`.
 *   Stripe's TS types only surface the former; we cast for the
 *   latter so a re-delivery from a webhook backlog still parses.
 *
 * Why we always write country: "US":
 *   The shop is US-only by current product policy. Stripe will only
 *   ever return a US address (we restrict at Checkout config time).
 *   Hardcoding the literal here matches the SavedShippingAddress
 *   `country: "US"` literal type so consumers never have to guard.
 */
export function extractShippingAddressFromSession(
  session: Stripe.Checkout.Session,
): SavedShippingAddress | null {
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
  const addr = shipping?.address;
  // Required-field gate — a half-filled address (e.g. only line1) is
  // worse than none, because the customer-facing UI would render the
  // partial value as if it were authoritative.
  if (!addr?.line1 || !addr.city || !addr.state || !addr.postal_code) {
    return null;
  }
  return {
    line1: addr.line1,
    line2: addr.line2 ?? null,
    city: addr.city,
    state: addr.state,
    postalCode: addr.postal_code,
    country: "US",
  };
}

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
        const paidRow = await markPaid(session, log);
        // Best-effort: mirror the session's line items into
        // shop_order_items so the verified-purchaser badge and the
        // /shop/me/orders history page can render without a per-row
        // Stripe round-trip. Idempotent via the
        // (stripe_session_id, product_id, price_id) UNIQUE — a Stripe
        // re-delivery (or the async_payment_succeeded shadow on the
        // same session) inserts zero new rows. Failures MUST NOT
        // throw out of the webhook — the parent order is already
        // paid; the badge degrades gracefully if the items are
        // missing (one re-delivery later it'll fill in).
        let emailItems: OrderConfirmationLineItem[] = [];
        if (paidRow) {
          try {
            emailItems = await upsertOrderItemsFromSession(
              config,
              session,
              paidRow,
              log,
            );
          } catch (itemsErr) {
            log?.warn?.(
              {
                err:
                  itemsErr instanceof Error
                    ? itemsErr.message
                    : String(itemsErr),
              },
              "stripe webhook: shop_order_items upsert failed (non-fatal)",
            );
          }
        }
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
        // Best-effort: mark the matching abandoned-cart row as
        // recovered so the dispatcher never nudges someone who
        // already converted. Failures here MUST NOT throw out of
        // the webhook — the order is paid and that's what matters.
        try {
          await markCartRecovered(session, log);
        } catch (recErr) {
          log?.warn?.(
            { err: recErr instanceof Error ? recErr.message : String(recErr) },
            "stripe webhook: cart recovery mark failed (non-fatal)",
          );
        }
        // Best-effort: send the order confirmation email. Idempotent
        // via shop_orders.confirmation_email_sent_at — a Stripe re-
        // delivery (or the async_payment_succeeded shadow on the same
        // session) sees the timestamp set and short-circuits.
        // Failures here MUST NOT throw out of the webhook —
        // SendGrid being temporarily down (or unconfigured) must not
        // cause Stripe to retry the entire webhook, which would
        // re-fire markPaid and the customer-sync side-effects.
        if (paidRow) {
          try {
            await sendOrderConfirmationIfFirst({
              session,
              paidOrderId: paidRow.id,
              items: emailItems,
              log,
            });
          } catch (emailErr) {
            log?.warn?.(
              {
                err:
                  emailErr instanceof Error
                    ? emailErr.message
                    : String(emailErr),
              },
              "stripe webhook: order confirmation email failed (non-fatal)",
            );
          }
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

interface PaidOrderRow {
  id: string;
  customerId: string | null;
  paidAt: Date;
}

async function markPaid(
  session: Stripe.Checkout.Session,
  log: { info?: (...args: unknown[]) => void } | undefined,
): Promise<PaidOrderRow | null> {
  const db = drizzle(getDbPool());
  const paymentIntentId =
    typeof session.payment_intent === "string"
      ? session.payment_intent
      : session.payment_intent?.id ?? null;

  // Re-stamp customer_id from session metadata. The route that
  // created this Session also wrote it locally — this is belt-and-
  // suspenders in case the local write was lost (crash mid-request,
  // sequencing issue, etc.).
  const customerId = readCustomerIdFromMetadata(session.metadata);

  // Per-order shipping address snapshot (W3 T-C7). Reading from the
  // session at paid-time captures the address-as-shipped, which is
  // the right semantics for the customer-facing order history and
  // the admin tracking workflow — even if the shop_customers default
  // address is later edited. Falls back to null when the session
  // didn't collect shipping (shipping-disabled SKUs, etc); the
  // admin "edit address" endpoint can fill it in later.
  const shippingAddress = extractShippingAddressFromSession(session);

  // Capture the buyer's email at paid-time. Lower-cased to match the
  // shop_customers.email_lower convention used elsewhere. We persist
  // this on the order row (rather than chasing the Stripe Session
  // again at admin-shipping time) so guest checkouts can still
  // receive shipping notifications. See migration 0017.
  const sessionEmailRaw = session.customer_details?.email?.trim();
  const customerEmail = sessionEmailRaw ? sessionEmailRaw.toLowerCase() : null;

  // Returning the row so the line-item upsert downstream can copy
  // (orderId, customerId, paidAt) without a second SELECT.
  const updated = await db
    .update(shopOrders)
    .set({
      status: "paid",
      stripePaymentIntentId: paymentIntentId,
      amountTotalCents: session.amount_total ?? null,
      currency: session.currency ?? null,
      ...(customerId ? { customerId } : {}),
      // Only write the snapshot if Stripe actually gave us one.
      // Skipping the key on null preserves any later admin edit on
      // a Stripe re-delivery (charge.refunded → no shipping_details).
      ...(shippingAddress ? { shippingAddress } : {}),
      // Same posture for customer_email: only write when present.
      ...(customerEmail ? { customerEmail } : {}),
      paidAt: sql`now()`,
      updatedAt: sql`now()`,
    })
    .where(eq(shopOrders.stripeSessionId, session.id))
    .returning({
      id: shopOrders.id,
      customerId: shopOrders.customerId,
      paidAt: shopOrders.paidAt,
    });

  log?.info?.(
    { amountCents: session.amount_total },
    "shop order marked paid",
  );

  const row = updated[0];
  if (!row) return null;
  return {
    id: row.id,
    customerId: row.customerId,
    // paidAt was just set to now() above and is non-null on the
    // returned row.
    paidAt: row.paidAt ?? new Date(),
  };
}

/**
 * Mirror the line items on a paid Checkout Session into
 * shop_order_items so the verified-purchaser badge and the
 * /shop/me/orders history page can answer "did this user buy this
 * product?" with one indexed lookup instead of N Stripe round-trips.
 *
 * One Stripe API call per webhook invocation (listLineItems with
 * expand=data.price.product). The parent shop_orders row already has
 * status='paid' by the time we run, so even if this fails the order
 * is fully recognised; missing items just cause the verified pill
 * not to show until a Stripe re-delivery (or a manual replay) fills
 * them in.
 *
 * Idempotent: the (stripe_session_id, product_id, price_id) UNIQUE
 * + onConflictDoNothing absorbs both Stripe re-deliveries AND the
 * checkout.session.completed/async_payment_succeeded twin firing
 * for the same session.
 */
async function upsertOrderItemsFromSession(
  config: StripeConfig,
  session: Stripe.Checkout.Session,
  order: PaidOrderRow,
  log:
    | { info?: (...args: unknown[]) => void; warn?: (...args: unknown[]) => void }
    | undefined,
): Promise<OrderConfirmationLineItem[]> {
  const stripe = getStripeClient(config);
  const lineItems = await stripe.checkout.sessions.listLineItems(session.id, {
    limit: 100,
    expand: ["data.price.product"],
  });

  const rows: InsertShopOrderItemRow[] = [];
  // Built alongside `rows` so the email can reuse the line items we
  // just paid Stripe a single round-trip to fetch — instead of
  // making the same expanded listLineItems call again from the email
  // helper. Product names are deliberately NOT mirrored into
  // shop_order_items (see schema comment), so the email path picks
  // them up here from the live Stripe catalog rendering.
  const emailItems: OrderConfirmationLineItem[] = [];
  for (const li of lineItems.data) {
    const price = li.price ?? null;
    const product = price?.product ?? null;
    const productId =
      typeof product === "string"
        ? product
        : product && !product.deleted
          ? product.id
          : null;
    if (!productId) {
      // No way to attribute this row to a product — skip rather than
      // insert an opaque entry that the verified-purchaser join can't
      // use. Recoverable: a future enrichment job can backfill.
      continue;
    }
    rows.push({
      orderId: order.id,
      stripeSessionId: session.id,
      customerId: order.customerId,
      productId,
      // Use '' (not null) so the (stripe_session_id, product_id,
      // price_id) UNIQUE actually dedupes redeliveries — Postgres
      // UNIQUE treats NULLs as distinct. Schema enforces NOT NULL
      // with default '' (migration 0011).
      priceId: price?.id ?? "",
      quantity: li.quantity ?? 1,
      unitAmountCents: price?.unit_amount ?? null,
      currency: price?.currency ?? null,
      paidAt: order.paidAt,
    });

    // Stripe gives us a description on the LineItem itself (matches
    // what the customer saw in Hosted Checkout). Fall back to the
    // expanded product name if for some reason description is empty.
    const productName =
      product && typeof product === "object" && !product.deleted
        ? product.name
        : null;
    const displayName = li.description?.trim() || productName?.trim() || "Item";
    emailItems.push({
      name: displayName,
      quantity: li.quantity ?? 1,
      unitAmountCents: price?.unit_amount ?? 0,
      currency: price?.currency ?? "usd",
    });
  }

  if (rows.length === 0) {
    log?.info?.(
      { sessionId: session.id },
      "stripe webhook: no insertable line items for session",
    );
    return emailItems;
  }

  const db = drizzle(getDbPool());
  await db.insert(shopOrderItems).values(rows).onConflictDoNothing({
    // Match the UNIQUE we declared in the migration. We name the
    // target columns rather than the index so a future index rename
    // doesn't silently disable the dedupe.
    target: [
      shopOrderItems.stripeSessionId,
      shopOrderItems.productId,
      shopOrderItems.priceId,
    ],
  });

  log?.info?.(
    { sessionId: session.id, count: rows.length },
    "shop_order_items upserted",
  );
  return emailItems;
}

/**
 * Sync the buyer's saved card + shipping address back to
 * shop_customers so the next /shop/me render includes the freshly
 * saved details. Runs only when the Session has both a
 * `customer_id` in metadata AND a `customer` attached.
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
  const customerId = readCustomerIdFromMetadata(session.metadata);
  const stripeCustomerId =
    typeof session.customer === "string"
      ? session.customer
      : session.customer?.id ?? null;
  if (!customerId || !stripeCustomerId) return;

  const db = drizzle(getDbPool());

  const dpm = await readDefaultPaymentMethod(config, stripeCustomerId);
  const shippingAddress = extractShippingAddressFromSession(session);

  // Read existing row to decide whether to backfill the shipping
  // address (only when empty — never overwrite a deliberate edit).
  const existingRows = await db
    .select({
      shippingAddress: shopCustomers.shippingAddress,
      stripeCustomerId: shopCustomers.stripeCustomerId,
    })
    .from(shopCustomers)
    .where(eq(shopCustomers.customerId, customerId))
    .limit(1);
  const existing = existingRows[0];

  const shouldSetShipping =
    shippingAddress !== null && (existing?.shippingAddress ?? null) === null;

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
  if (shouldSetShipping && shippingAddress) {
    updates.shippingAddress = shippingAddress;
  }

  // Upsert: handle the (rare) case where the row doesn't exist yet
  // because this user is checking out for the first time without
  // ever having loaded /shop/me.
  await db
    .insert(shopCustomers)
    .values({
      customerId,
      stripeCustomerId,
      defaultPaymentMethodId: updates.defaultPaymentMethodId ?? null,
      defaultPaymentMethodBrand: updates.defaultPaymentMethodBrand ?? null,
      defaultPaymentMethodLast4: updates.defaultPaymentMethodLast4 ?? null,
      defaultPaymentMethodExpMonth: updates.defaultPaymentMethodExpMonth ?? null,
      defaultPaymentMethodExpYear: updates.defaultPaymentMethodExpYear ?? null,
      shippingAddress: updates.shippingAddress ?? null,
    })
    .onConflictDoUpdate({
      target: shopCustomers.customerId,
      set: updates,
    });

  log?.info?.(
    {
      customerId,
      hasCard: !!dpm,
      savedShipping: shouldSetShipping,
    },
    "shop customer synced after checkout",
  );
}

/**
 * Mark the abandoned-cart row for this auth user as recovered so the
 * dispatcher never nudges a customer who already converted. Called
 * from `checkout.session.completed`.
 *
 * Idempotent and safe to call when no row exists — the WHERE clause
 * filters on `recovered_at IS NULL` so a double-fire from Stripe (the
 * "completed" + "async_payment_succeeded" pair both flow through the
 * same case) is a no-op the second time. We zero out items and
 * subtotal so a stale items list cannot leak into a future "we
 * restored your cart from the email" rehydration after the purchase.
 *
 * Guest checkouts (no `customer_id` in session metadata) are a
 * no-op — there's no abandoned-cart row to update because guests
 * never write one.
 */
export async function markCartRecovered(
  session: Stripe.Checkout.Session,
  log:
    | { info?: (...args: unknown[]) => void; warn?: (...args: unknown[]) => void }
    | undefined,
): Promise<void> {
  const customerId = readCustomerIdFromMetadata(session.metadata);
  if (!customerId) return;
  const db = drizzle(getDbPool());
  const updated = await db
    .update(shopAbandonedCarts)
    .set({
      recoveredAt: new Date(),
      items: [],
      subtotalCents: 0,
      updatedAt: new Date(),
    })
    .where(
      sql`${shopAbandonedCarts.customerId} = ${customerId} AND ${shopAbandonedCarts.recoveredAt} IS NULL`,
    )
    .returning({ id: shopAbandonedCarts.id });
  if (updated.length > 0) {
    log?.info?.(
      { customerId, rowId: updated[0]!.id },
      "abandoned cart marked recovered",
    );
  }
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
 * The shop customer id is recovered from the subscription's
 * metadata (stamped at Session creation time in checkout.ts).
 * If it's missing — which can happen for legacy subscriptions or
 * for events Stripe emits without our prior context — we still
 * insert the row with a synthetic placeholder so we don't lose
 * the Stripe-side source of truth, but log a warning. The
 * /shop/me/subscriptions endpoint filters by customer_id, so an
 * unowned row won't accidentally surface to the wrong patient.
 */
async function upsertSubscription(
  subscription: Stripe.Subscription,
  eventCreatedAt: Date,
  log: { info?: (...args: unknown[]) => void; warn?: (...args: unknown[]) => void } | undefined,
): Promise<void> {
  const db = drizzle(getDbPool());

  const customerId = readCustomerIdFromMetadata(subscription.metadata);
  if (!customerId) {
    log?.warn?.(
      { subscriptionId: subscription.id },
      "stripe subscription event missing customer_id metadata; storing with __unknown placeholder",
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
      customerId: customerId ?? "__unknown",
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
        // Don't overwrite a known customer_id with __unknown — the
        // creation event always carries it; later updates may come
        // from system events (e.g. invoice retry) that may not.
        ...(customerId ? { customerId } : {}),
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

/**
 * Send the post-purchase confirmation email exactly once per order.
 *
 * Called after `markPaid` + `upsertOrderItemsFromSession` in the
 * checkout-completed branch. Idempotency is enforced by an ATOMIC
 * CLAIM on `shop_orders.confirmation_email_sent_at`:
 *   1. `UPDATE … SET confirmation_email_sent_at = now() WHERE id = $1
 *      AND confirmation_email_sent_at IS NULL RETURNING …` — only
 *      one worker can win the row even if Stripe fires
 *      `checkout.session.completed` and
 *      `checkout.session.async_payment_succeeded` concurrently.
 *   2. If no row was returned, another worker already claimed the
 *      send (or it was previously sent); short-circuit.
 *   3. If we won the claim, resolve recipient (linked
 *      `shop_customers.email_lower` joined on `customer_id`,
 *      falling back to `session.customer_details.email` for guests),
 *      render, and send.
 *   4. ON SEND FAILURE, RELEASE THE CLAIM by writing
 *      `confirmation_email_sent_at = NULL` so a Stripe re-delivery
 *      (or manual replay) can retry — preserving the at-most-once
 *      *successful* send while still allowing one retry per failure.
 *
 * Errors are swallowed — the caller wraps in try/catch as a second
 * line of defence. SendGrid being misconfigured or returning a 5xx
 * must NOT cause Stripe to retry the entire webhook (which would
 * re-fire markPaid + the customer/cart sync side-effects).
 */
export async function sendOrderConfirmationIfFirst(args: {
  session: Stripe.Checkout.Session;
  paidOrderId: string;
  items: readonly OrderConfirmationLineItem[];
  log:
    | { info?: (...args: unknown[]) => void; warn?: (...args: unknown[]) => void }
    | undefined;
}): Promise<{ skipped: true; reason: string } | { skipped: false; delivered: boolean }> {
  const { session, paidOrderId, items, log } = args;
  const db = drizzle(getDbPool());

  // Atomic claim: stamp the timestamp ONLY if it is currently NULL.
  // The RETURNING gives back the canonical row fields the email needs
  // (avoiding a separate SELECT). If `claimed` is undefined either
  // (a) the row doesn't exist or (b) another worker already stamped.
  // Both are "skip" outcomes for this send.
  const claimedRows = await db
    .update(shopOrders)
    .set({ confirmationEmailSentAt: sql`now()`, updatedAt: sql`now()` })
    .where(
      and(
        eq(shopOrders.id, paidOrderId),
        isNull(shopOrders.confirmationEmailSentAt),
      ),
    )
    .returning({
      id: shopOrders.id,
      stripeSessionId: shopOrders.stripeSessionId,
      customerId: shopOrders.customerId,
      amountTotalCents: shopOrders.amountTotalCents,
      currency: shopOrders.currency,
      shippingAddress: shopOrders.shippingAddress,
      customerEmail: shopOrders.customerEmail,
    });
  const claimed = claimedRows[0];

  if (!claimed) {
    log?.info?.(
      { orderId: paidOrderId },
      "order confirmation email skipped — already sent or row missing",
    );
    return { skipped: true, reason: "already_sent_or_missing" };
  }

  // From here on, ANY failure path MUST release the claim by writing
  // confirmation_email_sent_at = NULL so a future redelivery can retry.
  // Idempotent: safe to call multiple times (sets stamp back to NULL).
  // The outer try/catch below guarantees release on ANY thrown error
  // anywhere in the post-claim block — including transient DB errors
  // during the customer lookup — so a transient failure can never
  // permanently lock out the email.
  const releaseClaim = async (): Promise<void> => {
    try {
      await db
        .update(shopOrders)
        .set({ confirmationEmailSentAt: null, updatedAt: sql`now()` })
        .where(eq(shopOrders.id, claimed.id));
    } catch (releaseErr) {
      log?.warn?.(
        {
          orderId: claimed.id,
          err: releaseErr instanceof Error ? releaseErr.message : String(releaseErr),
        },
        "order confirmation email claim release failed",
      );
    }
  };

  try {
    // Recipient resolution: linked customer first, persisted
    // `customer_email` (captured at paid-time) next, Stripe Session
    // fallback last. We never log any of these values.
    let toEmail: string | null = null;
    if (claimed.customerId) {
      const [cust] = await db
        .select({ email: shopCustomers.emailLower })
        .from(shopCustomers)
        .where(eq(shopCustomers.customerId, claimed.customerId))
        .limit(1);
      if (cust?.email) toEmail = cust.email;
    }
    if (!toEmail && claimed.customerEmail) {
      toEmail = claimed.customerEmail;
    }
    if (!toEmail) {
      const sessionEmail = session.customer_details?.email?.trim();
      if (sessionEmail) toEmail = sessionEmail.toLowerCase();
    }
    if (!toEmail) {
      await releaseClaim();
      log?.warn?.(
        { orderId: claimed.id },
        "order confirmation email skipped — no recipient on file",
      );
      return { skipped: true, reason: "no_email_on_file" };
    }

    const result = await sendOrderConfirmationEmail({
      toEmail,
      stripeSessionId: claimed.stripeSessionId,
      items,
      amountTotalCents: claimed.amountTotalCents ?? session.amount_total ?? 0,
      currency: claimed.currency ?? session.currency ?? "usd",
      shippingAddress: claimed.shippingAddress ?? null,
    });

    if (!result.configured) {
      await releaseClaim();
      log?.info?.(
        { orderId: claimed.id },
        "order confirmation email skipped — sendgrid not configured",
      );
      return { skipped: true, reason: "not_configured" };
    }
    if (!result.delivered) {
      await releaseClaim();
      log?.warn?.(
        { orderId: claimed.id, error: result.error },
        "order confirmation email send failed (non-fatal, claim released)",
      );
      return { skipped: false, delivered: false };
    }

    log?.info?.(
      { orderId: claimed.id, messageId: result.messageId ?? null },
      "order confirmation email delivered",
    );
    return { skipped: false, delivered: true };
  } catch (err) {
    // Catch-all: ANY uncaught error after the claim acquisition
    // (transient DB read failure, unexpected throw inside the email
    // helper, etc.) must release the claim so the next webhook
    // redelivery can retry — otherwise a single transient failure
    // would permanently suppress the confirmation email.
    await releaseClaim();
    log?.warn?.(
      { orderId: claimed.id, err: err instanceof Error ? err.message : String(err) },
      "order confirmation email post-claim threw (non-fatal, claim released)",
    );
    return { skipped: false, delivered: false };
  }
}
