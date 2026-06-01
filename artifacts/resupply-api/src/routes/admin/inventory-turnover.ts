// /admin/analytics/inventory-turnover — inventory turnover & stockout
// cost (Owner #7, Phase 2).
//
//   GET /admin/analytics/inventory-turnover?days=90
//
// Turnover = annualized COGS ÷ inventory value, per SKU. Inventory value
// is on-hand (latest reconciliation count) × latest captured unit cost
// (the F1 snapshot on shop_order_items — avoids the product_id↔sku
// mapping the catalog cost table would need). Honest about gaps: a SKU
// with no reconciliation on file reports turnover null, never a guessed
// number. Stockout cost = open back-in-stock waiters × latest price.
//
// cost.read-gated (COGS/cost data). Aggregates only — product ids +
// dollar/quantity rollups, no PHI.

import { Router, type IRouter } from "express";
import { z } from "zod";

import { getSupabaseServiceRoleClient } from "@workspace/resupply-db";

import { requirePermission } from "../../middlewares/requireAdmin";

const router: IRouter = Router();

export interface InvProductInput {
  productId: string;
  productName: string | null;
  unitsSold: number;
  revenueCents: number;
  cogsKnownCents: number;
  /** Latest reconciliation counted_qty, or null when never reconciled. */
  onHandQty: number | null;
  /** Latest captured unit cost, or null. */
  unitCostCents: number | null;
  /** Latest captured unit price, or null. */
  unitPriceCents: number | null;
  waitingCount: number;
}

export interface InvProductRow extends InvProductInput {
  /** onHand × unit cost, or null when either is missing. */
  inventoryValueCents: number | null;
  /** COGS scaled to a yearly rate from the window. */
  annualizedCogsCents: number;
  /** annualized COGS ÷ inventory value (times/yr), or null. */
  turnover: number | null;
  /** waiters × latest price — demand parked on a restock, or null. */
  stockoutDemandCents: number | null;
}

export interface InventoryTurnoverReport {
  windowDays: number;
  products: InvProductRow[];
  totals: {
    inventoryValueCents: number;
    annualizedCogsCents: number;
    /** blended: total annualized COGS ÷ total inventory value, or null. */
    turnover: number | null;
    stockoutDemandCents: number;
    productsWithoutReconciliation: number;
  };
}

/**
 * Pure: derive per-SKU inventory value, annualized COGS, turnover, and
 * stockout demand, then a blended total. Turnover stays null wherever
 * inventory value is unknown so a missing reconciliation never reads as
 * infinite/zero turns. Sorted by COGS (biggest cost movers first).
 */
export function buildInventoryTurnover(
  inputs: readonly InvProductInput[],
  windowDays: number,
): InventoryTurnoverReport {
  const annualFactor = windowDays > 0 ? 365 / windowDays : 0;

  const products: InvProductRow[] = inputs
    .map((p) => {
      const inventoryValueCents =
        p.onHandQty != null && p.unitCostCents != null
          ? p.onHandQty * p.unitCostCents
          : null;
      const annualizedCogsCents = Math.round(p.cogsKnownCents * annualFactor);
      const turnover =
        inventoryValueCents != null && inventoryValueCents > 0
          ? annualizedCogsCents / inventoryValueCents
          : null;
      const stockoutDemandCents =
        p.unitPriceCents != null ? p.waitingCount * p.unitPriceCents : null;
      return {
        ...p,
        inventoryValueCents,
        annualizedCogsCents,
        turnover,
        stockoutDemandCents,
      };
    })
    .sort((a, b) => b.cogsKnownCents - a.cogsKnownCents);

  const totals = products.reduce(
    (acc, p) => {
      if (p.inventoryValueCents != null)
        acc.inventoryValueCents += p.inventoryValueCents;
      else acc.productsWithoutReconciliation += 1;
      acc.annualizedCogsCents += p.annualizedCogsCents;
      if (p.stockoutDemandCents != null)
        acc.stockoutDemandCents += p.stockoutDemandCents;
      return acc;
    },
    {
      inventoryValueCents: 0,
      annualizedCogsCents: 0,
      stockoutDemandCents: 0,
      productsWithoutReconciliation: 0,
    },
  );
  const blendedTurnover =
    totals.inventoryValueCents > 0
      ? totals.annualizedCogsCents / totals.inventoryValueCents
      : null;

  return {
    windowDays,
    products,
    totals: { ...totals, turnover: blendedTurnover },
  };
}

const querySchema = z
  .object({ days: z.coerce.number().int().min(1).max(366).optional() })
  .strip();

