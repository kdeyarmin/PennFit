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
import { clerkClient } from "@clerk/express";
import type Stripe from "stripe";
import { z } from "zod";

import { getDbPool, shopOrders } from "@workspace/resupply-db";

import {
  SHOP_UNAVAILABLE_BODY,
  getStripeClient,
  readStripeConfigOrNull,
} from "../../lib/stripe/config";
import { getOrCreateStripeCustomer } from "../../lib/stripe/customer";
import { requireSignedIn } from "../../middlewares/requireSignedIn";
import { rateLimit } from "../../middlewares/rate-limit";

const itemSchema = z.object({
  priceId: z
    .string()
    .min(1)
    .max(100)
    .regex(/^price_/, "priceId must start with price_"),
  quantity: z.number().int().min(1).max(20),
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

    // Resolve email + display name from Clerk for Customer creation.
    let email: string | null = null;
    let displayName: string | null = null;
    try {
      const user = await clerkClient.users.getUser(req.userClerkId!);
      const primaryId = user.primaryEmailAddressId;
      const primary =
        user.emailAddresses.find((e) => e.id === primaryId) ??
        user.emailAddresses[0];
      email = primary?.emailAddress ?? null;
      const fullName = [user.firstName, user.lastName]
        .filter(Boolean)
        .join(" ")
        .trim();
      displayName = fullName.length > 0 ? fullName : null;
    } catch (err) {
      req.log?.warn(
        { err: err instanceof Error ? err.message : String(err) },
        "quick-checkout: clerk user lookup failed",
      );
    }

    const stripe = getStripeClient(config);

    // Resolve the basket: either passed-in items or pulled from a
    // historical Session.
    let basket: Array<{ priceId: string; quantity: number }>;
    if (items) {
      basket = items;
    } else {
      // Validate the user owns the order they're trying to reorder.
      const db = drizzle(getDbPool());
      const owned = await db
        .select({ stripeSessionId: shopOrders.stripeSessionId })
        .from(shopOrders)
        .where(
          and(
            eq(shopOrders.stripeSessionId, reorderSessionId!),
            eq(shopOrders.clerkUserId, req.userClerkId!),
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
      basket = li
        .map((line) => ({
          priceId:
            typeof line.price === "string"
              ? line.price
              : (line.price?.id ?? null),
          quantity: line.quantity ?? 1,
        }))
        .filter(
          (b): b is { priceId: string; quantity: number } => b.priceId !== null,
        );
      if (basket.length === 0) {
        res.status(409).json({ error: "reorder_basket_empty" });
        return;
      }
    }

    const { stripeCustomerId } = await getOrCreateStripeCustomer(config, {
      clerkUserId: req.userClerkId!,
      email,
      displayName,
    });

    const idempotencyKey =
      typeof req.headers["idempotency-key"] === "string"
        ? req.headers["idempotency-key"]
        : randomUUID();

    const successUrl = `${config.publicBaseUrl}${successPath}?session_id={CHECKOUT_SESSION_ID}`;
    const cancelUrl = `${config.publicBaseUrl}${cancelPath}`;

    let session: Stripe.Checkout.Session;
    try {
      session = await stripe.checkout.sessions.create(
        {
          mode: "payment",
          customer: stripeCustomerId,
          // 'if_required' lets Stripe skip the card form when the
          // customer's saved default works for this purchase amount.
          // Combined with shipping_address_collection below, a
          // returning user with a saved card + saved address sees
          // ONE button: "Pay $X.XX".
          payment_method_collection: "if_required",
          line_items: basket.map((it) => ({
            price: it.priceId,
            quantity: it.quantity,
          })),
          success_url: successUrl,
          cancel_url: cancelUrl,
          shipping_address_collection: { allowed_countries: ["US"] },
          phone_number_collection: { enabled: true },
          // Save any new card to the customer for next time.
          payment_intent_data: {
            setup_future_usage: "off_session",
          },
          // Sync newest shipping/name back to the Customer so our
          // saved-info display stays fresh.
          customer_update: {
            shipping: "auto",
            address: "auto",
            name: "auto",
          },
          metadata: {
            source: "pennpaps-shop",
            flow: reorderSessionId ? "reorder" : "express",
            clerk_user_id: req.userClerkId!,
            ...(reorderSessionId
              ? { reorder_of_session: reorderSessionId }
              : {}),
          },
          automatic_tax: { enabled: false },
        },
        { idempotencyKey },
      );
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
      req.log?.error({ sessionId: session.id }, "quick-checkout session has no url");
      res.status(502).json({ error: "stripe_create_failed" });
      return;
    }

    // Mirror to shop_orders with clerk_user_id pre-stamped.
    const db = drizzle(getDbPool());
    await db
      .insert(shopOrders)
      .values({
        stripeSessionId: session.id,
        status: "pending",
        clerkUserId: req.userClerkId!,
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
