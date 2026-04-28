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
import { eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import type Stripe from "stripe";

import { getDbPool, shopOrders } from "@workspace/resupply-db";

import { getStripeClient, readStripeConfigOrNull } from "./config";

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
        await markPaid(session, log);
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
      case "charge.refunded": {
        // charge.refunded gives us a Charge, not a Session. Resolve
        // back to our row via payment_intent — that field is set on
        // the row by markPaid().
        const charge = event.data.object as Stripe.Charge;
        if (charge.payment_intent && typeof charge.payment_intent === "string") {
          await markStatusByPaymentIntent(
            charge.payment_intent,
            "refunded",
            log,
          );
        }
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
    log?.error?.(
      { err: err instanceof Error ? err.message : String(err) },
      "stripe webhook handler threw — Stripe will retry",
    );
    res.status(500).json({ error: "internal_error" });
    return;
  }

  res.status(200).json({ received: true });
};

async function markPaid(
  session: Stripe.Checkout.Session,
  log: { info?: (...args: unknown[]) => void } | undefined,
): Promise<void> {
  const db = drizzle(getDbPool());
  const paymentIntentId =
    typeof session.payment_intent === "string"
      ? session.payment_intent
      : session.payment_intent?.id ?? null;

  await db
    .update(shopOrders)
    .set({
      status: "paid",
      stripePaymentIntentId: paymentIntentId,
      amountTotalCents: session.amount_total ?? null,
      currency: session.currency ?? null,
      paidAt: sql`now()`,
      updatedAt: sql`now()`,
    })
    .where(eq(shopOrders.stripeSessionId, session.id));

  log?.info?.(
    { amountCents: session.amount_total },
    "shop order marked paid",
  );
}

async function markStatus(
  sessionId: string,
  status: "expired" | "failed",
  log: { info?: (...args: unknown[]) => void } | undefined,
): Promise<void> {
  const db = drizzle(getDbPool());
  await db
    .update(shopOrders)
    .set({ status, updatedAt: sql`now()` })
    .where(eq(shopOrders.stripeSessionId, sessionId));
  log?.info?.({ status }, "shop order status updated");
}

async function markStatusByPaymentIntent(
  paymentIntentId: string,
  status: "refunded",
  log: { info?: (...args: unknown[]) => void } | undefined,
): Promise<void> {
  const db = drizzle(getDbPool());
  await db
    .update(shopOrders)
    .set({ status, updatedAt: sql`now()` })
    .where(eq(shopOrders.stripePaymentIntentId, paymentIntentId));
  log?.info?.({ status }, "shop order marked refunded");
}
