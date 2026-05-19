// POST /shop/me/billing-portal — open a Stripe Customer Portal session.
//
// /account today renders the saved card as read-only with a note that
// the customer has to start a checkout to change it. That's a friction
// every Aeroflow/Lincare patient runs into when their card on file
// expires. Stripe Customer Portal is a one-API-call solution: we mint
// a short-lived URL, hand it back to the SPA, and the SPA redirects
// the user into Stripe's hosted page for card / address / invoice /
// subscription management. Stripe handles PCI scope and 3DS, we do
// nothing payment-data-sensitive in-process.
//
// Auth: requireSignedIn — must have a session. Guests have nothing to
// manage and would get a confusing portal anyway.
//
// 503 envelope: same as the other shop routes — when Stripe isn't
// configured (preview / local dev without a STRIPE_SECRET_KEY) we
// return SHOP_UNAVAILABLE_BODY so the SPA renders a friendly "shop
// not configured" state instead of a generic failure.

import { Router, type IRouter } from "express";
import { z } from "zod";

import { logAudit } from "@workspace/resupply-audit";

import {
  SHOP_UNAVAILABLE_BODY,
  getStripeClient,
  readStripeConfigOrNull,
} from "../../lib/stripe/config";
import { getOrCreateStripeCustomer } from "../../lib/stripe/customer";
import { logger } from "../../lib/logger";
import { rateLimit } from "../../middlewares/rate-limit";
import { requireSignedIn } from "../../middlewares/requireSignedIn";

const router: IRouter = Router();

const body = z
  .object({
    // The path on our SPA the user is bounced back to after they
    // close the Stripe portal. Restricted to in-app paths so a
    // hostile redirect can't be smuggled through this field.
    returnPath: z.string().startsWith("/").max(200).default("/account"),
  })
  .strict();

router.post(
  "/shop/me/billing-portal",
  // 5 portal sessions / 5 minutes / customer is plenty for legitimate
  // "open settings → close → open settings" oscillation. Past that
  // someone is hammering the Stripe API on our dime.
  rateLimit({ windowMs: 5 * 60_000, max: 5, name: "shop_billing_portal" }),
  requireSignedIn,
  async (req, res) => {
    const parsed = body.safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(400).json({ error: "invalid_body" });
      return;
    }
    const config = readStripeConfigOrNull();
    if (!config) {
      res.status(503).json(SHOP_UNAVAILABLE_BODY);
      return;
    }
    const customerId = req.userCustomerId;
    // req.shopCustomerEmail can be undefined when a sub-flow attaches
    // a session without an email on file; normalize to null so the
    // Stripe customer helper's typing is satisfied.
    const email = req.shopCustomerEmail ?? null;
    const displayName = req.shopCustomerDisplayName ?? null;
    if (!customerId) {
      res.status(401).json({ error: "sign_in_required" });
      return;
    }
    try {
      // Ensure the user has a Stripe Customer. The portal session
      // requires one; getOrCreateStripeCustomer is idempotent and
      // safe under concurrent calls.
      const { stripeCustomerId } = await getOrCreateStripeCustomer(config, {
        customerId,
        email,
        displayName,
      });
      const stripe = getStripeClient(config);
      const session = await stripe.billingPortal.sessions.create({
        customer: stripeCustomerId,
        return_url: `${config.publicBaseUrl}${parsed.data.returnPath}`,
      });
      // Audit best-effort. The portal page itself is hosted by Stripe
      // and can change card / address / cancel a subscription, so
      // recording the open is meaningful for CSR look-back even
      // though we won't see what the customer changed until the
      // resulting webhooks arrive.
      await logAudit({
        action: "shop.billing_portal.opened",
        adminEmail: `customer:${email ?? customerId}`,
        adminUserId: null,
        targetTable: "shop_customers",
        targetId: customerId,
        metadata: { returnPath: parsed.data.returnPath },
        ip: req.ip ?? null,
        userAgent: req.get("user-agent") ?? null,
      }).catch((err) => {
        logger.warn({ err }, "billing-portal: audit failed");
      });
      res.status(200).json({ url: session.url });
    } catch (err) {
      // Log the error NAME only, never the .message — Stripe error
      // messages can occasionally embed key fragments and the test
      // contract explicitly pins this contract.
      logger.error(
        {
          errName: err instanceof Error ? err.name : "unknown",
          customerId,
        },
        "billing-portal: stripe session create failed",
      );
      res.status(502).json({ error: "stripe_portal_unavailable" });
    }
  },
);

export default router;
