// /admin/analytics/margin — gross-margin / COGS dashboard (Owner #1,
// Phase 2). "The most important missing number": what did we actually
// make after cost, by product and overall.
//
//   GET /admin/analytics/margin?days=30
//
// Reads the F1 point-in-time cost snapshots stamped onto
// shop_order_items (unit_cost_cents) and folds them through the shared,
// tested margin core in @workspace/resupply-domain. Cost is OPTIONAL:
// lines whose SKU had no recorded cost are reported as an explicit
// "uncosted revenue" blind spot rather than counted as 100% margin.
//
// cost.read-gated (the finance permission). Aggregates only — product
// ids + dollar rollups, never per-order PHI.

import { Router, type IRouter } from "express";
import { z } from "zod";

import { getSupabaseServiceRoleClient } from "@workspace/resupply-db";
import {
  aggregateMargin,
  type MarginAggregate,
  type MarginInput,
} from "@workspace/resupply-domain";

import { adminRateLimit } from "../../middlewares/admin-rate-limit";
import { requirePermission } from "../../middlewares/requireAdmin";

const router: IRouter = Router();

export interface MarginLine extends MarginInput {
  productId: string;
}

export interface ProductMargin extends MarginAggregate {
  productId: string;
}

export interface MarginBreakdown {
  overall: MarginAggregate;
  byProduct: ProductMargin[];
}

/**
 * Pure: fold lines into an overall margin rollup plus a per-product
 * breakdown sorted by revenue (biggest contributors first). The
 * known/unknown-cost split is preserved at both levels via
 * aggregateMargin, so an uncosted product can't masquerade as margin.
 */
export function buildMarginBreakdown(
  lines: readonly MarginLine[],
): MarginBreakdown {
  const overall = aggregateMargin(lines);

  const groups = new Map<string, MarginLine[]>();
  for (const line of lines) {
    const list = groups.get(line.productId);
    if (list) list.push(line);
    else groups.set(line.productId, [line]);
  }

  const byProduct: ProductMargin[] = [...groups.entries()]
    .map(([productId, groupLines]) => ({
      productId,
      ...aggregateMargin(groupLines),
    }))
    .sort((a, b) => b.revenueCents - a.revenueCents);

  return { overall, byProduct };
}

const querySchema = z
  .object({
    days: z.coerce.number().int().min(1).max(366).optional(),
  })
  .strip();

router.get(
  "/admin/analytics/margin",
  // Rate-limit before the auth gate (CodeQL "missing rate limiting").
  adminRateLimit({ name: "analytics_margin.get", preset: "query" }),
  requirePermission("cost.read"),
  async (req, res) => {
    const parsed = querySchema.safeParse(req.query);
    const days = parsed.success ? (parsed.data.days ?? 30) : 30;
    const cutoffIso = new Date(Date.now() - days * 86_400_000).toISOString();

    const supabase = getSupabaseServiceRoleClient();
    const { data: items, error } = await supabase
      .schema("resupply")
      .from("shop_order_items")
      .select("product_id, quantity, unit_amount_cents, unit_cost_cents")
      .gte("paid_at", cutoffIso)
      .limit(5000);
    if (error) {
      res.status(500).json({ error: "query_failed", message: error.message });
      return;
    }
    const rows = (items ?? []) as Array<Record<string, unknown>>;

    const lines: MarginLine[] = rows.map((r) => {
      const quantity =
        typeof r.quantity === "number" && r.quantity > 0 ? r.quantity : 1;
      const unitAmount =
        typeof r.unit_amount_cents === "number" ? r.unit_amount_cents : 0;
      return {
        productId: typeof r.product_id === "string" ? r.product_id : "unknown",
        revenueCents: unitAmount * quantity,
        unitCostCents:
          typeof r.unit_cost_cents === "number" ? r.unit_cost_cents : null,
        quantity,
      };
    });

    const breakdown = buildMarginBreakdown(lines);

    // Best-effort product-name enrichment: the most recent inventory
    // reconciliation carries product_id → product_name. Missing names
    // fall back to the product id (the owner can map it in Stripe).
    const productIds = breakdown.byProduct.map((p) => p.productId);
    const nameByProduct = new Map<string, string>();
    if (productIds.length > 0) {
      const { data: names } = await supabase
        .schema("resupply")
        .from("inventory_reconciliation_lines")
        .select("product_id, product_name, created_at")
        .in("product_id", productIds)
        .order("created_at", { ascending: false })
        .limit(2000);
      for (const n of (names ?? []) as Array<Record<string, unknown>>) {
        const pid = typeof n.product_id === "string" ? n.product_id : "";
        const nm = typeof n.product_name === "string" ? n.product_name : "";
        if (pid && nm && !nameByProduct.has(pid)) nameByProduct.set(pid, nm);
      }
    }

    res.json({
      windowDays: days,
      overall: breakdown.overall,
      byProduct: breakdown.byProduct.map((p) => ({
        ...p,
        productName: nameByProduct.get(p.productId) ?? null,
      })),
      generatedAt: new Date().toISOString(),
    });
  },
);

export default router;
