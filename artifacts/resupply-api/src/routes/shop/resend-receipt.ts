// POST /shop/me/orders/:sessionId/resend-receipt — re-send the
// Stripe email receipt for a paid order to the original purchaser
// (C8 of the deep review).
//
// Why a dedicated route:
//   The auto-receipt is fired exactly once when Stripe finalizes
//   the charge. If the email lands in spam, gets deleted, or the
//   customer simply forgets, there's no way to recover it from
//   the customer dashboard. Stripe's documented "re-send" path is
//   to update the charge's `receipt_email` — even setting it to
//   the same value re-triggers the email. We expose that as a
//   one-click button on the order history card.
//
// Ownership rule (HARD):
//   The handler ONLY proceeds when shop_orders.clerk_user_id
//   equals the caller's clerk id AND the order is `paid`.
//   Anything else returns 404 to avoid leaking the existence of
//   another user's session id by id-probing.
//
// Failure modes (deliberate 4xx vs 5xx split):
//   - 404 not_found     — no row, wrong owner, or status != paid
//   - 409 not_payable   — Stripe session has no PI / no charge
//                         (shouldn't happen for paid orders, but
//                         we treat it as "user can't action this"
//                         instead of an alarm-level 5xx)
//   - 503 stripe_unavailable — Stripe credentials missing
//   - 502 stripe_error  — Stripe call itself failed
//
// We deliberately rate-limit at the customer level: max 5
// re-sends per session per 10 minutes. Stripe itself imposes no
// rate limit on charge.update, but a stuck/spamming customer
// could rack up dozens of identical emails — which would look
// like a phishing attack to inboxes and trip our SendGrid
// reputation. The limit is in-process (per pod) — good enough at
// our scale, and a future redis upgrade is a one-line change.

