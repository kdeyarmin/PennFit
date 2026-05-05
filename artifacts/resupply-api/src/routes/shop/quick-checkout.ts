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

import { randomUUID } from "node:crypto";

import { Router, type IRouter } from "express";
import { and, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { readCustomerProfile } from "../../lib/customer-profile";
import type Stripe from "stripe";
import { z } from "zod";

import { getDbPool, shopOrders } from "@workspace/resupply-db";

import {
  SHOP_UNAVAILABLE_BODY,
  getStripeClient,
  readStripeConfigOrNull,
} from "../../lib/stripe/config";
import { getOrCreateStripeCustomer } from "../../lib/stripe/customer";
import { validateCartItems } from "../../lib/stripe/validate-cart";
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

    // Resolve email + display name for Stripe Customer creation.
    // Sourced from req.shopCustomerEmail / req.shopCustomerDisplayName,
    // populated by requireSignedIn from auth.users.
    const { email, displayName } = await readCustomerProfile(req);

    const stripe = getStripeClient(config);

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
      const db = drizzle(getDbPool());
      // requireSignedIn is upstream but we guard explicitly here so a
      // future weakening of that middleware can't silently pass
      // undefined to Drizzle's eq() — which matches IS NULL rows and
      // would expose every guest-checkout order.
      const customerId = req.userCustomerId;
      if (!customerId) {
        res.status(401).json({ error: "unauthorized" });
        return;
      }

      const owned = await db
        .select({ stripeSessionId: shopOrders.stripeSessionId })
        .from(shopOrders)
        .where(
          and(
            eq(shopOrders.stripeSessionId, reorderSessionId!),
            eq(shopOrders.customerId, customerId),
          ),
        )
        .limit(1);
      if (owned.length === 0) {
        res.status(404).json({ error: "order_not_found" });
        return;
      }

      let oldSession: Stripe.Checkout.Session;
      try {
        oldSession = await stripe.checkout.sessions.retrieve(
          reorderSessionId!,
          { expand: ["line_items.data.price"] },
        );
      } catch (err) {
        req.log?.warn(
          { err: err instanceof Error ? err.message : String(err) },
          "quick-checkout: stripe session retrieve failed",
        );
        res.status(502).json({ error: "stripe_retrieve_failed" });
        return;
      }
      const li = oldSession.line_items?.data ?? [];
      const archivedPriceIds: string[] = [];
      const mapped = li.map((line) => {
        const priceId =
          typeof line.price === "string"
            ? line.price
            : (line.price?.id ?? null);
        return { priceId, quantity: line.quantity ?? 1, mode: "one_time" as const };
      });
      // Collect items that lost a price so we can inform the caller.
      for (const m of mapped) {
        if (m.priceId === null) {
          // line.price was absent or the price object had no id —
          // surface it as an archived/unavailable price using the
          // line description as a hint, or a generic sentinel.
          archivedPriceIds.push("unknown");
        }
      }
      basket = mapped.filter(
        (b): b is { priceId: string; quantity: number; mode: "one_time" } =>
          b.priceId !== null,
      );
      if (archivedPriceIds.length > 0) {
        res.status(409).json({
          error: "price_unavailable",
          message:
            "One or more items from the original order are no longer available and cannot be reordered.",
          archivedPriceIds,
        });
        return;
      }
      if (basket.length === 0) {
        res.status(409).json({ error: "reorder_basket_empty" });
        return;
      }
    }

    // Catalog guard: verify every price in the resolved basket belongs
    // to the approved shop catalog and respects stock/type constraints.
    // This applies to both fresh carts and reorder baskets — a reorder
    // must re-validate because a product could have gone out of stock
    // or been removed from the catalog since the original purchase.
    const cartValidation = await validateCartItems(stripe, basket);
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

    const { stripeCustomerId } = await getOrCreateStripeCustomer(config, {
      customerId: req.userCustomerId!,
      email,
      displayName,
    });

    const idempotencyKey =
      typeof req.headers["idempotency-key"] === "string"
        ? req.headers["idempotency-key"]
        : randomUUID();

    const successUrl = `${config.publicBaseUrl}${successPath}?session_id={CHECKOUT_SESSION_ID}`;
    const cancelUrl = `${config.publicBaseUrl}${cancelPath}`;

    // Subscription mode is enabled if ANY basket line is "subscription".
    // Stripe permits mixed recurring + one-time line items in
    // subscription mode (the one-time SKU is charged on the first
    // invoice and not renewed). Reorder baskets are always one-time
    // (set above), so this branch only triggers for fresh "Subscribe
    // & ship" express checkouts. We MUST drop
    // payment_intent_data.setup_future_usage in subscription mode
    // (Stripe rejects it) and stamp customer_id onto
    // subscription_data.metadata so the customer.subscription.*
    // webhook can recover the buyer without a Session lookup.
    const isSubscription = basket.some((b) => b.mode === "subscription");

    const sharedMetadata: Record<string, string> = {
      source: "pennpaps-shop",
      flow: isSubscription
        ? "express-subscription"
        : reorderSessionId
          ? "reorder"
          : "express",
      customer_id: req.userCustomerId!,
      ...(reorderSessionId ? { reorder_of_session: reorderSessionId } : {}),
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
                customer_id: req.userCustomerId!,
                source: "pennpaps-shop",
              },
            },
          },
          { idempotencyKey },
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
          { idempotencyKey },
        );
      }
    } catch (err) {
      req.log?.error(
        { err: err instanceof Error ? err.message : String(err) },
        "stripe quick-checkout sessions.create failed",
      );
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
      res.status(502).json({ error: "stripe_create_failed" });
      return;
    }

    // Mirror to shop_orders with customer_id pre-stamped.
    const db = drizzle(getDbPool());
    await db
      .insert(shopOrders)
      .values({
        stripeSessionId: session.id,
        status: "pending",
        customerId: req.userCustomerId!,
      })
      .onConflictDoUpdate({
        target: shopOrders.stripeSessionId,
        set: { updatedAt: new Date() },
      });

    res.json({
      sessionId: session.id,
      url: session.url,
    });
  },
);

export default router;
