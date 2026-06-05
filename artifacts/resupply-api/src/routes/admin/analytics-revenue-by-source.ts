// GET /admin/analytics/revenue-by-source?days=30        — JSON
// GET /admin/analytics/revenue-by-source.csv?days=30    — CSV
//
// Closed-loop measurement (roadmap Lever 3): a single view of where order
// VOLUME and cash REVENUE come from, across the three independent order
// channels PennFit captures through:
//   * storefront (cash-pay Stripe)      → resupply.shop_orders (has $)
//   * resupply fulfillment (insurance)  → resupply.fulfillments (units)
//   * clinical intake form              → public.orders (count only)
//
// Read-only window-bounded aggregation in the established analytics shape
// (route reads, lib/analytics/revenue-by-source.ts reduces). No new
// schema. `reports.read` gated like the sibling analytics routes.
//
// PHI: public.orders carries patient PHI columns, so it is counted
// head-only (no row data pulled). shop_orders / fulfillments rows here
// hold no PHI (status + amount + quantity only).

import { Router, type IRouter } from "express";
import { z } from "zod";

import { getSupabaseServiceRoleClient } from "@workspace/resupply-db";

import {
  aggregateRevenueBySource,
  type FulfillmentRow,
  type ShopOrderRow,
} from "../../lib/analytics/revenue-by-source";
import { safeCsvCell } from "../../lib/safe-csv-cell";
import { requirePermission } from "../../middlewares/requireAdmin";

const router: IRouter = Router();

const windowSchema = z.object({
  days: z.coerce.number().int().min(1).max(365).optional().default(30),
});

const READ_CAP = 50_000;

function isoDaysAgo(days: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString();
}

async function loadRevenueBySource(cutoff: string) {
  const supabase = getSupabaseServiceRoleClient();

  const [shopRes, fulRes, clinicalRes] = await Promise.all([
    supabase
      .schema("resupply")
      .from("shop_orders")
      .select("status, amount_total_cents")
      .gte("created_at", cutoff)
      .limit(READ_CAP),
    supabase
      .schema("resupply")
      .from("fulfillments")
      .select("status, quantity")
      .gte("created_at", cutoff)
      .limit(READ_CAP),
    // Head-only count — public.orders holds PHI; we never pull its rows.
    supabase
      .schema("public")
      .from("orders")
      .select("id", { count: "exact", head: true })
      .gte("created_at", cutoff),
  ]);
  if (shopRes.error) throw shopRes.error;
  if (fulRes.error) throw fulRes.error;
  if (clinicalRes.error) throw clinicalRes.error;

  return aggregateRevenueBySource({
    shopOrders: (shopRes.data ?? []) as ShopOrderRow[],
    fulfillments: (fulRes.data ?? []) as FulfillmentRow[],
    clinicalFormOrderCount: clinicalRes.count ?? 0,
  });
}

router.get(
  "/admin/analytics/revenue-by-source",
  requirePermission("reports.read"),
  async (req, res) => {
    const parsed = windowSchema.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json({ error: "invalid_query" });
      return;
    }
    const days = parsed.data.days;
    const result = await loadRevenueBySource(isoDaysAgo(days));
    res.json({ windowDays: days, ...result });
  },
);

router.get(
  "/admin/analytics/revenue-by-source.csv",
  requirePermission("reports.read"),
  async (req, res) => {
    const parsed = windowSchema.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json({ error: "invalid_query" });
      return;
    }
    const days = parsed.data.days;
    const result = await loadRevenueBySource(isoDaysAgo(days));

    const filename = `revenue-by-source-${days}d-${new Date()
      .toISOString()
      .slice(0, 10)}.csv`;
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
    res.write("source,label,orders,units,paid_orders,cash_revenue_usd\n");
    for (const b of result.bySource) {
      const usd =
        b.cashRevenueCents == null ? "" : (b.cashRevenueCents / 100).toFixed(2);
      res.write(
        `${b.source},${safeCsvCell(b.label)},${b.orders},${
          b.units ?? ""
        },${b.paidOrders ?? ""},${usd}\n`,
      );
    }
    res.write(
      `total,All sources,${result.totalOrders},,,${(
        result.totalCashRevenueCents / 100
      ).toFixed(2)}\n`,
    );
    res.end();
  },
);

export default router;
