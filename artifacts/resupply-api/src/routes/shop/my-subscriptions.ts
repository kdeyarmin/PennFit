// /shop/me/subscriptions — patient-facing subscription management.
//
// Endpoints, all auth-gated (signed-in users only):
//   GET  /shop/me/subscriptions               → list this user's subs
//   POST /shop/me/subscriptions/:id/cancel    → flip cancel_at_period_end
//   POST /shop/me/subscriptions/:id/pause     → pause_collection { void }
//   POST /shop/me/subscriptions/:id/resume    → clear pause_collection
//   POST /shop/me/subscriptions/:id/cadence   → swap to a different
//                                                recurring price on the
//                                                same product
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
// Pause / resume contract (T-C5):
//   * `pause_collection: { behavior: 'void' }` skips the next billing
//     cycle without ending the subscription. Stripe keeps `status`
//     as `active`; the pause state lives in the `pause_collection`
//     field. Customers can resume any time before they cancel.
//   * Resume sends `pause_collection: ''` (the Stripe REST shape
//     for "clear"); the SDK accepts an empty string here.
//   * No local schema for pause state in v1. The webhook already
//     mirrors `customer.subscription.updated`; if we later add a
//     `paused_at` column, the existing handler can populate it.
//
// Cadence-change contract (T-C5):
//   * Body `{ priceId }`. We retrieve the price from Stripe (no
//     server-trusted client lookup) and require:
//       - price.type === 'recurring'
//       - price.product matches the existing single subscription
//         item's productId
//       - price.id !== current price (no-op short-circuit returns 200
//         { unchanged: true } so retries are idempotent)
//   * We swap with `proration_behavior: 'none'` — patients moving
//     from "every 30 days" to "every 60 days" should not be charged
//     a partial invoice; the new cadence takes effect at the next
//     period end.
//   * Multi-item subscriptions are out of scope for v1; we 409 with
//     `multi_item_subscription` rather than guessing which item to
//     swap.
//
// We deliberately do NOT expose an "uncancel" endpoint in v1. If a
// patient wants to keep auto-shipping, they can let it run (no flag
// flip until the period ends) or contact support.

