// /shop/me/subscriptions — patient-facing subscription management.
//
// Two endpoints, both Clerk-gated (signed-in users only):
//   GET  /shop/me/subscriptions          → list this user's subs
//   POST /shop/me/subscriptions/:id/cancel → flip cancel_at_period_end
//
// Cancellation contract:
//   * We do NOT call stripe.subscriptions.del() (immediate cancel).
//     v1 policy is "cancel at period end" — the patient already paid
//     for this billing period; let them have what they paid for.
//   * The optimistic flag flip (`cancel_at_period_end = true`) on
//     our row is intentionally optional — Stripe will fire
//     customer.subscription.updated which the webhook mirrors back.
//     We set it locally so the next /account render is immediately
//     consistent without waiting for the round-trip.
//
// We deliberately do NOT expose an "uncancel" endpoint in v1. If a
// patient wants to keep auto-shipping, they can let it run (no flag
// flip until the period ends) or contact support.

import { Router, type IRouter } from "express";
import { and, desc, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";

import { getDbPool, shopSubscriptions } from "@workspace/resupply-db";

import {
  getStripeClient,
  readStripeConfigOrNull,
} from "../../lib/stripe/config";
import { rateLimit } from "../../middlewares/rate-limit";
import { requireSignedIn } from "../../middlewares/requireSignedIn";

const router: IRouter = Router();

// Read-only list. No rate limit required — same shape and cost as
// /shop/me/orders, which is also unrate-limited at the route level.
router.get("/me/subscriptions", requireSignedIn, async (req, res) => {
  const clerkUserId = req.userClerkId;
  if (!clerkUserId) {
    // requireSignedIn should have already 401'd, but a belt-and-
    // suspenders guard avoids a TypeScript narrowing escape if the
    // middleware ever changes shape.
    res.status(401).json({ error: "sign_in_required" });
    return;
  }

  const db = drizzle(getDbPool());
  const rows = await db
    .select({
      id: shopSubscriptions.id,
      stripeSubscriptionId: shopSubscriptions.stripeSubscriptionId,
      status: shopSubscriptions.status,
      items: shopSubscriptions.items,
      currentPeriodEnd: shopSubscriptions.currentPeriodEnd,
      cancelAtPeriodEnd: shopSubscriptions.cancelAtPeriodEnd,
      canceledAt: shopSubscriptions.canceledAt,
      createdAt: shopSubscriptions.createdAt,
    })
    .from(shopSubscriptions)
    .where(eq(shopSubscriptions.clerkUserId, clerkUserId))
    .orderBy(desc(shopSubscriptions.createdAt))
    .limit(50);

  res.json({
    subscriptions: rows.map((r) => ({
      id: r.id,
      stripeSubscriptionId: r.stripeSubscriptionId,
      status: r.status,
      items: r.items,
      currentPeriodEnd:
        r.currentPeriodEnd?.toISOString() ?? null,
      cancelAtPeriodEnd: r.cancelAtPeriodEnd,
      canceledAt: r.canceledAt?.toISOString() ?? null,
      createdAt: r.createdAt.toISOString(),
    })),
  });
});

// Cancel-at-period-end. Rate-limited modestly because this hits the
// Stripe API (5/min/IP is plenty — patients cancel at most once per
// subscription).
router.post(
  "/me/subscriptions/:id/cancel",
  requireSignedIn,
  rateLimit({ windowMs: 60_000, max: 5, name: "shop:cancel-sub" }),
  async (req, res) => {
    const clerkUserId = req.userClerkId;
    if (!clerkUserId) {
      res.status(401).json({ error: "sign_in_required" });
      return;
    }

    const localId = req.params.id;
    if (!localId || typeof localId !== "string") {
      res.status(400).json({ error: "missing_subscription_id" });
      return;
    }

    const db = drizzle(getDbPool());
    // Look up the row by our local id AND owner — never by stripe
    // subscription id directly, to make IDOR via guessing
    // sub_xxx values impossible. Belt-and-suspenders: also gate on
    // clerk_user_id match, so a stolen id from one patient can't
    // cancel another's auto-ship.
    const rows = await db
      .select({
        id: shopSubscriptions.id,
        stripeSubscriptionId: shopSubscriptions.stripeSubscriptionId,
        status: shopSubscriptions.status,
        cancelAtPeriodEnd: shopSubscriptions.cancelAtPeriodEnd,
      })
      .from(shopSubscriptions)
      .where(
        and(
          eq(shopSubscriptions.id, localId),
          eq(shopSubscriptions.clerkUserId, clerkUserId),
        ),
      )
      .limit(1);
    const sub = rows[0];
    if (!sub) {
      // 404 — don't leak whether the id exists for a different
      // owner. The frontend never calls this endpoint with a foreign
      // id under normal use.
      res.status(404).json({ error: "subscription_not_found" });
      return;
    }
    if (sub.status === "canceled") {
      // Idempotent — already canceled; report success without
      // bothering Stripe.
      res.json({ ok: true, alreadyCanceled: true });
      return;
    }

    const config = readStripeConfigOrNull();
    if (!config) {
      res.status(503).json({ error: "shop_unavailable" });
      return;
    }
    const stripe = getStripeClient(config);

    try {
      await stripe.subscriptions.update(sub.stripeSubscriptionId, {
        cancel_at_period_end: true,
      });
    } catch (err) {
      req.log?.error(
        {
          err: err instanceof Error ? err.message : String(err),
          subscriptionId: sub.stripeSubscriptionId,
        },
        "stripe.subscriptions.update(cancel_at_period_end) failed",
      );
      res.status(502).json({ error: "stripe_update_failed" });
      return;
    }

    // Optimistic local flip — the webhook will mirror this back, but
    // the immediate next page render shouldn't show "active" with
    // no cancel flag.
    await db
      .update(shopSubscriptions)
      .set({ cancelAtPeriodEnd: true })
      .where(eq(shopSubscriptions.id, sub.id));

    res.json({ ok: true });
  },
);

export default router;
