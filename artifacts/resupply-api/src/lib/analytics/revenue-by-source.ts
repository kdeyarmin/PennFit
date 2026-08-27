// Pure aggregation for the "revenue & orders by source" analytics
// surface. Mirrors the read-then-aggregate shape of the other
// analytics aggregators (lib/analytics/aggregate.ts): the route does the
// window-bounded DB reads, this module reduces them — so the math is
// unit-testable without Postgres.
//
// CareMetric Breathe captures orders through three independent channels:
//   * storefront          — historical cash-pay Stripe rows (shop_orders).
//                           Still the only channel with shop cash $ on file
//                           (amount_total_cents). New patient cash checkout
//                           is retired; these rows are legacy.
//   * resupply_fulfillment — insurance/clinical resupply shipped through
//                           the episode pipeline (fulfillments) + ERA
//                           remittance dollars from insurance_claims
//                           (total_paid_cents when paid_at is in window).
//                           Payer-paid $ is labeled separately from shop
//                           cash and is NOT folded into LTV:CAC.
//   * clinical_form       — direct intake-form orders (public.orders),
//                           handed to the supplier. Count only.
//
// "Cash revenue" (totalCashRevenueCents) remains storefront-only.
// "Payer paid" (totalPayerPaidCents) is ERA remittance dollars.

export interface ShopOrderRow {
  status: string | null;
  amount_total_cents: number | null;
}

export interface FulfillmentRow {
  status: string | null;
  quantity: number | null;
}

/** Windowed insurance_claims rows used only for ERA payer-paid cents. */
export interface ClaimPaidRow {
  total_paid_cents: number | null;
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
  /**
   * ERA payer-paid cents for the insurance channel (sum of
   * insurance_claims.total_paid_cents in window). null on other sources.
   * Not LTV — remittance dollars, no patient↔customer acquisition join.
   */
  payerPaidCents: number | null;
}

export interface RevenueBySourceInput {
  shopOrders: readonly ShopOrderRow[];
  fulfillments: readonly FulfillmentRow[];
  /** Count of public.orders rows in the window (no row data pulled — the
   *  table carries PHI, so the route counts it head-only). */
  clinicalFormOrderCount: number;
  /** insurance_claims with paid_at in the window (amount only). */
  claimPayments?: readonly ClaimPaidRow[];
}

export interface RevenueBySourceResult {
  bySource: RevenueSourceBucket[];
  totalOrders: number;
  /** Storefront gross paid cents — historical shop cash only. */
  totalCashRevenueCents: number;
  /** ERA remittance dollars — not folded into LTV:CAC. */
  totalPayerPaidCents: number;
}

export function aggregateRevenueBySource(
  input: RevenueBySourceInput,
): RevenueBySourceResult {
  const {
    shopOrders,
    fulfillments,
    clinicalFormOrderCount,
    claimPayments = [],
  } = input;

  // ── storefront (historical cash-pay) ───────────────────────────
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
    label: "Storefront (historical)",
    orders: shopOrders.length,
    units: null,
    paidOrders,
    cashRevenueCents,
    payerPaidCents: null,
  };

  // ── resupply fulfillment (insurance) + ERA paid ────────────────
  let units = 0;
  for (const f of fulfillments) {
    // quantity is an integer column; treat a missing value as a single
    // unit so a NULL never silently drops a shipment from the count.
    units += f.quantity ?? 1;
  }
  let payerPaidCents = 0;
  for (const c of claimPayments) {
    payerPaidCents += Math.max(0, c.total_paid_cents ?? 0);
  }
  const resupply: RevenueSourceBucket = {
    source: "resupply_fulfillment",
    label: "Resupply (insurance)",
    orders: fulfillments.length,
    units,
    paidOrders: null,
    cashRevenueCents: null,
    payerPaidCents,
  };

  // ── clinical intake form ───────────────────────────────────────
  const clinical: RevenueSourceBucket = {
    source: "clinical_form",
    label: "Clinical intake form",
    orders: Math.max(0, clinicalFormOrderCount),
    units: null,
    paidOrders: null,
    cashRevenueCents: null,
    payerPaidCents: null,
  };

  const bySource = [storefront, resupply, clinical];
  return {
    bySource,
    totalOrders: bySource.reduce((s, b) => s + b.orders, 0),
    totalCashRevenueCents: cashRevenueCents,
    totalPayerPaidCents: payerPaidCents,
  };
}
