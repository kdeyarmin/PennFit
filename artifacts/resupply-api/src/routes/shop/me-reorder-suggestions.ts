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

import { getSupabaseServiceRoleClient } from "@workspace/resupply-db";

import { requireSignedIn } from "../../middlewares/requireSignedIn";
import {
  readStripeConfigOrNull,
  getStripeClient,
} from "../../lib/stripe/config";
import {
  projectProduct,
  type ShopCategory,
} from "../../lib/stripe/products-meta";
import { stripeErrLogFields } from "../../lib/stripe/err-log-fields";

const router: IRouter = Router();

const CATEGORY_CADENCE_DAYS: Partial<Record<ShopCategory, number>> = {
  cushion: 30,
  filter: 14,
  tubing: 90,
  headgear: 180,
  chamber: 180,
};

const DUE_SOON_LEAD_DAYS = 7;

router.get(
  "/shop/me/reorder-suggestions",
  requireSignedIn,
  async (req, res) => {
    const customerId = req.userCustomerId!;
    const supabase = getSupabaseServiceRoleClient();

    // PostgREST has no GROUP BY / aggregate, so we fetch the line
    // items + their parent order statuses and aggregate in JS. The
    // original SQL also INNER JOINed on shop_orders.status='paid';
    // we replicate that with a bulk-fetch + Map filter.
    //
    // Cap the line-item scan at 200 rows (was 1000). This is a
    // per-customer hot-path query on every /shop/me dashboard load.
    // Rows are ordered paid_at DESC, and the output is "reorder
    // suggestions" — recently-purchased products. The 200 most-recent
    // line items capture every product a customer has bought recently;
    // the long tail (their 201st-oldest+ line item) is stale purchase
    // history that's not a reorder candidate, so trimming it doesn't
    // change the surfaced suggestions while cutting the worst-case
    // transfer 5×.
    const { data: items, error: itemsErr } = await supabase
      .schema("resupply")
      .from("shop_order_items")
      .select("order_id, product_id, paid_at, quantity")
      .eq("customer_id", customerId)
      .order("paid_at", { ascending: false })
      .limit(200);
    if (itemsErr) throw itemsErr;

    const orderIds = Array.from(new Set((items ?? []).map((i) => i.order_id)));
    let paidOrderIds = new Set<string>();
    if (orderIds.length > 0) {
      const { data: orders, error: ordersErr } = await supabase
        .schema("resupply")
        .from("shop_orders")
        .select("id, status")
        .in("id", orderIds);
      if (ordersErr) throw ordersErr;
      paidOrderIds = new Set(
        (orders ?? []).filter((o) => o.status === "paid").map((o) => o.id),
      );
    }

    // Group: per product, MAX(paid_at) + SUM(quantity).
    const grouped = new Map<
      string,
      { lastPaidAt: Date; totalQuantity: number }
    >();
    for (const it of items ?? []) {
      if (!paidOrderIds.has(it.order_id)) continue;
      // paid_at is nullable (migration 0320): an unpaid/dispensed line
      // has no paid date. Such lines are already filtered out by the
      // paid-order guard above, but null-check defensively before Date().
      if (!it.paid_at) continue;
      const paidAt = new Date(it.paid_at);
      const existing = grouped.get(it.product_id);
      if (!existing) {
        grouped.set(it.product_id, {
          lastPaidAt: paidAt,
          totalQuantity: it.quantity,
        });
      } else {
        if (paidAt.getTime() > existing.lastPaidAt.getTime()) {
          existing.lastPaidAt = paidAt;
        }
        existing.totalQuantity += it.quantity;
      }
    }
    const rows = Array.from(grouped.entries())
      .map(([productId, agg]) => ({
        productId,
        lastPaidAt: agg.lastPaidAt,
        totalQuantity: agg.totalQuantity,
      }))
      .sort((a, b) => b.lastPaidAt.getTime() - a.lastPaidAt.getTime())
      .slice(0, 50);

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
            {
              productId: id,
              ...stripeErrLogFields(err),
            },
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
        const lastPaidAt = r.lastPaidAt;
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
  },
);

export default router;
