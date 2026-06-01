// LTV & CAC cohort economics — pure value-object logic (ADR 008: no I/O).
//
// Turns per-customer (acquisition channel, optional acquisition cost,
// lifetime revenue) tuples into a by-channel rollup: customer count,
// average lifetime value, average customer-acquisition cost (over the
// costed subset only), and the LTV:CAC ratio (Owner #3). The data layer
// joins customer_acquisition (migration 0196) to shop_orders and hands
// the flattened rows here.
//
// Honesty rules, mirroring the F1 cost layer:
//   * acquisitionCostCents is OPTIONAL. CAC is averaged over customers
//     whose cost is KNOWN — an unknown-cost customer never counts as $0
//     CAC (which would understate CAC / inflate the ratio). The costed
//     vs total customer split is reported so a channel with thin cost
//     data is visible, not hidden.
//   * LTV:CAC is null when CAC is unknown or zero (undefined ratio),
//     never a fabricated number.

export type AcquisitionChannel =
  | "organic"
  | "paid_search"
  | "paid_social"
  | "referral"
  | "fitter"
  | "insurance_lead"
  | "partner"
  | "other"
  | "unattributed";

export interface CustomerEconomicsInput {
  customerId: string;
  /** null when the customer has no customer_acquisition row → "unattributed". */
  channel: AcquisitionChannel | null;
  /** Lifetime revenue (sum of paid orders), integer cents, >= 0. */
  lifetimeRevenueCents: number;
  /** Acquisition cost for this customer, or null when unknown. */
  acquisitionCostCents?: number | null;
}

export interface ChannelEconomics {
  channel: AcquisitionChannel;
  customerCount: number;
  totalRevenueCents: number;
  /** totalRevenue / customerCount — average lifetime value. */
  avgLtvCents: number;
  /** Customers in this channel whose acquisition cost is known. */
  customersWithCost: number;
  /** Sum of known acquisition costs. */
  knownAcquisitionCostCents: number;
  /** avg CAC over the costed subset, or null when none costed. */
  avgCacCents: number | null;
  /** avgLtv / avgCac, or null when CAC is unknown / zero. */
  ltvToCacRatio: number | null;
}

export interface LtvCacReport {
  byChannel: ChannelEconomics[];
  totals: {
    customerCount: number;
    totalRevenueCents: number;
    avgLtvCents: number;
    customersWithCost: number;
    knownAcquisitionCostCents: number;
    avgCacCents: number | null;
    ltvToCacRatio: number | null;
  };
}

function summarize(
  channel: AcquisitionChannel,
  rows: readonly CustomerEconomicsInput[],
): ChannelEconomics {
  let totalRevenueCents = 0;
  let customersWithCost = 0;
  let knownAcquisitionCostCents = 0;
  for (const r of rows) {
    totalRevenueCents += Math.max(0, Math.trunc(r.lifetimeRevenueCents));
    if (r.acquisitionCostCents != null) {
      customersWithCost += 1;
      knownAcquisitionCostCents += Math.max(
        0,
        Math.trunc(r.acquisitionCostCents),
      );
    }
  }
  const customerCount = rows.length;
  const avgLtvCents =
    customerCount > 0 ? Math.round(totalRevenueCents / customerCount) : 0;
  const avgCacCents =
    customersWithCost > 0
      ? Math.round(knownAcquisitionCostCents / customersWithCost)
      : null;
  const ltvToCacRatio =
    avgCacCents != null && avgCacCents > 0 ? avgLtvCents / avgCacCents : null;
  return {
    channel,
    customerCount,
    totalRevenueCents,
    avgLtvCents,
    customersWithCost,
    knownAcquisitionCostCents,
    avgCacCents,
    ltvToCacRatio,
  };
}

/**
 * Pure: group customers by channel (null channel → "unattributed"),
 * summarize each, sort by total revenue desc, and roll up a blended
 * total. CAC is averaged over costed customers only; LTV:CAC is null
 * when CAC is unknown/zero.
 */
export function buildLtvCacReport(
  customers: readonly CustomerEconomicsInput[],
): LtvCacReport {
  const groups = new Map<AcquisitionChannel, CustomerEconomicsInput[]>();
  for (const c of customers) {
    const ch: AcquisitionChannel = c.channel ?? "unattributed";
    const list = groups.get(ch);
    if (list) list.push(c);
    else groups.set(ch, [c]);
  }

  const byChannel = [...groups.entries()]
    .map(([channel, rows]) => summarize(channel, rows))
    .sort((a, b) => b.totalRevenueCents - a.totalRevenueCents);

  // Blended total computed from the same inputs (treat as one group),
  // so the totals' avgCac/LTV:CAC follow the identical costed-subset rule.
  const totalsSummary = summarize("other", customers);

  return {
    byChannel,
    totals: {
      customerCount: totalsSummary.customerCount,
      totalRevenueCents: totalsSummary.totalRevenueCents,
      avgLtvCents: totalsSummary.avgLtvCents,
      customersWithCost: totalsSummary.customersWithCost,
      knownAcquisitionCostCents: totalsSummary.knownAcquisitionCostCents,
      avgCacCents: totalsSummary.avgCacCents,
      ltvToCacRatio: totalsSummary.ltvToCacRatio,
    },
  };
}
