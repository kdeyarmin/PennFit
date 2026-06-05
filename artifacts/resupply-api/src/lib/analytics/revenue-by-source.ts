// Pure aggregation for the "revenue & orders by source" analytics
// surface. Mirrors the read-then-aggregate shape of the other
// analytics aggregators (lib/analytics/aggregate.ts): the route does the
// window-bounded DB reads, this module reduces them — so the math is
// unit-testable without Postgres.
//
// PennFit captures orders through three independent channels and, until
// now, had no single view of where order volume and cash revenue come
// from:
//   * storefront          — cash-pay Stripe orders (resupply.shop_orders).
//                           The ONLY channel with a dollar amount on file
//                           (amount_total_cents).
//   * resupply_fulfillment — insurance/clinical resupply shipped through
//                           the episode pipeline (resupply.fulfillments).
//                           Billed to payers, so no cash amount here —
//                           counted by orders + units.
//   * clinical_form       — direct intake-form orders (public.orders),
//                           handed to the supplier. Count only.
//
// "Cash revenue" therefore reflects storefront only; the other channels
// are reported as order/unit VOLUME. Revenue is gross paid (refunds live
// in shop_returns and are out of scope for v1).

export interface ShopOrderRow {
  status: string | null;
  amount_total_cents: number | null;
}

export interface FulfillmentRow {
  status: string | null;
  quantity: number | null;
}

export type RevenueSource =
  | "storefront"
  | "resupply_fulfillment"
  | "clinical_form";

export interface RevenueSourceBucket {
  source: RevenueSource;
  label: string;
  /** Total orders/fulfillments created in the window for this source. */
  orders: number;
  /** Units shipped (fulfillments). null when not meaningful. */
  units: number | null;
  /** Orders that reached a paid state (storefront). null otherwise. */
  paidOrders: number | null;
  /** Gross cash revenue in cents (storefront paid). null otherwise. */
  cashRevenueCents: number | null;
}

export interface RevenueBySourceInput {
  shopOrders: readonly ShopOrderRow[];
  fulfillments: readonly FulfillmentRow[];
  /** Count of public.orders rows in the window (no row data pulled — the
   *  table carries PHI, so the route counts it head-only). */
  clinicalFormOrderCount: number;
}

export interface RevenueBySourceResult {
  bySource: RevenueSourceBucket[];
  totalOrders: number;
  /** Storefront gross paid cents — the only cash-bearing channel. */
  totalCashRevenueCents: number;
}

export function aggregateRevenueBySource(
  input: RevenueBySourceInput,
): RevenueBySourceResult {
  const { shopOrders, fulfillments, clinicalFormOrderCount } = input;

  // ── storefront (cash-pay) ──────────────────────────────────────
  let paidOrders = 0;
  let cashRevenueCents = 0;
  for (const o of shopOrders) {
    if (o.status === "paid") {
      paidOrders += 1;
      cashRevenueCents += o.amount_total_cents ?? 0;
    }
  }
  const storefront: RevenueSourceBucket = {
    source: "storefront",
    label: "Storefront (cash-pay)",
    orders: shopOrders.length,
    units: null,
    paidOrders,
    cashRevenueCents,
  };

  // ── resupply fulfillment (insurance) ───────────────────────────
  let units = 0;
  for (const f of fulfillments) {
    // quantity is an integer column; treat a missing value as a single
    // unit so a NULL never silently drops a shipment from the count.
    units += f.quantity ?? 1;
  }
  const resupply: RevenueSourceBucket = {
    source: "resupply_fulfillment",
    label: "Resupply (insurance)",
    orders: fulfillments.length,
    units,
    paidOrders: null,
    cashRevenueCents: null,
  };

  // ── clinical intake form ───────────────────────────────────────
  const clinical: RevenueSourceBucket = {
    source: "clinical_form",
    label: "Clinical intake form",
    orders: Math.max(0, clinicalFormOrderCount),
    units: null,
    paidOrders: null,
    cashRevenueCents: null,
  };

  const bySource = [storefront, resupply, clinical];
  return {
    bySource,
    totalOrders: bySource.reduce((s, b) => s + b.orders, 0),
    totalCashRevenueCents: cashRevenueCents,
  };
}
