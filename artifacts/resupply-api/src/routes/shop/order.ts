// GET /shop/orders/:sessionId — used by the success page to render
// "what did I just buy?".
//
// Public (no auth): the session ID is a long opaque token (`cs_test_*`
// or `cs_live_*`, 70+ chars of entropy). Anyone who has it already
// either *is* the buyer or has stolen the success URL — we treat
// possession of the session ID as the access grant. We deliberately
// do NOT return billing card details, the shipping email, or the
// shipping address phone number; the shipping address itself we
// surface only as `addressCity` + `addressState` so the UI can show
// "Shipping to Atlanta, GA" without exposing the full street to a
// shoulder-surfer.

import { Router, type IRouter } from "express";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";

import { getDbPool, shopOrders } from "@workspace/resupply-db";

import {
  SHOP_UNAVAILABLE_BODY,
  getStripeClient,
  readStripeConfigOrNull,
} from "../../lib/stripe/config";

const SESSION_ID_RE = /^cs_(test|live)_[A-Za-z0-9]{20,}$/;

const router: IRouter = Router();

router.get("/shop/orders/:sessionId", async (req, res) => {
  const config = readStripeConfigOrNull();
  if (!config) {
    res.status(503).json(SHOP_UNAVAILABLE_BODY);
    return;
  }

  const sessionId = req.params.sessionId;
  if (!SESSION_ID_RE.test(sessionId)) {
    res.status(400).json({ error: "invalid_session_id" });
    return;
  }

  // Local guard: the session must exist in our shop_orders table.
  // This stops an attacker from probing arbitrary session IDs from
  // unrelated Stripe accounts (Stripe would 404 those, but we'd
  // rather not even ask).
  const db = drizzle(getDbPool());
  const local = await db
    .select()
    .from(shopOrders)
    .where(eq(shopOrders.stripeSessionId, sessionId))
    .limit(1);
  if (local.length === 0) {
    res.status(404).json({ error: "order_not_found" });
    return;
  }

  const stripe = getStripeClient(config);
  let session;
  try {
    session = await stripe.checkout.sessions.retrieve(sessionId, {
      expand: ["line_items.data.price.product"],
    });
  } catch (err) {
    req.log?.warn(
      { err: err instanceof Error ? err.message : String(err) },
      "stripe checkout.sessions.retrieve failed",
    );
    res.status(502).json({ error: "stripe_retrieve_failed" });
    return;
  }

  // collected_information.shipping_details supersedes the legacy
  // top-level shipping_details on newer Stripe API versions; we
  // accept either to be tolerant across SDK upgrades.
  const shipping =
    session.collected_information?.shipping_details ??
    // Stripe deprecated this field but still populates it on older
    // API versions; cast through unknown so we don't fight the SDK
    // types when the field is missing on the union.
    (session as unknown as { shipping_details?: { address?: { city?: string | null; state?: string | null } } })
      .shipping_details ??
    null;

  const lineItems = session.line_items?.data ?? [];

  res.json({
    sessionId: session.id,
    status: local[0]?.status ?? "pending",
    paymentStatus: session.payment_status,
    amountTotalCents: session.amount_total,
    currency: session.currency,
    lineItems: lineItems.map((li) => {
      const product = li.price?.product;
      const productName =
        product && typeof product !== "string" && !product.deleted
          ? product.name
          : (li.description ?? "Item");
      return {
        name: productName,
        quantity: li.quantity ?? 1,
        amountSubtotalCents: li.amount_subtotal,
      };
    }),
    shippingCity: shipping?.address?.city ?? null,
    shippingState: shipping?.address?.state ?? null,
  });
});

export default router;