import { Router, type IRouter } from "express";
import { and, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import type Stripe from "stripe";

import { getDbPool, shopOrders } from "@workspace/resupply-db";

import { requireSignedIn } from "../../middlewares/requireSignedIn";
import {
  getStripeClient,
  readStripeConfigOrNull,
} from "../../lib/stripe/config";

const router: IRouter = Router();

// In-process rate limit: { key: sessionId+clerkId } -> sliding window of timestamps.
// 10 min window, 5 sends max. Cleared lazily on next access of the
// same key — we don't sweep the whole map periodically because the
// memory cost of a stale entry is ~80 bytes and it gets garbage
// collected on process restart anyway.
const RATE_WINDOW_MS = 10 * 60 * 1000;
const RATE_MAX = 5;
const rateBuckets = new Map<string, number[]>();

function rateLimited(key: string): boolean {
  const now = Date.now();
  const cutoff = now - RATE_WINDOW_MS;
  const prev = rateBuckets.get(key) ?? [];
  const fresh = prev.filter((t) => t > cutoff);
  if (fresh.length >= RATE_MAX) {
    rateBuckets.set(key, fresh);
    return true;
  }
  fresh.push(now);
  rateBuckets.set(key, fresh);
  return false;
}

router.post(
  "/shop/me/orders/:sessionId/resend-receipt",
  requireSignedIn,
  async (req, res) => {
    // Express's RequestHandler types `req.params` as
    // `string | string[]` for unknown-shape route params under our
    // strict tsconfig — the array variant only happens for repeated
    // wildcard segments (which this route doesn't use), but we
    // narrow defensively rather than `as string` so a future
    // refactor can't silently break the assertion.
    const rawSessionId = req.params.sessionId;
    const sessionId =
      typeof rawSessionId === "string" ? rawSessionId : (rawSessionId?.[0] ?? "");
    const clerkId = req.userClerkId!;

    // sessionId is path-segment-bounded by Express but we still
    // sanity-check shape — Stripe ids are URL-safe ASCII and short
    // enough that a 256-char ceiling rejects garbage cheaply.
    if (
      !sessionId ||
      sessionId.length > 256 ||
      !/^[A-Za-z0-9_-]+$/.test(sessionId)
    ) {
      res.status(404).json({ error: "not_found" });
      return;
    }

    const stripeConfig = readStripeConfigOrNull(process.env);
    if (!stripeConfig) {
      res.status(503).json({ error: "stripe_unavailable" });
      return;
    }
    const stripe = getStripeClient(stripeConfig);

    const db = drizzle(getDbPool());
    // Combined ownership + status check so a single SELECT returns
    // either "yes you can re-send" or "treat as not found". We
    // intentionally don't differentiate "wrong owner" from "missing"
    // in the response — both leak information.
    const [orderRow] = await db
      .select({
        id: shopOrders.id,
        stripeSessionId: shopOrders.stripeSessionId,
      })
      .from(shopOrders)
      .where(
        and(
          eq(shopOrders.stripeSessionId, sessionId),
          eq(shopOrders.clerkUserId, clerkId),
          eq(shopOrders.status, "paid"),
        ),
      )
      .limit(1);

    if (!orderRow) {
      res.status(404).json({ error: "not_found" });
      return;
    }

    const rateKey = `${clerkId}|${sessionId}`;
    if (rateLimited(rateKey)) {
      res.status(429).json({ error: "rate_limited" });
      return;
    }

    let session: Stripe.Checkout.Session;
    try {
      // Expanding payment_intent.latest_charge in a single retrieve
      // saves a round-trip versus retrieving the PI separately.
      // Both nested expands are documented and supported.
      session = await stripe.checkout.sessions.retrieve(sessionId, {
        expand: ["payment_intent.latest_charge"],
      });
    } catch (err) {
      req.log.error(
        { err, sessionId },
        "stripe checkout.sessions.retrieve failed (resend-receipt)",
      );
      res.status(502).json({ error: "stripe_error" });
      return;
    }

    // Walk the expanded chain. Both rungs need a present, non-string
    // value — Stripe returns a string id when the field was NOT
    // expanded, which would mean our retrieve call was wrong.
    const pi = session.payment_intent;
    if (!pi || typeof pi === "string") {
      res.status(409).json({ error: "not_payable" });
      return;
    }
    const charge = pi.latest_charge;
    if (!charge || typeof charge === "string") {
      res.status(409).json({ error: "not_payable" });
      return;
    }

    // Resolve the destination email. Order of preference:
    //   1. The charge's existing receipt_email (so re-sending goes
    //      to wherever Stripe already sent it)
    //   2. The session's customer_details.email (collected at
    //      Checkout — present for our setup since we don't pass
    //      customer_email upfront)
    //   3. The Customer object's email if a customer is attached
    // If none resolve we 409 — better than blasting a blank update
    // and getting a Stripe error.
    // Customer object is `Customer | DeletedCustomer | string | null`
    // when expanded — DeletedCustomer has no `email` field. We treat
    // a deleted customer as "no fallback" since the customer record
    // has been scrubbed and we can't trust any cached email.
    const customerObj = session.customer;
    const customerEmail =
      customerObj &&
      typeof customerObj === "object" &&
      !("deleted" in customerObj && customerObj.deleted)
        ? (customerObj as { email?: string | null }).email ?? null
        : null;
    const fallbackEmail =
      charge.receipt_email ??
      session.customer_details?.email ??
      customerEmail;
    if (!fallbackEmail) {
      res.status(409).json({ error: "not_payable" });
      return;
    }

    try {
      // The crucial bit: Stripe re-sends the receipt iff the
      // `receipt_email` field on the charge is updated. Setting it
      // to the same string still counts as an update from Stripe's
      // perspective — confirmed in their docs and via testing.
      await stripe.charges.update(charge.id, {
        receipt_email: fallbackEmail,
      });
    } catch (err) {
      req.log.error(
        { err, sessionId, chargeId: charge.id },
        "stripe charges.update failed (resend-receipt)",
      );
      res.status(502).json({ error: "stripe_error" });
      return;
    }

    // Mask the email in the response — the customer presumably
    // knows their own email, and a raw echo would leak the address
    // into logs / browser DevTools.
    res.status(200).json({ sent: true, email: maskEmail(fallbackEmail) });
  },
);

// Mask "alice.smith@example.com" -> "a***@example.com". Keeps just
// enough signal that the customer recognizes it ("yes that's me")
// without a verbatim copy in the response body. The mask handles
// short locals (1-2 chars) by collapsing the visible prefix to the
// first character only.
function maskEmail(email: string): string {
  const at = email.lastIndexOf("@");
  if (at < 1) return "***";
  const local = email.slice(0, at);
  const domain = email.slice(at);
  const head = local.slice(0, 1);
  return `${head}***${domain}`;
}

export default router;
