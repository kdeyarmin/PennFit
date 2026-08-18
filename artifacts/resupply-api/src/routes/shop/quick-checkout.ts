// POST /shop/me/quick-checkout — "express checkout" for signed-in
// users with a saved Stripe Customer.
//
// Two body shapes:
//   { items: [{priceId, quantity}] }
//     New cart, but the user is signed in and we want to short-
//     circuit shipping/contact entry on the Stripe page by attaching
//     their Stripe Customer.
//   { reorderSessionId: "cs_..." }
//     Re-buy a previous order. We pull the line items off the
//     historical Session, validate they're still active prices,
//     then create a fresh Session for the same basket.
//
// In both cases we:
//   * Attach the user's Stripe Customer (their saved card + address
//     are pre-filled on the Stripe page).
//   * Set payment_method_collection: 'if_required' so a returning
//     user with a default card sees a one-tap "Pay $X.XX" button.
//   * Set setup_future_usage: 'off_session' on the PaymentIntent so
//     a freshly-saved card from this purchase becomes the default
//     for next time.
//
// Why this isn't truly "off-session charge with confirm:true": that
// path is correct UX-wise but introduces SCA edge cases (3DS
// challenges via webhook + polling) that double the implementation
// surface. Stripe Hosted Checkout with a saved customer is the
// industry-standard "near-one-click" flow used by Shopify Pay,
// Squarespace, and others.

import { createHash, randomUUID } from "node:crypto";

import { Router, type IRouter } from "express";
import { readCustomerProfile } from "../../lib/customer-profile";
import type Stripe from "stripe";
import { z } from "zod";

import { getOrgScopedClient } from "@workspace/resupply-db";

import {
  SHOP_UNAVAILABLE_BODY,
  getStripeClient,
  readStripeConfigOrNull,
} from "../../lib/stripe/config";
import { isFeatureEnabled } from "../../lib/feature-flags";
import {
  FIT_ORDERED_MASK_METADATA_KEY,
  FIT_ORDERED_VARIANT_METADATA_KEY,
  FIT_SESSION_METADATA_KEY,
} from "../../lib/fitting/order-link";
import { getOrCreateStripeCustomer } from "../../lib/stripe/customer";
import { stripeAccountRequestOptions } from "../../lib/stripe/connect";
import { validateCartItems } from "../../lib/stripe/validate-cart";
import {
  reserveCartInventory,
  attachSessionToReservations,
  releaseReservationIds,
  DEFAULT_RESERVATION_TTL_MS,
} from "../../lib/inventory/reservations";
import { stripeErrLogFields } from "../../lib/stripe/err-log-fields";
import { requireSignedIn } from "../../middlewares/requireSignedIn";
import { rateLimit } from "../../middlewares/rate-limit";

const itemSchema = z.object({
  priceId: z
    .string()
    .min(1)
    .max(100)
    .regex(/^price_/, "priceId must start with price_"),
  quantity: z.number().int().min(1).max(20),
  /**
   * "subscription" routes the line through Stripe Subscriptions —
   * the priceId here MUST be the recurring price (the cart swaps
   * priceId↔recurringPriceId before sending). When ANY line carries
   * "subscription" the whole Session is created with mode:
   * "subscription" (Stripe permits mixed recurring + one-time line
   * items in subscription mode). Default "one_time" preserves the
   * historical express-checkout payload shape.
   */
  mode: z.enum(["one_time", "subscription"]).default("one_time"),
});

const body = z
  .object({
    items: z.array(itemSchema).min(1).max(20).optional(),
    reorderSessionId: z
      .string()
      .regex(/^cs_(test|live)_[A-Za-z0-9]{20,}$/)
      .optional(),
    successPath: z
      .string()
      .startsWith("/")
      .max(200)
      .default("/shop/checkout-success"),
    cancelPath: z.string().startsWith("/").max(200).default("/account"),
    /**
     * Fitting attribution, mirroring /shop/checkout. Express checkout is
     * reachable from the same cart, so a fitting-sourced basket would
     * otherwise lose its link purely because the buyer has a saved card.
     * `.strict()` above means these must be declared to be accepted at all.
     */
    fitSessionId: z.string().uuid().optional(),
    orderedMaskSlug: z
      .string()
      .trim()
      .min(1)
      .max(120)
      .regex(/^[a-z0-9-]+$/)
      .optional(),
    orderedVariantId: z.string().uuid().optional(),
  })
  .strict()
  .refine(
    (v) => Boolean(v.items) !== Boolean(v.reorderSessionId),
    "Must provide exactly one of items or reorderSessionId",
  );

