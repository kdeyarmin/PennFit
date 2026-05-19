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
import { z } from "zod";
import type Stripe from "stripe";

import { logAudit } from "@workspace/resupply-audit";
import {
  getSupabaseServiceRoleClient,
  type Database,
  type Json,
  type ShopSubscriptionItemSnapshot,
} from "@workspace/resupply-db";

import type { SavedShippingAddress } from "@workspace/resupply-db";

type ShopOrderUpdate =
  Database["resupply"]["Tables"]["shop_orders"]["Update"];
type ShopOrderItemInsert =
  Database["resupply"]["Tables"]["shop_order_items"]["Insert"];
type ShopCustomerInsert =
  Database["resupply"]["Tables"]["shop_customers"]["Insert"];
type ShopCustomerUpdate =
  Database["resupply"]["Tables"]["shop_customers"]["Update"];
type ShopSubscriptionUpdate =
  Database["resupply"]["Tables"]["shop_subscriptions"]["Update"];

import {
  getStripeClient,
  readStripeConfigOrNull,
  type StripeConfig,
} from "./config";
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
 * Zod schema for the legacy `session.shipping_details` field shape.
 * This fallback exists for older/backlogged Stripe webhook events
 * that predate `collected_information.shipping_details`. The schema
 * replaces the prior `as unknown as {...}` cast so a structural
 * change on Stripe's side surfaces as a parse failure (null address)
 * rather than silently propagating undefined field access.
 */
