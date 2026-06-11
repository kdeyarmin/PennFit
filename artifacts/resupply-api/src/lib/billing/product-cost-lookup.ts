// Batch unit-cost (COGS) lookup — the cost-capture foundation's read
// side (migration 0193 / docs/feature-roadmap-2026-05-31.md F1).
//
// One place the order + claim write paths resolve "what does this SKU
// cost us right now?" from resupply.product_costs, so the per-transaction
// snapshot columns (shop_order_items / insurance_claim_line_items) can be
// stamped at row-creation time.
//
// Fail-soft by contract: cost capture DECORATES a sale/dispense write —
// it must never block or fail it. Any query error (or throw) returns an
// empty Map, so every SKU reads back "unknown" and the snapshot stays
// null — surfaced honestly downstream by computeMargin rather than as a
// 100%-margin lie.

import { getSupabaseServiceRoleClient } from "@workspace/resupply-db";

export interface UnitCostSnapshot {
  unitCostCents: number;
  costSource: string;
}

/**
 * Resolve current unit cost for a set of shop SKUs. De-dupes and drops
 * empty/nullish inputs, issues a single `.in("sku", …)` query, and
 * returns a Map keyed by SKU. SKUs with no recorded cost are simply
 * ABSENT from the Map (the caller leaves the snapshot null). Never
 * throws.
 */
export async function fetchUnitCostsBySku(
  skus: readonly (string | null | undefined)[],
  log?: { warn?: (...args: unknown[]) => void },
): Promise<Map<string, UnitCostSnapshot>> {
  const out = new Map<string, UnitCostSnapshot>();
  const distinct = [
    ...new Set(
      skus.filter((s): s is string => typeof s === "string" && s.length > 0),
    ),
  ];
  if (distinct.length === 0) return out;

  try {
    const supabase = getSupabaseServiceRoleClient();
    const { data, error } = await supabase
      .schema("resupply")
      .from("product_costs")
      .select("sku, unit_cost_cents, cost_source")
      .in("sku", distinct);
    if (error) {
      log?.warn?.(
        { err: error.message, skuCount: distinct.length },
        "product_costs lookup failed (non-fatal) — costs left unknown",
      );
      return out;
    }
    for (const row of data ?? []) {
      if (
        typeof row.sku === "string" &&
        typeof row.unit_cost_cents === "number"
      ) {
        out.set(row.sku, {
          unitCostCents: row.unit_cost_cents,
          costSource:
            typeof row.cost_source === "string" ? row.cost_source : "manual",
        });
      }
    }
  } catch (err) {
    log?.warn?.(
      { err },
      "product_costs lookup threw (non-fatal) — costs left unknown",
    );
  }
  return out;
}

export interface CostSnapshotTarget {
  unit_cost_cents?: number | null;
  cost_source?: string | null;
  cost_captured_at?: string | null;
}

/**
 * Stamp the resolved COGS snapshot onto write rows IN PLACE, aligned by
 * index with `skus` (rows[i] ↔ skus[i]). Only rows whose SKU has a known
 * cost are touched; the rest keep their null "unknown" cost. Pure +
 * synchronous so the index alignment — the one place a stamping bug
 * could hide — is unit-testable without Stripe or the DB.
 */
export function stampUnitCostSnapshots(
  rows: readonly CostSnapshotTarget[],
  skus: readonly (string | null | undefined)[],
  costBySku: ReadonlyMap<string, UnitCostSnapshot>,
  capturedAtIso: string,
): void {
  if (costBySku.size === 0) return;
  rows.forEach((row, i) => {
    const sku = skus[i];
    const cost = sku ? costBySku.get(sku) : undefined;
    if (cost) {
      row.unit_cost_cents = cost.unitCostCents;
      row.cost_source = cost.costSource;
      row.cost_captured_at = capturedAtIso;
    }
  });
}
