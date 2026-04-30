// /shop/me/reorder-suggestions — derive "time to reorder?" cards from
// purchase history.
//
// For each consumable category (cushion, filter, tubing, headgear,
// chamber) we look at the most recent paid purchase per productId and
// compare against a category-default replacement cadence. A product
// is "due" when daysSinceLastPurchase >= cadence; "due soon" when
// daysSinceLastPurchase >= cadence - 7.
//
// We deliberately do NOT include masks, accessories, or bundles —
// masks are durable goods (one-time purchase), accessories are too
// varied to apply a generic cadence, and bundles need to be exploded
// into their components which the catalog projection doesn't expose
// uniformly.
//
// Replacement cadences mirror the customer-education table on
// /learn/replacement-schedule (insurance-aligned defaults).

import { Router, type IRouter } from "express";
import { and, desc, eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";

import { getDbPool, shopOrderItems, shopOrders } from "@workspace/resupply-db";

import { requireSignedIn } from "../../middlewares/requireSignedIn";
import { readStripeConfigOrNull, getStripeClient } from "../../lib/stripe/config";
import { projectProduct, type ShopCategory } from "../../lib/stripe/products-meta";

const router: IRouter = Router();

const CATEGORY_CADENCE_DAYS: Partial<Record<ShopCategory, number>> = {
  cushion: 30,
  filter: 14,
  tubing: 90,
  headgear: 180,
  chamber: 180,
};

const DUE_SOON_LEAD_DAYS = 7;

router.get("/shop/me/reorder-suggestions", requireSignedIn, async (req, res) => {
  const clerkUserId = req.userClerkId!;
  const db = drizzle(getDbPool());

  // Per-product last purchase, scoped to PAID orders only. We
  // aggregate at the SQL layer (one row per product) rather than
  // pulling every line item into memory.
  const rows = await db
    .select({
      productId: shopOrderItems.productId,
      lastPaidAt: sql<Date>`max(${shopOrderItems.paidAt})`,
      totalQuantity: sql<number>`sum(${shopOrderItems.quantity})::int`,
    })
    .from(shopOrderItems)
    .innerJoin(shopOrders, eq(shopOrderItems.orderId, shopOrders.id))
    .where(
      and(
        eq(shopOrderItems.clerkUserId, clerkUserId),
        eq(shopOrders.status, "paid"),
      ),
    )
    .groupBy(shopOrderItems.productId)
    .orderBy(desc(sql`max(${shopOrderItems.paidAt})`))
    .limit(50);

  if (rows.length === 0) {
    res.json({ suggestions: [] });
    return;
  }

  // Look up product metadata for category + display name. Stripe
  // is the source of truth — we don't have a local mirror to read
  // category from, so we hit Stripe once with the unique product ids.
  const stripeConfig = readStripeConfigOrNull(process.env);
  if (!stripeConfig) {
    // Preview mode without a Stripe key — we can't classify products,
    // so we surface nothing rather than guess.
    res.json({ suggestions: [], previewMode: true });
    return;
  }

  const stripe = getStripeClient(stripeConfig);
  const productIds = Array.from(new Set(rows.map((r) => r.productId)));
  const productMap = new Map<
    string,
    { name: string; category: ShopCategory; imageUrl: string | null }
  >();

  // Stripe products.list is not actually paginating-by-id; we have
  // to fetch each id individually. Cap at 50 to bound the round-trip
  // count — the product list above is already capped at 50.
  await Promise.all(
    productIds.map(async (id) => {
      try {
        const product = await stripe.products.retrieve(id, {
          expand: ["default_price"],
        });
        if (product.deleted) return;
        const projected = projectProduct(product as never);
        if (!projected) return;
        productMap.set(id, {
          name: projected.name,
          category: projected.category,
          imageUrl: projected.imageUrl,
        });
      } catch (err) {
        req.log?.warn(
          { productId: id, err: err instanceof Error ? err.message : String(err) },
          "reorder-suggestions: stripe product lookup failed",
        );
      }
    }),
  );

  const now = new Date();
  const suggestions = rows
    .map((r) => {
      const meta = productMap.get(r.productId);
      if (!meta) return null;
      const cadence = CATEGORY_CADENCE_DAYS[meta.category];
      if (!cadence) return null; // mask / accessory / bundle — skip
      const lastPaidAt = new Date(r.lastPaidAt);
      const ageDays = Math.floor(
        (now.getTime() - lastPaidAt.getTime()) / (1000 * 60 * 60 * 24),
      );
      const dueOn = new Date(lastPaidAt.getTime() + cadence * 86400_000);
      const status: "overdue" | "due_soon" | "on_track" =
        ageDays >= cadence
          ? "overdue"
          : ageDays >= cadence - DUE_SOON_LEAD_DAYS
            ? "due_soon"
            : "on_track";
      return {
        productId: r.productId,
        productName: meta.name,
        category: meta.category,
        imageUrl: meta.imageUrl,
        cadenceDays: cadence,
        lastPaidAt: lastPaidAt.toISOString(),
        ageDays,
        dueOn: dueOn.toISOString(),
        status,
        totalQuantityHistorical: r.totalQuantity,
      };
    })
    .filter((s): s is NonNullable<typeof s> => s !== null)
    // Show overdue first, then due-soon. Hide on-track entirely from
    // the default list — those don't need an action card.
    .filter((s) => s.status !== "on_track")
    .sort((a, b) => b.ageDays - a.ageDays);

  res.json({ suggestions });
});

export default router;