import { Router, type IRouter, type Request, type Response } from "express";
import { z } from "zod";
import { and, desc, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import type Stripe from "stripe";

import { getDbPool, shopSubscriptions } from "@workspace/resupply-db";

import {
  getStripeClient,
  readStripeConfigOrNull,
} from "../../lib/stripe/config";
import { rateLimit } from "../../middlewares/rate-limit";
import { requireSignedIn } from "../../middlewares/requireSignedIn";

const router: IRouter = Router();

// Shared owner-lookup. Returns the subscription row matched on BOTH
// (id, customerId) so a leaked id from another patient can't be
// targeted. Returns null if not found OR not owned — caller maps to
// 404 to avoid leaking ownership. Drizzle infers `items` from the
// schema's `$type<ShopSubscriptionItemSnapshot[]>()` annotation, so
// no explicit return type is needed here.
async function findOwnedSubscription(
  db: ReturnType<typeof drizzle>,
  localId: string,
  customerId: string,
) {
  const rows = await db
    .select({
      id: shopSubscriptions.id,
      stripeSubscriptionId: shopSubscriptions.stripeSubscriptionId,
      status: shopSubscriptions.status,
      cancelAtPeriodEnd: shopSubscriptions.cancelAtPeriodEnd,
      items: shopSubscriptions.items,
    })
    .from(shopSubscriptions)
    .where(
      and(
        eq(shopSubscriptions.id, localId),
        eq(shopSubscriptions.customerId, customerId),
      ),
    )
    .limit(1);
  return rows[0] ?? null;
}

// Read-only list. No rate limit required — same shape and cost as
// /shop/me/orders, which is also unrate-limited at the route level.
router.get("/me/subscriptions", requireSignedIn, async (req, res) => {
  const customerId = req.userCustomerId;
  if (!customerId) {
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
    .where(eq(shopSubscriptions.customerId, customerId))
    .orderBy(desc(shopSubscriptions.createdAt))
    .limit(50);

  res.json({
    subscriptions: rows.map((r) => ({
      id: r.id,
      stripeSubscriptionId: r.stripeSubscriptionId,
      status: r.status,
      items: r.items,
      currentPeriodEnd: r.currentPeriodEnd?.toISOString() ?? null,
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
    const customerId = req.userCustomerId;
    if (!customerId) {
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
    // customer_id match, so a stolen id from one patient can't
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
          eq(shopSubscriptions.customerId, customerId),
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

// GET /me/subscriptions/:id/cadence-options — list alternate
// recurring prices the patient could swap to. We deliberately
// return only the SAME-product prices, not every price in the
// catalog — the cadence-change endpoint enforces the same rule, so
// surfacing anything else would be a UX trap.
//
// Includes the CURRENT price too (so the dropdown can render a
// selected state), tagged with `isCurrent: true`. The frontend can
// disable that option client-side or just rely on the server-side
// idempotent short-circuit if the user picks it.
//
// We hit Stripe live (no caching) — these calls are bounded by
// "patient opens the cadence dialog" (rare) and stripe.prices.list
// is one of the cheaper API endpoints. If catalog growth ever
// becomes an issue we can back this with the existing products
// projection.
router.get(
  "/me/subscriptions/:id/cadence-options",
  requireSignedIn,
  async (req, res) => {
    const customerId = req.userCustomerId;
    if (!customerId) {
      res.status(401).json({ error: "sign_in_required" });
      return;
    }
    const localId = req.params.id;
    if (!localId || typeof localId !== "string") {
      res.status(400).json({ error: "missing_subscription_id" });
      return;
    }

    const db = drizzle(getDbPool());
    const sub = await findOwnedSubscription(db, localId, customerId);
    if (!sub) {
      res.status(404).json({ error: "subscription_not_found" });
      return;
    }
    if (sub.items.length !== 1) {
      // Same v1 limitation as the cadence endpoint itself.
      res.status(409).json({ error: "multi_item_subscription" });
      return;
    }
    const item = sub.items[0]!;
    if (!item.productId) {
      // No product reference — can't list alternates. Most likely a
      // legacy snapshot from before products-meta backfill.
      res.json({ options: [] });
      return;
    }

    const config = readStripeConfigOrNull();
    if (!config) {
      res.status(503).json({ error: "shop_unavailable" });
      return;
    }
    const stripe = getStripeClient(config);

    let priceList: Stripe.ApiList<Stripe.Price>;
    try {
      priceList = await stripe.prices.list({
        product: item.productId,
        type: "recurring",
        active: true,
        limit: 50,
      });
    } catch (err) {
      req.log?.warn(
        {
          err: err instanceof Error ? err.message : String(err),
          productId: item.productId,
        },
        "stripe.prices.list(cadence-options) failed",
      );
      res.json({ options: [] });
      return;
    }

    // Project to a stable client shape. Sort by interval-in-days so
    // the dropdown reads naturally (30 days, 60 days, 90 days, …).
    const intervalToDays = (interval: string): number => {
      switch (interval) {
        case "day":
          return 1;
        case "week":
          return 7;
        case "month":
          return 30;
        case "year":
          return 365;
        default:
          return 0;
      }
    };
    const formatLabel = (interval: string, count: number): string =>
      count === 1 ? interval : `${count} ${interval}s`;

    const options = priceList.data
      .filter((p) => p.recurring)
      .map((p) => {
        const r = p.recurring!;
        const days = intervalToDays(r.interval) * (r.interval_count ?? 1);
        return {
          priceId: p.id,
          intervalLabel: formatLabel(r.interval, r.interval_count ?? 1),
          unitAmountCents: p.unit_amount ?? null,
          currency: p.currency ?? null,
          isCurrent: p.id === item.priceId,
          // Used for sorting only; not surfaced to the UI.
          _sortDays: days,
        };
      })
      .sort((a, b) => a._sortDays - b._sortDays)
      .map(({ _sortDays: _drop, ...rest }) => rest);

    res.json({ options });
  },
);

// Pause / resume share most of their structure (auth, ownership,
// status guards, Stripe-config check, error envelope). The only
// difference is the `pause_collection` payload sent to Stripe and
// the audit verb in logs. We factor the shared body into a helper
// and parameterise on the verb + the payload builder.
type PauseVerb = "pause" | "resume";

async function handlePauseOrResume(
  verb: PauseVerb,
  req: Request,
  res: Response,
): Promise<void> {
  const customerId = req.userCustomerId;
  if (!customerId) {
    res.status(401).json({ error: "sign_in_required" });
    return;
  }

  const localId = req.params.id;
  if (!localId || typeof localId !== "string") {
    res.status(400).json({ error: "missing_subscription_id" });
    return;
  }

  const db = drizzle(getDbPool());
  const sub = await findOwnedSubscription(db, localId, customerId);
  if (!sub) {
    res.status(404).json({ error: "subscription_not_found" });
    return;
  }
  if (sub.status === "canceled") {
    // Can't pause or resume a canceled sub. The /account UI hides the
    // controls in this state; this is the belt-and-suspenders check
    // for a stale tab that POSTs after cancellation went through.
    res.status(409).json({ error: "subscription_canceled" });
    return;
  }

  const config = readStripeConfigOrNull();
  if (!config) {
    res.status(503).json({ error: "shop_unavailable" });
    return;
  }
  const stripe = getStripeClient(config);

  // Stripe accepts either a structured pause_collection object or
  // empty string to clear. The SDK's TypeScript shape is awkward
  // here — `'' as never` is the documented escape hatch when the
  // generated type doesn't include the empty-string variant.
  const payload: Stripe.SubscriptionUpdateParams =
    verb === "pause"
      ? { pause_collection: { behavior: "void" } }
      : { pause_collection: "" as unknown as never };

  try {
    await stripe.subscriptions.update(sub.stripeSubscriptionId, payload);
  } catch (err) {
    req.log?.error(
      {
        verb,
        err: err instanceof Error ? err.message : String(err),
        subscriptionId: sub.stripeSubscriptionId,
      },
      `stripe.subscriptions.update(${verb}) failed`,
    );
    res.status(502).json({ error: "stripe_update_failed" });
    return;
  }

  // No local mirror: pause_collection isn't on our schema in v1.
  // The webhook (customer.subscription.updated) will fire and the
  // /account page will see fresh state on next refresh. The button
  // UI flips optimistically client-side.
  res.json({ ok: true });
}

router.post(
  "/me/subscriptions/:id/pause",
  requireSignedIn,
  rateLimit({ windowMs: 60_000, max: 5, name: "shop:pause-sub" }),
  (req, res) => {
    void handlePauseOrResume("pause", req, res);
  },
);

router.post(
  "/me/subscriptions/:id/resume",
  requireSignedIn,
  rateLimit({ windowMs: 60_000, max: 5, name: "shop:resume-sub" }),
  (req, res) => {
    void handlePauseOrResume("resume", req, res);
  },
);

// Cadence change. Body: { priceId }. Swaps the (single) subscription
// item to a different recurring price on the SAME product. We
// validate against Stripe (price must be recurring + product must
// match the existing item), short-circuit if the new price equals
// the current one, and never proration-bill — the new cadence takes
// effect at the next period end.
const cadenceBody = z.object({
  priceId: z.string().min(1).max(128),
});

router.post(
  "/me/subscriptions/:id/cadence",
  requireSignedIn,
  rateLimit({ windowMs: 60_000, max: 5, name: "shop:cadence-sub" }),
  async (req, res) => {
    const customerId = req.userCustomerId;
    if (!customerId) {
      res.status(401).json({ error: "sign_in_required" });
      return;
    }

    const localId = req.params.id;
    if (!localId || typeof localId !== "string") {
      res.status(400).json({ error: "missing_subscription_id" });
      return;
    }

    const parsed = cadenceBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({
        error: "invalid_body",
        issues: parsed.error.flatten(),
      });
      return;
    }
    const { priceId: newPriceId } = parsed.data;

    const db = drizzle(getDbPool());
    const sub = await findOwnedSubscription(db, localId, customerId);
    if (!sub) {
      res.status(404).json({ error: "subscription_not_found" });
      return;
    }
    if (sub.status === "canceled") {
      res.status(409).json({ error: "subscription_canceled" });
      return;
    }
    if (sub.items.length !== 1) {
      // v1 only supports single-item subscriptions (one product per
      // sub). A multi-item sub came from a different code path; we
      // don't know which item to swap.
      res.status(409).json({ error: "multi_item_subscription" });
      return;
    }
    const item = sub.items[0]!;
    if (item.priceId === newPriceId) {
      // Idempotent no-op. Returning 200 here means a retry of an
      // already-applied change doesn't appear to fail.
      res.json({ ok: true, unchanged: true });
      return;
    }

    const config = readStripeConfigOrNull();
    if (!config) {
      res.status(503).json({ error: "shop_unavailable" });
      return;
    }
    const stripe = getStripeClient(config);

    // Validate the target price is (a) recurring and (b) on the same
    // product as the current item. Fetching from Stripe — never trust
    // the client to assert these properties.
    let newPrice: Stripe.Price;
    try {
      newPrice = await stripe.prices.retrieve(newPriceId);
    } catch (err) {
      req.log?.warn(
        {
          err: err instanceof Error ? err.message : String(err),
          priceId: newPriceId,
        },
        "stripe.prices.retrieve(cadence) failed",
      );
      res.status(400).json({ error: "invalid_price" });
      return;
    }
    if (newPrice.type !== "recurring" || !newPrice.recurring) {
      res.status(400).json({ error: "price_not_recurring" });
      return;
    }
    const newProductId =
      typeof newPrice.product === "string"
        ? newPrice.product
        : (newPrice.product?.id ?? null);
    if (!newProductId || !item.productId || newProductId !== item.productId) {
      res.status(400).json({ error: "price_product_mismatch" });
      return;
    }

    // We need the Stripe subscription ITEM id (`si_xxx`) to swap —
    // we don't store this locally. Fetch the subscription, find the
    // single item id, and swap.
    let liveSub: Stripe.Subscription;
    try {
      liveSub = await stripe.subscriptions.retrieve(sub.stripeSubscriptionId);
    } catch (err) {
      req.log?.error(
        {
          err: err instanceof Error ? err.message : String(err),
          subscriptionId: sub.stripeSubscriptionId,
        },
        "stripe.subscriptions.retrieve(cadence) failed",
      );
      res.status(502).json({ error: "stripe_fetch_failed" });
      return;
    }
    const liveItems = liveSub.items?.data ?? [];
    if (liveItems.length !== 1) {
      // Stripe disagrees with our snapshot. Bail rather than guess.
      res.status(409).json({ error: "multi_item_subscription" });
      return;
    }
    const liveItemId = liveItems[0]!.id;

    try {
      await stripe.subscriptions.update(sub.stripeSubscriptionId, {
        items: [{ id: liveItemId, price: newPriceId }],
        proration_behavior: "none",
      });
    } catch (err) {
      req.log?.error(
        {
          err: err instanceof Error ? err.message : String(err),
          subscriptionId: sub.stripeSubscriptionId,
          newPriceId,
        },
        "stripe.subscriptions.update(cadence) failed",
      );
      res.status(502).json({ error: "stripe_update_failed" });
      return;
    }

    // Webhook will mirror items back; no local optimistic write
    // here because items is a jsonb snapshot and we don't have the
    // new price's display fields (name, intervalLabel, unit amount).
    res.json({ ok: true });
  },
);

export default router;
