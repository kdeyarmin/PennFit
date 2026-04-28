// POST /shop/checkout — creates a Stripe Hosted Checkout Session and
// returns the redirect URL.
//
// Public (no auth): hosted Checkout owns PCI scope; we never see card
// data. Spam protection is implicit — every Session generation
// reserves a Stripe rate-limit slot, and an attacker creating
// thousands of unused Sessions wastes their own time more than ours.
//
// Idempotency:
//   Two layers of protection against accidental double-charges:
//     1. Frontend passes an `Idempotency-Key` header (UUID per
//        cart-checkout attempt). We forward it to Stripe via
//        `stripe.checkout.sessions.create`'s native idempotency
//        mechanism — Stripe deduplicates server-side and returns
//        the same Session on retry.
//     2. We also hash the cart contents and store that hash on
//        shop_orders. Future enhancement: short-circuit identical
//        repeat clicks within N seconds.
//
// Auto-fulfillment hooks:
//   We don't store line items locally — Stripe is the source of
//   truth. The success page re-fetches the Session by ID to render
//   what was bought. This avoids drift if a price changes between
//   "checkout started" and "checkout completed".

import { createHash, randomUUID } from "node:crypto";

import { Router, type IRouter } from "express";
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { z } from "zod";

import { getDbPool, shopOrders } from "@workspace/resupply-db";

import {
  SHOP_UNAVAILABLE_BODY,
  getStripeClient,
  readStripeConfigOrNull,
} from "../../lib/stripe/config";
import { rateLimit } from "../../middlewares/rate-limit";

const checkoutBody = z
  .object({
    items: z
      .array(
        z
          .object({
            priceId: z
              .string()
              .min(1)
              .max(100)
              // Stripe price IDs always start with `price_`; reject
              // anything else early so a typo'd `prod_xxx` surfaces
              // as a clean 400 instead of a Stripe API error.
              .regex(/^price_/, "priceId must start with price_"),
            quantity: z.number().int().min(1).max(20),
          })
          .strict(),
      )
      .min(1)
      .max(20),
    /**
     * Where Stripe redirects after success. Must be on our public
     * origin. We don't accept arbitrary redirects from clients —
     * doing so would turn our Stripe account into an open redirector.
     */
    successPath: z
      .string()
      .startsWith("/")
      .max(200)
      .default("/shop/checkout-success"),
    cancelPath: z
      .string()
      .startsWith("/")
      .max(200)
      .default("/shop/cart"),
  })
  .strict();

function hashCart(
  items: Array<{ priceId: string; quantity: number }>,
): string {
  // Stable hash: sort by priceId so [{a,1},{b,2}] and [{b,2},{a,1}]
  // collapse to the same hash.
  const sorted = [...items].sort((a, b) => a.priceId.localeCompare(b.priceId));
  return createHash("sha256")
    .update(JSON.stringify(sorted))
    .digest("hex")
    .slice(0, 32);
}

const router: IRouter = Router();

// Rate limit /shop/checkout — public endpoint that creates a Stripe
// Session + a shop_orders row on every hit. Without throttling, a
// scripted client could create thousands of orphaned Sessions and
// burn through Stripe rate budget. 10/min/IP is comfortably above
// "human refilling cart and re-clicking" but cuts off automated
// abuse early.
const checkoutLimiter = rateLimit({
  windowMs: 60_000,
  max: 10,
  name: "shop_checkout",
});

router.post("/shop/checkout", checkoutLimiter, async (req, res) => {
  const config = readStripeConfigOrNull();
  if (!config) {
    res.status(503).json(SHOP_UNAVAILABLE_BODY);
    return;
  }

  const parsed = checkoutBody.safeParse(req.body);
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
  const { items, successPath, cancelPath } = parsed.data;

  const idempotencyKey =
    typeof req.headers["idempotency-key"] === "string"
      ? req.headers["idempotency-key"]
      : randomUUID();

  const successUrl = `${config.publicBaseUrl}${successPath}?session_id={CHECKOUT_SESSION_ID}`;
  const cancelUrl = `${config.publicBaseUrl}${cancelPath}`;
  const cartHash = hashCart(items);

  const stripe = getStripeClient(config);

  let session;
  try {
    session = await stripe.checkout.sessions.create(
      {
        mode: "payment",
        line_items: items.map((it) => ({
          price: it.priceId,
          quantity: it.quantity,
        })),
        success_url: successUrl,
        cancel_url: cancelUrl,
        // Collect shipping address — we ship physical CPAP supplies.
        // Stripe's allowed_countries gate stops the form from
        // accepting addresses we can't ship to.
        shipping_address_collection: {
          allowed_countries: ["US"],
        },
        // Collect phone for shipping carrier coordination.
        phone_number_collection: { enabled: true },
        // Surface the cart hash on metadata so ops can match a
        // Stripe event back to a row in shop_orders without joining
        // through session_id.
        metadata: {
          source: "pennpaps-shop",
          cart_hash: cartHash,
        },
        // PennPaps cash-pay shop never collects sales tax in v1 —
        // CPAP supplies are usually tax-exempt as durable medical
        // equipment, and Stripe Tax can be enabled later in the
        // dashboard without code changes.
        automatic_tax: { enabled: false },
      },
      { idempotencyKey },
    );
  } catch (err) {
    req.log?.error(
      { err: err instanceof Error ? err.message : String(err) },
      "stripe checkout.sessions.create failed",
    );
    res.status(502).json({
      error: "stripe_create_failed",
      message:
        "Couldn't start checkout. Please try again in a moment, or use the insurance flow.",
    });
    return;
  }

  if (!session.url) {
    // Stripe always returns a URL for hosted Checkout in payment
    // mode, but TypeScript can't prove it. Treat a missing URL as a
    // bug we want to catch loudly rather than silently.
    req.log?.error({ sessionId: session.id }, "stripe session has no url");
    res.status(502).json({ error: "stripe_create_failed" });
    return;
  }

  // Mirror the session into shop_orders. Use ON CONFLICT so a retried
  // request that landed on the same Stripe session (via Stripe's
  // idempotency) doesn't duplicate the row.
  const db = drizzle(getDbPool());
  await db
    .insert(shopOrders)
    .values({
      stripeSessionId: session.id,
      status: "pending",
      cartHash,
    })
    .onConflictDoUpdate({
      target: shopOrders.stripeSessionId,
      set: { updatedAt: sql`now()` },
    });

  res.json({
    sessionId: session.id,
    url: session.url,
  });
});

export default router;
