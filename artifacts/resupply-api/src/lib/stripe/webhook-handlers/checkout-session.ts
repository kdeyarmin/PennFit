// checkout.session.* event family — helpers for the Stripe webhook
// handler's checkout-session branches.
//
// Owns the side-effect steps the `checkout.session.completed` /
// `checkout.session.async_payment_succeeded` orchestration (which
// stays in webhook-handler.ts, next to the dispatch switch) stitches
// together, plus the terminal-status writes for
// `checkout.session.expired` / `checkout.session.async_payment_failed`:
//
//   * authorizePaymentPlanAutopay — mode=setup payment-plan autopay
//   * markPaid                    — shop_orders paid upsert
//   * upsertOrderItemsFromSession — shop_order_items mirror + email items
//   * syncCustomerAfterCheckout   — shop_customers card/address/phone sync
//   * markCartRecovered           — abandoned-cart recovery stamp
//   * markStatus                  — pending → expired | failed transitions
//
// The order-confirmation email step (`sendOrderConfirmationIfFirst`)
// deliberately stays in webhook-handler.ts — see the note there.
//
// PHI posture: same as the parent handler — we never log email,
// shipping address, or card details; only ids, counts and amounts.

import type Stripe from "stripe";

import {
  getSupabaseServiceRoleClient,
  type Database,
  type Json,
} from "@workspace/resupply-db";
import { normalizeE164 } from "@workspace/resupply-domain";

import { getStripeClient, type StripeConfig } from "../config";
import { readDefaultPaymentMethod } from "../customer";
import type { OrderConfirmationLineItem } from "../../order-emails/send-order-confirmation-email";
import {
  fetchUnitCostsBySku,
  stampUnitCostSnapshots,
} from "../../billing/product-cost-lookup";
import {
  extractShippingAddressFromSession,
  readCustomerIdFromMetadata,
} from "./shared";

type ShopOrderUpdate = Database["resupply"]["Tables"]["shop_orders"]["Update"];
type ShopOrderItemInsert =
  Database["resupply"]["Tables"]["shop_order_items"]["Insert"];
type ShopCustomerInsert =
  Database["resupply"]["Tables"]["shop_customers"]["Insert"];
type ShopCustomerUpdate =
  Database["resupply"]["Tables"]["shop_customers"]["Update"];

/**
 * Complete a payment-plan autopay authorization (mode=setup Checkout).
 * Stores the Stripe customer + the mandated payment method on the plan
 * and flips autopay_status='authorized'. The payment method is read from
 * the session's SetupIntent. Idempotent — re-delivery re-writes the same
 * values. Storing a card off-session here is what later lets the
 * autocharge worker debit it (still gated by the seeded-OFF flag + cron).
 */