const LegacyShippingDetailsSchema = z
  .object({
    shipping_details: z
      .object({
        address: z
          .object({
            line1: z.string().nullable().optional(),
            line2: z.string().nullable().optional(),
            city: z.string().nullable().optional(),
            state: z.string().nullable().optional(),
            postal_code: z.string().nullable().optional(),
            country: z.string().nullable().optional(),
          })
          .optional(),
      })
      .optional(),
  })
  .passthrough();

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
 *   Stripe's TS types only surface the former; we validate the
 *   latter through Zod so a Stripe-side rename surfaces as null
 *   (graceful degradation) instead of a runtime crash.
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
  const primary = session.collected_information?.shipping_details;
  const legacyParsed = LegacyShippingDetailsSchema.safeParse(session);
  const legacy = legacyParsed.success
    ? legacyParsed.data.shipping_details
    : undefined;
  const shipping = primary ?? legacy ?? null;
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
            {
              err: syncErr instanceof Error ? syncErr.message : String(syncErr),
            },
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
        // the row by markPaid(). Stripe may deliver payment_intent as
        // either a string id or an expanded PaymentIntent object
        // depending on event version / API expansion settings.
        const charge = event.data.object as Stripe.Charge;
        const paymentIntentId =
          typeof charge.payment_intent === "string"
            ? charge.payment_intent
            : (charge.payment_intent?.id ?? null);
        if (paymentIntentId) {
          // Capture the structured "why" so audit consumers can answer
          // "was this admin-initiated, customer-initiated, fraud-flagged,
          // or duplicate?" without re-fetching from Stripe. Stripe's
          // canonical refund reasons are: duplicate, fraudulent,
          // requested_by_customer; null/undefined = no reason supplied
          // (typically admin-initiated through the dashboard with no
          // dropdown selection).
          const lastRefund = charge.refunds?.data?.[0];
          await markStatusByPaymentIntent(paymentIntentId, "refunded", {
            chargeId: charge.id,
            stripeEventId: event.id,
            // amount_refunded is cumulative — captures partial refunds
            // and re-refunds within the same charge correctly.
            amountRefundedCents: charge.amount_refunded,
            currency: charge.currency,
            // `reason` is per-refund; the latest refund's reason is
            // the most informative one for the audit row.
            refundReason: lastRefund?.reason ?? null,
            refundId: lastRefund?.id ?? null,
            log,
          });
        }
        break;
      }
      case "payment_intent.succeeded":
      case "payment_intent.payment_failed":
      case "payment_intent.canceled": {
        // Patient self-pay flow (resupply.patient_payments). We
        // identify our row via metadata.patient_payment_id — set by
        // createPaymentIntent() in lib/billing/patient-payment.ts.
        // Stripe payments related to shop_orders flow through the
        // checkout.session.* events above; this branch is dedicated
        // to portal balance payments.
        const intent = event.data.object as Stripe.PaymentIntent;
        const patientPaymentId =
          typeof intent.metadata?.patient_payment_id === "string"
            ? intent.metadata.patient_payment_id
            : null;
        if (!patientPaymentId) {
          // Not one of ours — ack and move on.
          break;
        }
        const status =
          event.type === "payment_intent.succeeded"
            ? "succeeded"
            : event.type === "payment_intent.canceled"
              ? "cancelled"
              : "failed";
        const failureReason =
          event.type === "payment_intent.payment_failed"
            ? (intent.last_payment_error?.message ?? "payment failed")
            : null;
        const { markPaymentStatus } = await import(
          "../billing/patient-payment.js"
        );
        await markPaymentStatus({
          paymentId: patientPaymentId,
          status,
          failureReason,
        });
        log?.info?.({ patientPaymentId, status }, "patient_payment: status updated by webhook");
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
    // Capture full structured error context so a 500 here is debuggable
    // without re-running the failing event. `err` itself goes through
    // pino's default serializer (stack + cause). Stripe SDK errors
    // additionally expose statusCode / code / requestId / type / raw —
    // we surface those explicitly so an ops grep on `stripe_request_id`
    // pivots from our logs into the Stripe Dashboard. event.id and
    // event.type are already on `log`'s child context (see above).
    const stripeMeta =
      err && typeof err === "object"
        ? {
            stripe_status_code: (err as { statusCode?: unknown }).statusCode,
            stripe_code: (err as { code?: unknown }).code,
            stripe_request_id: (err as { requestId?: unknown }).requestId,
            stripe_error_type: (err as { type?: unknown }).type,
          }
        : undefined;
    log?.error?.(
      { err, ...stripeMeta },
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
  const supabase = getSupabaseServiceRoleClient();
  const paymentIntentId =
    typeof session.payment_intent === "string"
      ? session.payment_intent
      : (session.payment_intent?.id ?? null);

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

  const nowIso = new Date().toISOString();
  const update: ShopOrderUpdate = {
    status: "paid",
    stripe_payment_intent_id: paymentIntentId,
    amount_total_cents: session.amount_total ?? null,
    currency: session.currency ?? null,
    paid_at: nowIso,
    updated_at: nowIso,
  };
  if (customerId) update.customer_id = customerId;
  // Only write the snapshot if Stripe actually gave us one. Skipping
  // the key on null preserves any later admin edit on a Stripe
  // re-delivery (charge.refunded → no shipping_details).
  if (shippingAddress) {
    update.shipping_address_json = shippingAddress as unknown as Json;
  }
  if (customerEmail) update.customer_email = customerEmail;

  const { data: rows, error } = await supabase
    .schema("resupply")
    .from("shop_orders")
    .update(update)
    .eq("stripe_session_id", session.id)
    .select("id, customer_id, paid_at");
  if (error) throw error;

  log?.info?.({ amountCents: session.amount_total }, "shop order marked paid");

  const row = rows?.[0];
  if (!row) return null;
  return {
    id: row.id,
    customerId: row.customer_id,
    // paid_at was just set to nowIso above and is non-null on the
    // returned row.
    paidAt: row.paid_at ? new Date(row.paid_at) : new Date(),
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
    | {
        info?: (...args: unknown[]) => void;
        warn?: (...args: unknown[]) => void;
      }
    | undefined,
): Promise<OrderConfirmationLineItem[]> {
  const stripe = getStripeClient(config);
  const lineItems = await stripe.checkout.sessions.listLineItems(session.id, {
    limit: 100,
    expand: ["data.price.product"],
  });

  const rows: ShopOrderItemInsert[] = [];
  // Built alongside `rows` so the email can reuse the line items we
  // just paid Stripe a single round-trip to fetch — instead of
  // making the same expanded listLineItems call again from the email
  // helper. Product names are deliberately NOT mirrored into
  // shop_order_items (see schema comment), so the email path picks
  // them up here from the live Stripe catalog rendering.
  const emailItems: OrderConfirmationLineItem[] = [];
  const paidAtIso = order.paidAt.toISOString();
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
      order_id: order.id,
      stripe_session_id: session.id,
      customer_id: order.customerId,
      product_id: productId,
      // Use '' (not null) so the (stripe_session_id, product_id,
      // price_id) UNIQUE actually dedupes redeliveries — Postgres
      // UNIQUE treats NULLs as distinct. Schema enforces NOT NULL
      // with default '' (migration 0011).
      price_id: price?.id ?? "",
      quantity: li.quantity ?? 1,
      unit_amount_cents: price?.unit_amount ?? null,
      currency: price?.currency ?? null,
      paid_at: paidAtIso,
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

  const supabase = getSupabaseServiceRoleClient();
  // ON CONFLICT DO NOTHING for the (stripe_session_id, product_id,
  // price_id) UNIQUE — supabase-js exposes this as upsert with
  // ignoreDuplicates: true.
  const { error } = await supabase
    .schema("resupply")
    .from("shop_order_items")
    .upsert(rows, {
      onConflict: "stripe_session_id,product_id,price_id",
      ignoreDuplicates: true,
    });
  if (error) throw error;

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
  log:
    | {
        info?: (...args: unknown[]) => void;
        warn?: (...args: unknown[]) => void;
      }
    | undefined,
): Promise<void> {
  const customerId = readCustomerIdFromMetadata(session.metadata);
  const stripeCustomerId =
    typeof session.customer === "string"
      ? session.customer
      : (session.customer?.id ?? null);
  if (!customerId || !stripeCustomerId) return;

  const supabase = getSupabaseServiceRoleClient();

  const dpm = await readDefaultPaymentMethod(config, stripeCustomerId);
  const shippingAddress = extractShippingAddressFromSession(session);

  // Read existing row to decide whether to backfill the shipping
  // address (only when empty — never overwrite a deliberate edit).
  const { data: existing, error: selectErr } = await supabase
    .schema("resupply")
    .from("shop_customers")
    .select("shipping_address_json, stripe_customer_id")
    .eq("customer_id", customerId)
    .maybeSingle();
  if (selectErr) throw selectErr;

  const shouldSetShipping =
    shippingAddress !== null &&
    (existing?.shipping_address_json ?? null) === null;

  const nowIso = new Date().toISOString();

  if (!existing) {
    // First-time row — INSERT with the full snapshot. Use upsert with
    // onConflict: customer_id so a concurrent inserter (e.g. another
    // webhook redelivery) folds into UPDATE rather than 23505-throwing.
    const insertRow: ShopCustomerInsert = {
      customer_id: customerId,
      stripe_customer_id: stripeCustomerId,
      default_payment_method_id: dpm?.id ?? null,
      default_payment_method_brand: dpm?.brand ?? null,
      default_payment_method_last4: dpm?.last4 ?? null,
      default_payment_method_exp_month: dpm?.expMonth ?? null,
      default_payment_method_exp_year: dpm?.expYear ?? null,
      shipping_address_json: shippingAddress
        ? (shippingAddress as unknown as Json)
        : null,
      updated_at: nowIso,
    };
    const { error: insertErr } = await supabase
      .schema("resupply")
      .from("shop_customers")
      .upsert(insertRow, { onConflict: "customer_id" });
    if (insertErr) throw insertErr;
  } else {
    // Existing row — partial UPDATE. Only set keys we have values for,
    // and only set shipping_address_json when the existing one is null
    // (preserves explicit /shop/me edits).
    const updates: ShopCustomerUpdate = { updated_at: nowIso };
    if (!existing.stripe_customer_id) {
      updates.stripe_customer_id = stripeCustomerId;
    }
    if (dpm) {
      updates.default_payment_method_id = dpm.id;
      updates.default_payment_method_brand = dpm.brand;
      updates.default_payment_method_last4 = dpm.last4;
      updates.default_payment_method_exp_month = dpm.expMonth;
      updates.default_payment_method_exp_year = dpm.expYear;
    }
    if (shouldSetShipping && shippingAddress) {
      updates.shipping_address_json = shippingAddress as unknown as Json;
    }
    const { error: updateErr } = await supabase
      .schema("resupply")
      .from("shop_customers")
      .update(updates)
      .eq("customer_id", customerId);
    if (updateErr) throw updateErr;
  }

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
    | {
        info?: (...args: unknown[]) => void;
        warn?: (...args: unknown[]) => void;
      }
    | undefined,
): Promise<void> {
  const customerId = readCustomerIdFromMetadata(session.metadata);
  if (!customerId) return;
  const supabase = getSupabaseServiceRoleClient();
  const nowIso = new Date().toISOString();
  const { data: updated, error } = await supabase
    .schema("resupply")
    .from("shop_abandoned_carts")
    .update({
      recovered_at: nowIso,
      items: [] as unknown as Json,
      subtotal_cents: 0,
      updated_at: nowIso,
    })
    .eq("customer_id", customerId)
    .is("recovered_at", null)
    .select("id");
  if (error) throw error;
  if (updated && updated.length > 0) {
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
  const supabase = getSupabaseServiceRoleClient();
  const { error } = await supabase
    .schema("resupply")
    .from("shop_orders")
    .update({ status, updated_at: new Date().toISOString() })
    .eq("stripe_session_id", sessionId);
  if (error) throw error;
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
    log?.warn?.(
      { subscriptionId: subscription.id },
      "stripe subscription event missing customer_id metadata; storing with __unknown placeholder",
    );
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
  const periodEndIso = currentPeriodEnd
    ? currentPeriodEnd.toISOString()
    : null;
  const canceledAtIso = canceledAt ? canceledAt.toISOString() : null;
  const itemsJson = items as unknown as Json;

  const { error: insertErr } = await supabase
    .schema("resupply")
    .from("shop_subscriptions")
    .insert({
      customer_id: customerId ?? "__unknown",
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
  // Don't overwrite a known customer_id with __unknown — the creation
  // event always carries it; later updates may come from system
  // events (e.g. invoice retry) that may not.
  if (customerId) update.customer_id = customerId;

  const { data: updated, error: updateErr } = await supabase
    .schema("resupply")
    .from("shop_subscriptions")
    .update(update)
    .eq("stripe_subscription_id", subscription.id)
    .or(`last_stripe_event_at.is.null,last_stripe_event_at.lte.${eventCreatedAtIso}`)
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

async function markStatusByPaymentIntent(
  paymentIntentId: string,
  status: "refunded",
  ctx: {
    chargeId: string;
    stripeEventId: string;
    amountRefundedCents: number;
    currency: string | null;
    refundReason: string | null;
    refundId: string | null;
    log: { info?: (...args: unknown[]) => void } | undefined;
  },
): Promise<void> {
  const supabase = getSupabaseServiceRoleClient();
  // RETURNING the affected row so we can stamp the audit with the
  // local order id and short-circuit the audit write if the update
  // matched nothing (Stripe re-deliveries on a missing row, etc.).
  const { data: updated, error } = await supabase
    .schema("resupply")
    .from("shop_orders")
    .update({ status, updated_at: new Date().toISOString() })
    .eq("stripe_payment_intent_id", paymentIntentId)
    .select("id, customer_id");
  if (error) throw error;
  ctx.log?.info?.(
    { status, matched: updated?.length ?? 0 },
    "shop order marked refunded",
  );
  if (!updated || updated.length === 0) return;

  // Audit row carries the structured "why" so admins can later answer
  // questions like "how many refunds last month were customer-
  // requested vs fraud-flagged" without re-querying Stripe.
  // Metadata is intentionally non-PHI: amounts, currency, Stripe
  // identifiers, and the canonical refund reason — no email, no
  // shipping address, no card details.
  for (const row of updated) {
    try {
      await logAudit({
        action: "shop_order.refunded",
        targetTable: "shop_orders",
        targetId: row.id,
        adminEmail: "system:webhook:stripe",
        adminUserId: null,
        metadata: {
          stripe_event_id: ctx.stripeEventId,
          stripe_charge_id: ctx.chargeId,
          stripe_refund_id: ctx.refundId,
          stripe_payment_intent_id: paymentIntentId,
          amount_refunded_cents: ctx.amountRefundedCents,
          currency: ctx.currency,
          refund_reason: ctx.refundReason,
          customer_id: row.customer_id,
        },
      });
    } catch (err) {
      // Audit write failures are non-fatal — the DB status update is
      // the source of truth. Log so we can find systemic audit
      // outages, but don't 500 the webhook (Stripe would retry
      // forever on transient audit DB issues).
      const pgCode =
        typeof err === "object" &&
        err !== null &&
        "code" in err &&
        typeof err.code === "string"
          ? err.code
          : null;
      ctx.log?.info?.(
        {
          event: "refund_audit_failed",
          errName: err instanceof Error ? err.name : typeof err,
          pgCode,
          ...(err instanceof Error ? { err } : {}),
          stripeEventId: ctx.stripeEventId,
        },
        "refund audit write failed",
      );
    }
  }
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
    | {
        info?: (...args: unknown[]) => void;
        warn?: (...args: unknown[]) => void;
      }
    | undefined;
}): Promise<
  { skipped: true; reason: string } | { skipped: false; delivered: boolean }
> {
  const { session, paidOrderId, items, log } = args;
  const supabase = getSupabaseServiceRoleClient();

  // Atomic claim: stamp the timestamp ONLY if it is currently NULL.
  // The RETURNING gives back the canonical row fields the email needs
  // (avoiding a separate SELECT). If `claimed` is undefined either
  // (a) the row doesn't exist or (b) another worker already stamped.
  // Both are "skip" outcomes for this send.
  const nowIso = new Date().toISOString();
  const { data: claimedRows, error: claimErr } = await supabase
    .schema("resupply")
    .from("shop_orders")
    .update({
      confirmation_email_sent_at: nowIso,
      updated_at: nowIso,
    })
    .eq("id", paidOrderId)
    .is("confirmation_email_sent_at", null)
    .select(
      "id, stripe_session_id, customer_id, amount_total_cents, currency, shipping_address_json, customer_email",
    );
  if (claimErr) throw claimErr;
  const claimed = claimedRows?.[0];

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
      const { error: releaseErr } = await supabase
        .schema("resupply")
        .from("shop_orders")
        .update({
          confirmation_email_sent_at: null,
          updated_at: new Date().toISOString(),
        })
        .eq("id", claimed.id);
      if (releaseErr) throw releaseErr;
    } catch (releaseErr) {
      log?.warn?.(
        {
          orderId: claimed.id,
          err:
            releaseErr instanceof Error
              ? releaseErr.message
              : String(releaseErr),
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
    if (claimed.customer_id) {
      const { data: cust, error: custErr } = await supabase
        .schema("resupply")
        .from("shop_customers")
        .select("email_lower")
        .eq("customer_id", claimed.customer_id)
        .maybeSingle();
      if (custErr) throw custErr;
      if (cust?.email_lower) toEmail = cust.email_lower;
    }
    if (!toEmail && claimed.customer_email) {
      toEmail = claimed.customer_email;
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
      stripeSessionId: claimed.stripe_session_id,
      items,
      amountTotalCents:
        claimed.amount_total_cents ?? session.amount_total ?? 0,
      currency: claimed.currency ?? session.currency ?? "usd",
      shippingAddress:
        (claimed.shipping_address_json as unknown as SavedShippingAddress | null) ??
        null,
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
      {
        orderId: claimed.id,
        err: err instanceof Error ? err.message : String(err),
      },
      "order confirmation email post-claim threw (non-fatal, claim released)",
    );
    return { skipped: false, delivered: false };
  }
}
