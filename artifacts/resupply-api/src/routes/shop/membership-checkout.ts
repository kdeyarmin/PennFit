// /shop/membership/* — storefront self-serve cash-pay membership join.
//
//   GET  /shop/membership/options   — which paid tiers are available + price
//   POST /shop/membership/checkout  — start a Stripe subscription Checkout
//                                     for the chosen tier
//
// Closes the gap where membership_tier was CSR-set only. The Checkout Session
// runs in mode:"subscription" and stamps subscription_data.metadata with the
// buyer's customer_id + the chosen membership_tier, so the
// customer.subscription.* webhook (joinMembershipFromSubscription) sets the
// tier on the shop_customers row once the subscription goes active. Cancel /
// renewal are already reconciled by the same webhook.
//
// Feature-gated + fail-soft: a tier with no configured Stripe price is
// unavailable (the route 503s, the options list omits it), so a deploy
// without membership prices behaves exactly as before.

import { Router, type IRouter } from "express";
import { z } from "zod";

import { getOrgScopedClient } from "@workspace/resupply-db";

import { getOrCreateStripeCustomer } from "../../lib/stripe/customer";
import {
  getStripeClient,
  readStripeConfigOrNull,
} from "../../lib/stripe/config";
import { stripeAccountRequestOptions } from "../../lib/stripe/connect";
import {
  isPaidMembershipTier,
  PAID_MEMBERSHIP_TIERS,
  readMembershipPriceConfig,
} from "../../lib/stripe/membership-config";
import { rateLimit } from "../../middlewares/rate-limit";
import { requireSignedIn } from "../../middlewares/requireSignedIn";

const router: IRouter = Router();

const checkoutBody = z
  .object({
    tier: z.enum(["monthly_unlimited", "quarterly_unlimited"]),
  })
  .strict();

// GET /shop/membership/options — the tiers a customer can join right now,
// with each tier's Stripe price amount + interval for display. Tiers with no
// configured price are omitted. Stripe outage degrades to amount=null (the
// tier is still listed as joinable).
router.get("/shop/membership/options", requireSignedIn, async (req, res) => {
  const priceConfig = readMembershipPriceConfig();
  const config = readStripeConfigOrNull();
  if (!config) {
    res.json({ tiers: [] });
    return;
  }
  const stripe = getStripeClient(config);
  const connectOptions = await stripeAccountRequestOptions(req.orgId);

  const tiers: Array<{
    tier: string;
    priceId: string;
    unitAmountCents: number | null;
    currency: string | null;
    interval: string | null;
    intervalCount: number | null;
  }> = [];
  for (const tier of PAID_MEMBERSHIP_TIERS) {
    const priceId = priceConfig[tier];
    if (!priceId) continue;
    let unitAmountCents: number | null = null;
    let currency: string | null = null;
    let interval: string | null = null;
    let intervalCount: number | null = null;
    try {
      const price = await stripe.prices.retrieve(
        priceId,
        undefined,
        connectOptions,
      );
      unitAmountCents = price.unit_amount ?? null;
      currency = price.currency ?? null;
      interval = price.recurring?.interval ?? null;
      intervalCount = price.recurring?.interval_count ?? null;
    } catch (err) {
      req.log?.warn(
        { tier, err },
        "membership options: price retrieve failed (listing without amount)",
      );
    }
    tiers.push({
      tier,
      priceId,
      unitAmountCents,
      currency,
      interval,
      intervalCount,
    });
  }
  res.json({ tiers });
});

const membershipCheckoutLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  max: 8,
  name: "shop_membership_checkout",
  keyFn: (req) => req.userCustomerId ?? "unknown",
});

// POST /shop/membership/checkout — create the subscription Checkout Session.
router.post(
  "/shop/membership/checkout",
  requireSignedIn,
  membershipCheckoutLimiter,
  async (req, res) => {
    const parsed = checkoutBody.safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(400).json({ error: "invalid_body" });
      return;
    }
    const customerId = req.userCustomerId;
    if (!customerId) {
      res.status(401).json({ error: "not_signed_in" });
      return;
    }
    const { tier } = parsed.data;

    const priceId = readMembershipPriceConfig()[tier];
    if (!priceId) {
      res.status(503).json({ error: "membership_tier_unavailable" });
      return;
    }
    const config = readStripeConfigOrNull();
    if (!config) {
      res.status(503).json({ error: "billing_unavailable" });
      return;
    }
    if (!req.orgId) {
      res.status(500).json({ error: "tenant_context_missing" });
      return;
    }

    // Already-a-member guard: an existing PAID membership with a linked
    // subscription must NOT create a second Stripe subscription (the webhook
    // would overwrite the link without canceling the old one, double-billing
    // the customer). They manage/cancel via /account instead.
    const supabase = getOrgScopedClient(req.orgId);
    const { data: existing, error: existingErr } = await supabase
      .from("shop_customers")
      .select("membership_tier, membership_stripe_subscription_id")
      .eq("customer_id", customerId)
      .limit(1)
      .maybeSingle();
    if (existingErr) throw existingErr;
    if (
      existing &&
      isPaidMembershipTier(existing.membership_tier) &&
      existing.membership_stripe_subscription_id
    ) {
      res.status(409).json({
        error: "already_member",
        currentTier: existing.membership_tier,
      });
      return;
    }

    const stripe = getStripeClient(config);
    const connectOptions = await stripeAccountRequestOptions(req.orgId);

    // Ensure the customer has a Stripe customer to attach the subscription to.
    let stripeCustomerId: string | null = null;
    try {
      const mapping = await getOrCreateStripeCustomer(config, {
        orgId: req.orgId,
        customerId,
        email: req.shopCustomerEmail ?? null,
      });
      stripeCustomerId = mapping.stripeCustomerId;
    } catch (err) {
      req.log?.warn({ err }, "membership checkout: customer ensure failed");
    }
    if (!stripeCustomerId) {
      res.status(503).json({ error: "stripe_customer_unavailable" });
      return;
    }

    // Land back on the real storefront account page (MembershipSection lives
    // on /account); /shop/me is an API path, not an SPA route.
    const successUrl = `${config.publicBaseUrl}/account?membership=joined`;
    const cancelUrl = `${config.publicBaseUrl}/account`;

    // Server-derived idempotency key so a double-click / browser retry reuses
    // the same Checkout Session instead of creating a second subscription. A
    // 10-minute bucket lets a legitimate later re-join (e.g. after a cancel)
    // start a fresh session.
    const bucket = Math.floor(Date.now() / (10 * 60 * 1000));
    const idempotencyKey = `membership:${customerId}:${tier}:${bucket}`;

    try {
      const session = await stripe.checkout.sessions.create(
        {
          mode: "subscription",
          customer: stripeCustomerId,
          line_items: [{ price: priceId, quantity: 1 }],
          success_url: successUrl,
          cancel_url: cancelUrl,
          metadata: {
            source: "pennpaps-shop",
            flow: "membership",
            customer_id: customerId,
            membership_tier: tier,
          },
          // Stamp the subscription so the customer.subscription.* webhook sets
          // membership_tier on the shop_customers row.
          subscription_data: {
            metadata: {
              customer_id: customerId,
              membership_tier: tier,
              source: "membership",
            },
          },
          automatic_tax: { enabled: false },
        },
        { idempotencyKey, ...connectOptions },
      );
      res.json({ url: session.url });
    } catch (err) {
      req.log?.error({ err }, "membership checkout: session create failed");
      res.status(502).json({ error: "checkout_session_failed" });
    }
  },
);

export default router;

// Re-export so the type stays in one place if a caller needs it.
export { isPaidMembershipTier };