export async function authorizePaymentPlanAutopay(
  config: StripeConfig,
  session: Stripe.Checkout.Session,
  log: { info?: (...args: unknown[]) => void } | undefined,
): Promise<void> {
  const planId = session.metadata?.payment_plan_id;
  if (!planId) return;
  const customerId =
    typeof session.customer === "string"
      ? session.customer
      : (session.customer?.id ?? null);

  // Resolve the payment method from the SetupIntent.
  const stripe = getStripeClient(config);
  const setupIntentId =
    typeof session.setup_intent === "string"
      ? session.setup_intent
      : (session.setup_intent?.id ?? null);
  let paymentMethodId: string | null = null;
  if (setupIntentId) {
    const si = await stripe.setupIntents.retrieve(setupIntentId);
    paymentMethodId =
      typeof si.payment_method === "string"
        ? si.payment_method
        : (si.payment_method?.id ?? null);
  }
  if (!customerId || !paymentMethodId) {
    log?.info?.(
      {
        planId,
        hasCustomer: Boolean(customerId),
        hasPm: Boolean(paymentMethodId),
      },
      "stripe webhook: autopay setup completed but customer/PM missing — not authorizing",
    );
    return;
  }

  const supabase = getSupabaseServiceRoleClient();
  const { error } = await supabase
    .schema("resupply")
    .from("patient_payment_plans")
    .update({
      autopay_status: "authorized",
      stripe_customer_id: customerId,
      stripe_payment_method_id: paymentMethodId,
      autopay_authorized_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq("id", planId);
  if (error) throw error;
  log?.info?.({ planId }, "stripe webhook: payment-plan autopay authorized");
}

export interface PaidOrderRow {
  id: string;
  customerId: string | null;
  paidAt: Date;
}

export async function markPaid(
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

  // Fulfillment method + pickup location, set by routes/shop/checkout.ts
  // into the session metadata. Default to 'ship' for any older session
  // (pre-pickup) or one missing the field. A 'pickup' order never
  // collected a shipping address (checkout omits the prompt), so the
  // snapshot below stays null and the order runs the pickup lifecycle.
  const fulfillmentMethod =
    session.metadata?.fulfillment_method === "pickup" ? "pickup" : "ship";
  const pickupLocationId =
    fulfillmentMethod === "pickup"
      ? (session.metadata?.pickup_location_id ?? null)
      : null;

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
    fulfillment_method: fulfillmentMethod,
  };
  if (customerId) update.customer_id = customerId;
  // Persist the pickup location for pickup orders. Leave the column
  // untouched on ship orders so a webhook re-delivery can't null out a
  // value (the checkout route already wrote it on the pending row).
  if (pickupLocationId) update.pickup_location_id = pickupLocationId;
  // Only write the snapshot if Stripe actually gave us one. Skipping
  // the key on null preserves any later admin edit on a Stripe
  // re-delivery (charge.refunded → no shipping_details).
  if (shippingAddress) {
    update.shipping_address_json = shippingAddress as unknown as Json;
  }
  if (customerEmail) update.customer_email = customerEmail;

  // Upsert (not bare UPDATE). The previous UPDATE silently matched
  // zero rows when `checkout.ts` crashed after creating the Stripe
  // session but before persisting the local `shop_orders` row — the
  // webhook handler would then return 200 and Stripe would never
  // retry, permanently losing a paid order from local history.
  // Upserting on `stripe_session_id` records the order from the
  // webhook even when the route-side write was lost; if checkout.ts
  // later writes the row, the conflict resolves cleanly.
  const upsertRow: ShopOrderUpdate & { stripe_session_id: string } = {
    ...update,
    stripe_session_id: session.id,
  };
  const { data: rows, error } = await supabase
    .schema("resupply")
    .from("shop_orders")
    .upsert(upsertRow, { onConflict: "stripe_session_id" })
    .select("id, customer_id, paid_at");
  if (error) throw error;

  log?.info?.({ amountCents: session.amount_total }, "shop order marked paid");

  const row = rows?.[0];
  if (!row) {
    // Should be unreachable after the upsert above (the row either
    // existed and was updated, or didn't and was inserted). Log loud
    // so an operator can investigate if it ever fires.
    log?.info?.(
      { sessionId: session.id },
      "shop order markPaid: upsert returned no row — investigate",
    );
    return null;
  }
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
export async function upsertOrderItemsFromSession(
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
  // SKU per row (aligned 1:1 with `rows`), resolved from the expanded
  // Stripe product metadata, for the COGS snapshot lookup below.
  const rowSkus: (string | null)[] = [];
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

    // Resolve the shop SKU from the expanded Stripe product metadata
    // (written by seed-stripe-products). Aligned 1:1 with `rows` so the
    // COGS snapshot lookup below can stamp by index.
    let sku: string | null = null;
    if (product && typeof product === "object" && !product.deleted) {
      const raw = product.metadata.shop_sku;
      if (typeof raw === "string" && raw.trim().length > 0) sku = raw.trim();
    }
    rowSkus.push(sku);

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

  // Stamp the per-unit COGS snapshot (migration 0193) so a later cost
  // change never rewrites this order's margin. Fail-soft:
  // fetchUnitCostsBySku returns an empty map on any error, leaving cost
  // null ("unknown") — it must never block the order-items write.
  const costBySku = await fetchUnitCostsBySku(rowSkus, log);
  stampUnitCostSnapshots(rows, rowSkus, costBySku, paidAtIso);

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
export async function syncCustomerAfterCheckout(
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
  // Stripe collects the phone at Checkout (phone_number_collection); it
  // arrives on the completed session's customer_details. Persist it so an
  // inbound voice caller can be matched to this storefront account.
  const phoneRaw = session.customer_details?.phone ?? null;
  const phoneE164 = phoneRaw ? normalizeE164(phoneRaw) : null;

  // Read existing row to decide whether to backfill the shipping address
  // and phone (only when empty — never overwrite a deliberate edit).
  const { data: existing, error: selectErr } = await supabase
    .schema("resupply")
    .from("shop_customers")
    .select("shipping_address_json, stripe_customer_id, phone_e164")
    .eq("customer_id", customerId)
    .maybeSingle();
  if (selectErr) throw selectErr;

  const shouldSetShipping =
    shippingAddress !== null &&
    (existing?.shipping_address_json ?? null) === null;
  const shouldSetPhone =
    phoneE164 !== null && (existing?.phone_e164 ?? null) === null;

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
      phone_e164: phoneE164,
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
    if (shouldSetPhone && phoneE164) {
      updates.phone_e164 = phoneE164;
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
      savedPhone: shouldSetPhone,
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

export async function markStatus(
  sessionId: string,
  status: "expired" | "failed",
  log:
    | {
        info?: (...args: unknown[]) => void;
        warn?: (...args: unknown[]) => void;
      }
    | undefined,
): Promise<void> {
  const supabase = getSupabaseServiceRoleClient();
  // Filter on current status. A late-arriving `checkout.session.expired`
  // (Stripe redelivery, out-of-order webhook) MUST NOT demote a row
  // that was already paid or refunded — that would hide the order
  // from /shop/me/orders, block the return flow, and corrupt the
  // refund pipeline. Allowed transitions only: pending → expired |
  // failed.
  const { data: updated, error } = await supabase
    .schema("resupply")
    .from("shop_orders")
    .update({ status, updated_at: new Date().toISOString() })
    .eq("stripe_session_id", sessionId)
    .eq("status", "pending")
    .select("id, status");
  if (error) throw error;
  if (!updated || updated.length === 0) {
    log?.warn?.(
      { sessionId, attemptedStatus: status },
      "shop order status update skipped — row not in pending state (late or out-of-order event)",
    );
    return;
  }
  log?.info?.({ status, count: updated.length }, "shop order status updated");
}