const limiter = rateLimit({
  windowMs: 60_000,
  max: 10,
  name: "shop_quick_checkout",
});

const router: IRouter = Router();

router.post(
  "/shop/me/quick-checkout",
  limiter,
  requireSignedIn,
  async (req, res) => {
    // Control Center master switch for storefront purchasing. Mirrors
    // the gate on POST /shop/checkout so express checkout can't bypass
    // a paused storefront. Existing subscriptions and orders are
    // managed through their own routes and stay available.
    if (!(await isFeatureEnabled("storefront.checkout", req.orgId))) {
      res.status(503).json({
        error: "checkout_disabled",
        message:
          "Checkout is temporarily unavailable. Please try again in a few minutes.",
      });
      return;
    }

    const config = readStripeConfigOrNull();
    if (!config) {
      res.status(503).json(SHOP_UNAVAILABLE_BODY);
      return;
    }

    const parsed = body.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({
        error: "invalid_body",
        issues: parsed.error.issues.map((i) => ({
          path: i.path.join("."),
          message: i.message,
        })),
      });
      return;
    }

    const { items, reorderSessionId, successPath, cancelPath } = parsed.data;

    // requireSignedIn guarantees this is set, but guard defensively
    // so a future middleware re-ordering can't silently mis-route.
    if (!req.userCustomerId) {
      res.status(401).json({ error: "sign_in_required" });
      return;
    }
    const customerId: string = req.userCustomerId;

    // Resolve email + display name for Stripe Customer creation.
    // Sourced from req.shopCustomerEmail / req.shopCustomerDisplayName,
    // populated by requireSignedIn from auth.users.
    const { email, displayName } = await readCustomerProfile(req);

    const stripe = getStripeClient(config);
    // Stripe Connect (G5): the saved Customer, the historical reorder
    // Session, and the new Session all live on the tenant's connected
    // account when set; NULL → {} → platform account.
    const connectOptions = await stripeAccountRequestOptions(req.orgId);

    // Resolve the basket: either passed-in items or pulled from a
    // historical Session. Reorders are always one-time — historical
    // line items intentionally lose their original mode (the v1 UX
    // is "buy this again", not "subscribe to this").
    let basket: Array<{
      priceId: string;
      quantity: number;
      mode: "one_time" | "subscription";
    }>;
    if (items) {
      basket = items;
    } else {
      // Validate the user owns the order they're trying to reorder.
      // requireSignedIn is upstream but we guard explicitly here so a
      // future weakening of that middleware can't silently pass
      // undefined into the .eq() filter — that would match IS NULL
      // rows and expose every guest-checkout order.
      const customerId = req.userCustomerId;
      if (!customerId) {
        res.status(401).json({ error: "unauthorized" });
        return;
      }

      const orgId = req.orgId;
      if (!orgId) {
        res.status(500).json({ error: "tenant_context_missing" });
        return;
      }
      const supabase = getOrgScopedClient(orgId);
      const { data: owned, error: ownedErr } = await supabase
        .from("shop_orders")
        .select("stripe_session_id")
        .eq("stripe_session_id", reorderSessionId!)
        .eq("customer_id", customerId)
        .limit(1)
        .maybeSingle();
      if (ownedErr) throw ownedErr;
      if (!owned) {
        res.status(404).json({ error: "order_not_found" });
        return;
      }

      let oldSession: Stripe.Checkout.Session;
      try {
        oldSession = await stripe.checkout.sessions.retrieve(
          reorderSessionId!,
          { expand: ["line_items.data.price"] },
          connectOptions,
        );
      } catch (err) {
        req.log?.warn(
          { ...stripeErrLogFields(err) },
          "quick-checkout: stripe session retrieve failed",
        );
        res.status(502).json({ error: "stripe_retrieve_failed" });
        return;
      }
      // Guard against Stripe returning a paginated line_items list
      // (has_more: true). For CPAP reorders this is virtually impossible
      // (max 20-item limit in the request body above), but the Stripe
      // API can theoretically paginate. Fail loudly rather than silently
      // presenting an incomplete basket to the customer.
      if (oldSession.line_items?.has_more) {
        res.status(409).json({ error: "reorder_basket_too_large" });
        return;
      }
      const li = oldSession.line_items?.data ?? [];
      const unavailableItems: Array<{
        lineItemId: string;
        description: string | null;
      }> = [];
      const mapped = li.map((line, index) => {
        const priceId =
          typeof line.price === "string"
            ? line.price
            : (line.price?.id ?? null);
        if (priceId === null) {
          unavailableItems.push({
            lineItemId:
              typeof line.id === "string" && line.id.length > 0
                ? line.id
                : `index:${index}`,
            description: line.description ?? null,
          });
        }
        return {
          priceId,
          quantity: line.quantity ?? 1,
          mode: "one_time" as const,
        };
      });
      basket = mapped.filter(
        (b): b is { priceId: string; quantity: number; mode: "one_time" } =>
          b.priceId !== null,
      );
      if (unavailableItems.length > 0) {
        res.status(409).json({
          error: "price_unavailable",
          message:
            "One or more items from the original order are no longer available and cannot be reordered.",
          unavailableItems,
        });
        return;
      }
      if (basket.length === 0) {
        res.status(409).json({ error: "reorder_basket_empty" });
        return;
      }
      // If any line items were silently dropped (archived / deleted
      // price), refuse the reorder rather than creating a basket the
      // customer didn't expect.
      if (basket.length < li.length) {
        res.status(409).json({ error: "price_unavailable" });
        return;
      }
    }

    // Catalog guard: verify every price in the resolved basket belongs
    // to the approved shop catalog and respects stock/type constraints.
    // This applies to both fresh carts and reorder baskets — a reorder
    // must re-validate because a product could have gone out of stock
    // or been removed from the catalog since the original purchase.
    // Validate against the SAME account the session is created on
    // (connectOptions, resolved above) so a connected tenant's basket is
    // checked against their own catalog rather than the platform's.
    const cartValidation = await validateCartItems(
      stripe,
      basket,
      connectOptions,
    );
    if (!cartValidation.ok) {
      req.log?.warn(
        { errors: cartValidation.errors },
        "quick-checkout: cart validation failed",
      );
      res.status(400).json({
        error: "cart_invalid",
        issues: cartValidation.errors.map((e) => ({
          priceId: e.priceId,
          reason: e.reason,
          message: e.message,
        })),
      });
      return;
    }

    // Subscription mode is enabled if ANY basket line is "subscription".
    // Computed BEFORE the reservation so it can feed the idempotency key, which
    // the reservation now keys its hold to (idempotent-retry reuse).
    const isSubscription = basket.some((b) => b.mode === "subscription");

    // Namespace the Stripe idempotency key by customer + basket, exactly
    // as /shop/checkout does. Stripe scopes idempotency keys account-wide,
    // so passing a raw client-supplied `Idempotency-Key` verbatim means
    // two unrelated authenticated patients who happen to send the same
    // header value would resolve to the SAME Checkout Session — patient B
    // would receive patient A's session URL, line items, and Stripe
    // Customer attachment (cross-user PHI/cart leak). Hashing in the
    // server-side customerId (and the basket) makes the effective key
    // unforgeable across customers while still de-duping a real
    // double-click from one buyer. Including the basket also yields a
    // fresh Session when the same buyer changes their cart and re-submits.
    // Computed up here (was below the reservation) so the inventory hold can be
    // keyed to it — a client retry of the same checkout then reuses its hold.
    const clientKey =
      typeof req.headers["idempotency-key"] === "string"
        ? req.headers["idempotency-key"]
        : randomUUID();
    const basketHash = createHash("sha256")
      .update(
        JSON.stringify(
          [...basket]
            .map((b) => ({
              priceId: b.priceId,
              quantity: b.quantity,
              mode: b.mode,
            }))
            .sort((a, b) => a.priceId.localeCompare(b.priceId)),
        ),
      )
      .digest("hex");
    const idempotencyKey = createHash("sha256")
      .update(
        `${customerId}|${clientKey}|${basketHash}|${isSubscription ? "sub" : "one"}`,
      )
      .digest("hex");

    // Pin the Stripe Checkout Session lifetime to the inventory-hold TTL so the
    // session and the hold lapse TOGETHER — mirrors /shop/checkout. Epoch
    // seconds for Stripe; the hold derives its own from DEFAULT_RESERVATION_TTL_MS.
    const sessionExpiresAtSec = Math.floor(
      (Date.now() + DEFAULT_RESERVATION_TTL_MS) / 1000,
    );

    // Inventory reservation / oversell guard — same rationale as
    // /shop/checkout: hold the requested units between validation and payment
    // so concurrent buyers can't all pass the stock check and oversell.
    // FAIL-OPEN: a reservation-system error returns ok:true with no ids and
    // checkout proceeds unguarded; only a clean "oversold" verdict blocks.
    const reservationOrgId = req.orgId ?? null;
    let reservationIds: string[] = [];
    if (reservationOrgId) {
      const reservation = await reserveCartInventory({
        orgId: reservationOrgId,
        stripe,
        requestOptions: connectOptions,
        items: basket,
        // Key the hold to the SAME namespaced idempotency key handed to Stripe
        // below, so a client retry reuses its existing hold rather than being
        // refused with a phantom oversell on a last-unit SKU.
        idempotencyKey,
        log: req.log,
      });
      if (!reservation.ok) {
        req.log?.warn(
          { productId: reservation.oversoldProductId },
          "quick-checkout: inventory reservation refused (oversold)",
        );
        res.status(409).json({
          error: "out_of_stock",
          message:
            "Sorry — one or more items just sold out while you were checking out. Please adjust your cart and try again.",
        });
        return;
      }
      reservationIds = reservation.reservationIds;
    }

    const { stripeCustomerId } = await getOrCreateStripeCustomer(config, {
      orgId: req.orgId,
      customerId: customerId,
      email,
      displayName,
    });

    const successUrl = `${config.publicBaseUrl}${successPath}?session_id={CHECKOUT_SESSION_ID}`;
    const cancelUrl = `${config.publicBaseUrl}${cancelPath}`;

    // Stripe permits mixed recurring + one-time line items in
    // subscription mode (the one-time SKU is charged on the first
    // invoice and not renewed). Reorder baskets are always one-time
    // (set above), so the subscription branch only triggers for fresh
    // "Subscribe & ship" express checkouts. We MUST drop
    // payment_intent_data.setup_future_usage in subscription mode
    // (Stripe rejects it) and stamp customer_id onto
    // subscription_data.metadata so the customer.subscription.* webhook
    // can recover the buyer without a Session lookup.
    const sharedMetadata: Record<string, string> = {
      source: "pennpaps-shop",
      flow: isSubscription
        ? "express-subscription"
        : reorderSessionId
          ? "reorder"
          : "express",
      customer_id: customerId,
      ...(reorderSessionId ? { reorder_of_session: reorderSessionId } : {}),
      // Stamp the originating tenant so the webhook attributes the paid order
      // to the right org even when checkout ran on the platform account (a
      // non-seed tenant pre-charges-enabled), where the event carries no
      // event.account. See checkout.ts for the full rationale.
      ...(req.orgId ? { org_id: req.orgId } : {}),
      // Fitting attribution, read back by the webhook. Absent for an
      // ordinary express reorder.
      ...(parsed.data.fitSessionId
        ? { [FIT_SESSION_METADATA_KEY]: parsed.data.fitSessionId }
        : {}),
      ...(parsed.data.orderedMaskSlug
        ? { [FIT_ORDERED_MASK_METADATA_KEY]: parsed.data.orderedMaskSlug }
        : {}),
      ...(parsed.data.orderedVariantId
        ? { [FIT_ORDERED_VARIANT_METADATA_KEY]: parsed.data.orderedVariantId }
        : {}),
    };

    let session: Stripe.Checkout.Session;
    try {
      const baseParams: Omit<
        Stripe.Checkout.SessionCreateParams,
        | "mode"
        | "payment_intent_data"
        | "subscription_data"
        | "payment_method_collection"
      > = {
        customer: stripeCustomerId,
        expires_at: sessionExpiresAtSec,
        line_items: basket.map((it) => ({
          price: it.priceId,
          quantity: it.quantity,
        })),
        success_url: successUrl,
        cancel_url: cancelUrl,
        shipping_address_collection: { allowed_countries: ["US"] },
        phone_number_collection: { enabled: true },
        // Sync newest shipping/name back to the Customer so our
        // saved-info display stays fresh.
        customer_update: {
          shipping: "auto",
          address: "auto",
          name: "auto",
        },
        metadata: sharedMetadata,
        automatic_tax: { enabled: false },
      };

      if (isSubscription) {
        session = await stripe.checkout.sessions.create(
          {
            ...baseParams,
            mode: "subscription",
            // Stripe forbids payment_method_collection: 'if_required'
            // in subscription mode — a recurring billing relationship
            // always needs a saved payment method.
            subscription_data: {
              metadata: {
                customer_id: customerId,
                source: "pennpaps-shop",
                // Propagate the originating tenant onto the Subscription so
                // customer.subscription.* events (which carry no
                // event.account when checkout ran on the platform account)
                // scope shop_subscriptions to the right org rather than the
                // seed fallback. Session metadata doesn't cover these — they
                // fire on the Subscription object. See checkout.ts.
                ...(req.orgId ? { org_id: req.orgId } : {}),
              },
            },
          },
          { idempotencyKey, ...connectOptions },
        );
      } else {
        session = await stripe.checkout.sessions.create(
          {
            ...baseParams,
            mode: "payment",
            // 'if_required' lets Stripe skip the card form when the
            // customer's saved default works for this purchase amount.
            // Combined with shipping_address_collection below, a
            // returning user with a saved card + saved address sees
            // ONE button: "Pay $X.XX".
            payment_method_collection: "if_required",
            // Save any new card to the customer for next time.
            payment_intent_data: {
              setup_future_usage: "off_session",
            },
          },
          { idempotencyKey, ...connectOptions },
        );
      }
    } catch (err) {
      req.log?.error(
        { ...stripeErrLogFields(err) },
        "stripe quick-checkout sessions.create failed",
      );
      // No session was created — release the holds so the reserved stock
      // frees immediately rather than leaking until TTL. Best-effort.
      if (reservationOrgId && reservationIds.length > 0) {
        await releaseReservationIds(reservationOrgId, reservationIds, req.log);
      }
      res.status(502).json({
        error: "stripe_create_failed",
        message:
          "Couldn't start checkout. Please try again in a moment, or use the standard checkout flow.",
      });
      return;
    }

    if (!session.url) {
      req.log?.error(
        { sessionId: session.id },
        "quick-checkout session has no url",
      );
      if (reservationOrgId && reservationIds.length > 0) {
        await releaseReservationIds(reservationOrgId, reservationIds, req.log);
      }
      res.status(502).json({ error: "stripe_create_failed" });
      return;
    }

    // Stamp the session id onto the holds so the webhook can consume/release
    // them. Best-effort — a failure just leaves the holds to expire via TTL.
    if (reservationOrgId && reservationIds.length > 0) {
      await attachSessionToReservations(
        reservationOrgId,
        reservationIds,
        session.id,
        req.log,
      );
    }

    // Mirror to shop_orders. We split the upsert into INSERT-or-
    // ignore + guarded UPDATE so a guest-checkout webhook that
    // already wrote a row keyed by this session ID with NULL
    // customer_id can't have its ownership silently rebound by a
    // later signed-in caller. The UPDATE only proceeds when
    // customer_id is still unset OR already equals this caller —
    // i.e. either we're claiming an unowned row OR we're idempotently
    // re-stamping our own.
    const orgId = req.orgId;
    if (!orgId) {
      res.status(500).json({ error: "tenant_context_missing" });
      return;
    }
    const supabase = getOrgScopedClient(orgId);
    const nowIso = new Date().toISOString();
    const { error: insertErr } = await supabase.from("shop_orders").upsert(
      {
        stripe_session_id: session.id,
        status: "pending",
        customer_id: customerId,
        updated_at: nowIso,
      },
      { onConflict: "stripe_session_id", ignoreDuplicates: true },
    );
    if (insertErr) {
      req.log?.error(
        { err: insertErr, sessionId: session.id },
        "shop quick-checkout: shop_orders insert failed",
      );
      res.status(500).json({ error: "shop_order_persist_failed" });
      return;
    }
    // Refresh customer_id + updated_at on the existing row — but
    // only when ownership is unclaimed or already ours. Filtering on
    // `customer_id` here is the race guard: a concurrent caller's
    // upsert wins for its own session, ours is a no-op.
    const { error: stampErr } = await supabase
      .from("shop_orders")
      .update({ customer_id: customerId, updated_at: nowIso })
      .eq("stripe_session_id", session.id)
      .or(`customer_id.is.null,customer_id.eq.${customerId}`);
    if (stampErr) {
      req.log?.error(
        { err: stampErr, sessionId: session.id },
        "shop quick-checkout: shop_orders ownership stamp failed",
      );
      res.status(500).json({ error: "shop_order_persist_failed" });
      return;
    }

    res.json({
      sessionId: session.id,
      url: session.url,
    });
  },
);

export default router;
