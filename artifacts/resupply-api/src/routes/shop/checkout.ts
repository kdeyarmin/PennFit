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
import { z } from "zod";

import { getSupabaseServiceRoleClient } from "@workspace/resupply-db";

import {
  SHOP_UNAVAILABLE_BODY,
  getStripeClient,
  readStripeConfigOrNull,
} from "../../lib/stripe/config";
import { isFeatureEnabled } from "../../lib/feature-flags";
import { getOrCreateStripeCustomer } from "../../lib/stripe/customer";
import { validateCartItems } from "../../lib/stripe/validate-cart";
import { readCustomerProfile } from "../../lib/customer-profile";
import { rateLimit } from "../../middlewares/rate-limit";
import { attachSignedIn } from "../../middlewares/requireSignedIn";

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
            /**
             * Subscribe & Save: per-item flag. "one_time" → invoice
             * line; "subscription" → recurring line. When ANY item
             * carries "subscription" the whole Session is created
             * with mode: "subscription" (Stripe supports mixed
             * recurring + one-time line items in subscription mode;
             * one-time lines are charged on the first invoice and
             * not renewed).
             */
            mode: z.enum(["one_time", "subscription"]).default("one_time"),
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
    cancelPath: z.string().startsWith("/").max(200).default("/shop/cart"),
  })
  .strict();