router.get(
  "/admin/analytics/inventory-turnover",
  requirePermission("cost.read"),
  async (req, res) => {
    const parsed = querySchema.safeParse(req.query);
    const days = parsed.success ? (parsed.data.days ?? 90) : 90;
    const cutoffIso = new Date(Date.now() - days * 86_400_000).toISOString();

    const supabase = getSupabaseServiceRoleClient();

    const [itemsRes, reconRes, waitersRes] = await Promise.all([
      supabase
        .schema("resupply")
        .from("shop_order_items")
        .select(
          "product_id, quantity, unit_amount_cents, unit_cost_cents, paid_at",
        )
        .gte("paid_at", cutoffIso)
        .order("paid_at", { ascending: false })
        .limit(5000),
      supabase
        .schema("resupply")
        .from("inventory_reconciliation_lines")
        .select("product_id, product_name, counted_qty, created_at")
        .order("created_at", { ascending: false })
        .limit(2000),
      // Open waiters = back-in-stock signups not yet notified.
      supabase
        .schema("resupply")
        .from("shop_back_in_stock_notifications")
        .select("product_id, notified_at")
        .is("notified_at", null)
        .limit(5000),
    ]);
    if (itemsRes.error) {
      res
        .status(500)
        .json({ error: "query_failed", message: itemsRes.error.message });
      return;
    }
    if (reconRes.error) {
      res
        .status(500)
        .json({ error: "query_failed", message: reconRes.error.message });
      return;
    }
    if (waitersRes.error) {
      res
        .status(500)
        .json({ error: "query_failed", message: waitersRes.error.message });
      return;
    }

    // Latest reconciliation count + name per product (rows are newest-first).
    const onHand = new Map<string, number>();
    const nameByProduct = new Map<string, string>();
    for (const r of (reconRes.data ?? []) as Array<Record<string, unknown>>) {
      const pid = typeof r.product_id === "string" ? r.product_id : "";
      if (pid === "") continue;
      if (!onHand.has(pid) && typeof r.counted_qty === "number")
        onHand.set(pid, r.counted_qty);
      if (!nameByProduct.has(pid) && typeof r.product_name === "string")
        nameByProduct.set(pid, r.product_name);
    }

    // Open waiters per product.
    const waiting = new Map<string, number>();
    for (const w of (waitersRes.data ?? []) as Array<Record<string, unknown>>) {
      const pid = typeof w.product_id === "string" ? w.product_id : "";
      if (pid === "") continue;
      waiting.set(pid, (waiting.get(pid) ?? 0) + 1);
    }

    // Per-product sales rollup; rows are newest-first so the first cost/
    // price we see for a product is the latest snapshot.
    interface Acc {
      unitsSold: number;
      revenueCents: number;
      cogsKnownCents: number;
      unitCostCents: number | null;
      unitPriceCents: number | null;
    }
    const byProduct = new Map<string, Acc>();
    for (const r of (itemsRes.data ?? []) as Array<Record<string, unknown>>) {
      const pid = typeof r.product_id === "string" ? r.product_id : "";
      if (pid === "") continue;
      const qty =
        typeof r.quantity === "number" && r.quantity > 0 ? r.quantity : 1;
      const price =
        typeof r.unit_amount_cents === "number" ? r.unit_amount_cents : null;
      const cost =
        typeof r.unit_cost_cents === "number" ? r.unit_cost_cents : null;
      let a = byProduct.get(pid);
      if (!a) {
        a = {
          unitsSold: 0,
          revenueCents: 0,
          cogsKnownCents: 0,
          unitCostCents: null,
          unitPriceCents: null,
        };
        byProduct.set(pid, a);
      }
      a.unitsSold += qty;
      if (price != null) a.revenueCents += price * qty;
      if (cost != null) a.cogsKnownCents += cost * qty;
      if (a.unitCostCents == null && cost != null) a.unitCostCents = cost;
      if (a.unitPriceCents == null && price != null) a.unitPriceCents = price;
    }

    // Union of products seen in sales, reconciliation, or the waitlist.
    const allIds = new Set<string>([
      ...byProduct.keys(),
      ...onHand.keys(),
      ...waiting.keys(),
    ]);
    const inputs: InvProductInput[] = [...allIds].map((pid) => {
      const a = byProduct.get(pid);
      return {
        productId: pid,
        productName: nameByProduct.get(pid) ?? null,
        unitsSold: a?.unitsSold ?? 0,
        revenueCents: a?.revenueCents ?? 0,
        cogsKnownCents: a?.cogsKnownCents ?? 0,
        onHandQty: onHand.has(pid) ? (onHand.get(pid) ?? null) : null,
        unitCostCents: a?.unitCostCents ?? null,
        unitPriceCents: a?.unitPriceCents ?? null,
        waitingCount: waiting.get(pid) ?? 0,
      };
    });

    const report = buildInventoryTurnover(inputs, days);
    res.json({ ...report, generatedAt: new Date().toISOString() });
  },
);

export default router;