function hashCart(
  items: Array<{ priceId: string; quantity: number; mode?: string }>,
): string {
  // Stable hash: sort by priceId so [{a,1},{b,2}] and [{b,2},{a,1}]
  // collapse to the same hash.
  const sorted = [...items].sort((a, b) => a.priceId.localeCompare(b.priceId));
  return createHash("sha256").update(JSON.stringify(sorted)).digest("hex");
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

router.post(
  "/shop/checkout",
  checkoutLimiter,
  attachSignedIn,
  async (req, res) => {
    // Control Center feature gate. Admins can disable new checkouts
    // from the UI (e.g. during an outage or inventory freeze) without
    // a deploy; existing orders and webhooks keep flowing because the
    // gate is only on this create-session endpoint.
    if (!(await isFeatureEnabled("storefront.checkout"))) {
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

    // Subscription mode is enabled if ANY item carries mode:
    // "subscription". Stripe will charge any sibling one-time items on
    // the first invoice. Subscription mode requires a Customer (not
    // just customer_email) so we can manage / cancel later — gate the
    // whole flow on the user being signed-in.
    const isSubscription = items.some((it) => it.mode === "subscription");
    if (isSubscription && !req.userCustomerId) {
      res.status(401).json({
        error: "sign_in_required",
        message:
          "You'll need to sign in before subscribing — auto-ship is tied to your PennPaps account so you can pause or cancel anytime.",
      });
      return;
    }

    const successUrl = `${config.publicBaseUrl}${successPath}?session_id={CHECKOUT_SESSION_ID}`;
    const cancelUrl = `${config.publicBaseUrl}${cancelPath}`;
    // Hash uses priceId+qty+mode so two identical-priced carts with
    // different mode mixes don't collapse to the same hash.
    const cartHash = hashCart(
      items.map((it) => ({
        priceId: it.priceId,
        quantity: it.quantity,
        mode: it.mode,
      })),
    );

    // Namespace the client-supplied Idempotency-Key per signed-in
    // customer (or per IP for guests) + cart contents before handing
    // it to Stripe. Stripe scopes idempotency keys across the whole
    // API key, so two unrelated checkouts that happen to ship the
    // same client key would otherwise resolve to the SAME Stripe
    // Session — user B would receive user A's session URL, line
    // items, and Stripe customer attachment (cross-user PHI / cart
    // leak). Including cartHash also handles "same user clicks Buy
    // twice with different carts and a browser-cached header" —
    // Stripe rejects mismatched bodies for a reused key, so keying
    // on cart contents avoids the idempotency_error UX glitch and
    // ensures a real second checkout creates a fresh Session.
    const clientKey =
      typeof req.headers["idempotency-key"] === "string"
        ? req.headers["idempotency-key"]
        : randomUUID();
    const idempotencyKey = createHash("sha256")
      .update(
        `${req.userCustomerId ?? `guest:${req.ip ?? "unknown"}`}|${clientKey}|${cartHash}|${isSubscription ? "sub" : "one"}`,
      )
      .digest("hex");

    const stripe = getStripeClient(config);

    // Catalog guard: every price in the cart must belong to the approved
    // shop catalog and respect stock/type constraints. The sibling
    // /shop/me/quick-checkout route applies the same guard; without it a
    // tampered cart could check out stale/legacy prices, out-of-stock
    // items, or SKUs intentionally excluded from /shop/products.
    const cartValidation = await validateCartItems(stripe, items);
    if (!cartValidation.ok) {
      req.log?.warn(
        { errors: cartValidation.errors },
        "shop checkout: cart validation failed",
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

    // If the user is signed in, attach (or create) their Stripe Customer
    // so the saved card + address pre-fill on the Stripe page AND so the
    // card from this checkout becomes saved-on-file for next time. We
    // do this best-effort: if customer creation fails, fall through to
    // anonymous checkout rather than blocking the order — guest mode
    // is the documented fallback.
    let stripeCustomerId: string | null = null;
    let customerEmail: string | null = null;
    if (req.userCustomerId) {
      try {
        const profile = await readCustomerProfile(req);
        customerEmail = profile.email;
        const mapping = await getOrCreateStripeCustomer(config, {
          customerId: req.userCustomerId,
          email: customerEmail,
          displayName: profile.displayName,
        });
        stripeCustomerId = mapping.stripeCustomerId;
      } catch (err) {
        req.log?.warn(
          { err: err instanceof Error ? err.message : String(err) },
          "shop checkout: signed-in customer attachment failed; continuing as guest",
        );
      }
    }

    // Common metadata for both payment + subscription flows.
    const sessionMetadata: Record<string, string> = {
      source: "pennpaps-shop",
      cart_hash: cartHash,
      flow: isSubscription ? "subscription" : "standard",
      ...(req.userCustomerId ? { customer_id: req.userCustomerId } : {}),
    };

    let session;
    try {
      if (isSubscription) {
        // Subscription mode. Mixed line_items (recurring + one-time)
        // are valid — one-time SKUs are charged on the first invoice
        // and not renewed. We MUST attach `customer` (we already
        // gated on req.userCustomerId above so stripeCustomerId is
        // populated unless the customer-create best-effort failed —
        // in which case we have to refuse rather than silently
        // anonymise a recurring billing relationship).
        if (!stripeCustomerId) {
          res.status(503).json({
            error: "stripe_customer_unavailable",
            message:
              "We couldn't link your account to billing right now. Please try again in a moment, or use one-time checkout.",
          });
          return;
        }
        session = await stripe.checkout.sessions.create(
          {
            mode: "subscription",
            customer: stripeCustomerId,
            customer_update: {
              shipping: "auto",
              address: "auto",
              name: "auto",
            },
            line_items: items.map((it) => ({
              price: it.priceId,
              quantity: it.quantity,
            })),
            success_url: successUrl,
            cancel_url: cancelUrl,
            shipping_address_collection: { allowed_countries: ["US"] },
            phone_number_collection: { enabled: true },
            metadata: sessionMetadata,
            // Stamp metadata onto the subscription itself so the
            // customer.subscription.* webhook can recover the buyer's
            // customer_id without having to look up the originating
            // Session.
            subscription_data: {
              metadata: {
                customer_id: req.userCustomerId!,
                source: "pennpaps-shop",
              },
            },
            automatic_tax: { enabled: false },
          },
          { idempotencyKey },
        );
      } else {
        session = await stripe.checkout.sessions.create(
          {
            mode: "payment",
            ...(stripeCustomerId
              ? {
                  customer: stripeCustomerId,
                  // setup_future_usage saves the card to the Customer
                  // for one-click reorder. Only set when we have a
                  // customer attached — Stripe rejects it otherwise.
                  payment_intent_data: {
                    setup_future_usage: "off_session",
                  },
                  // Sync collected shipping/name back to the Customer
                  // so /shop/me reflects the latest. customer_update
                  // requires `customer` to be set.
                  customer_update: {
                    shipping: "auto",
                    address: "auto",
                    name: "auto",
                  },
                }
              : customerEmail
                ? { customer_email: customerEmail }
                : {}),
            line_items: items.map((it) => ({
              price: it.priceId,
              quantity: it.quantity,
            })),
            success_url: successUrl,
            cancel_url: cancelUrl,
            shipping_address_collection: {
              allowed_countries: ["US"],
            },
            phone_number_collection: { enabled: true },
            metadata: sessionMetadata,
            // PennPaps cash-pay shop never collects sales tax in v1 —
            // CPAP supplies are usually tax-exempt as durable medical
            // equipment, and Stripe Tax can be enabled later in the
            // dashboard without code changes.
            automatic_tax: { enabled: false },
          },
          { idempotencyKey },
        );
      }
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

    // Mirror the session into shop_orders. The original SQL path
    // used INSERT … ON CONFLICT (stripe_session_id) DO UPDATE SET
    // updated_at = now() — supabase-js's `.upsert()` with
    // `onConflict: "stripe_session_id"` is the equivalent. We pass an
    // explicit JS-side `updated_at` because PostgREST won't run the
    // prior ORM's $onUpdateFn for us.
    const supabase = getSupabaseServiceRoleClient();
    const { error: upsertErr } = await supabase
      .schema("resupply")
      .from("shop_orders")
      .upsert(
        {
          stripe_session_id: session.id,
          status: "pending",
          cart_hash: cartHash,
          ...(req.userCustomerId ? { customer_id: req.userCustomerId } : {}),
          updated_at: new Date().toISOString(),
        },
        { onConflict: "stripe_session_id" },
      );
    if (upsertErr) {
      req.log?.error(
        { err: upsertErr, sessionId: session.id },
        "shop checkout: shop_orders upsert failed",
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
