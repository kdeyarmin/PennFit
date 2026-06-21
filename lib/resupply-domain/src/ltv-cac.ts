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
//
// Gross vs margin-adjusted LTV: the base avgLtvCents / totalRevenueCents and
// the LTV:CAC ratio are GROSS — lifetime *revenue*, not contribution. That
// overstates LTV:CAC whenever COGS is non-trivial. Callers who know their
// gross-margin can supply an OPTIONAL `grossMarginRatio` (0..1) per row to
// also get a margin-adjusted LTV (`avgGrossMarginLtvCents`) and a CAC payback
// (`cacPaybackMonths`). These extra fields stay null whenever the inputs
// needed to derive them honestly are absent (no margin supplied anywhere in
// the channel, or CAC/lifespan undefined) — same "never fabricate" posture.

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
  /**
   * OPTIONAL gross-margin ratio for this customer's revenue, 0..1 (e.g.
   * 0.40 = 40% contribution after COGS). When supplied, the channel's
   * margin-adjusted LTV and CAC payback can be derived; when absent
   * everywhere in a channel, those margin fields stay null. Clamped to
   * [0, 1] defensively — a stray 1.5 or -0.2 can't manufacture margin.
   */
  grossMarginRatio?: number | null;
  /**
   * OPTIONAL observed/expected customer lifespan in months (> 0). Needed
   * to turn a lifetime margin into a *monthly* margin contribution for the
   * CAC payback metric. Absent → cacPaybackMonths is null (we don't guess
   * a lifespan).
   */
  lifespanMonths?: number | null;
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
  /**
   * Average margin-adjusted LTV in cents: avgLtv × the revenue-weighted
   * gross-margin ratio of the customers that supplied one. null when NO
   * customer in this channel supplied a grossMarginRatio (we don't assume
   * 100% margin). The base avgLtvCents stays gross regardless.
   */
  avgGrossMarginLtvCents: number | null;
  /**
   * Months of (monthly) gross-margin contribution to recoup avg CAC:
   * avgCac ÷ (avgGrossMarginLtv ÷ avgLifespanMonths). null unless avg CAC,
   * a margin-adjusted LTV, AND a positive average lifespan are all known.
   */
  cacPaybackMonths: number | null;
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
    avgGrossMarginLtvCents: number | null;
    cacPaybackMonths: number | null;
  };
}

function summarize(
  channel: AcquisitionChannel,
  rows: readonly CustomerEconomicsInput[],
): ChannelEconomics {
  let totalRevenueCents = 0;
  let customersWithCost = 0;
  let knownAcquisitionCostCents = 0;
  // Margin accumulators over the subset that supplied a grossMarginRatio:
  // sum the per-customer margin *contribution* (revenue × clamped ratio) and
  // the revenue it came from, so the channel margin is revenue-weighted.
  let marginRevenueCents = 0;
  let marginContributionCents = 0;
  let customersWithMargin = 0;
  // Lifespan over the subset that supplied a positive lifespanMonths.
  let lifespanMonthsSum = 0;
  let customersWithLifespan = 0;
  for (const r of rows) {
    const revenue = Math.max(0, Math.trunc(r.lifetimeRevenueCents));
    totalRevenueCents += revenue;
    if (r.acquisitionCostCents != null) {
      customersWithCost += 1;
      knownAcquisitionCostCents += Math.max(
        0,
        Math.trunc(r.acquisitionCostCents),
      );
    }
    if (r.grossMarginRatio != null) {
      // Defensive clamp: a stray 1.5 or -0.2 can't manufacture/erase margin.
      const ratio = Math.min(1, Math.max(0, r.grossMarginRatio));
      customersWithMargin += 1;
      marginRevenueCents += revenue;
      marginContributionCents += revenue * ratio;
    }
    if (r.lifespanMonths != null && r.lifespanMonths > 0) {
      customersWithLifespan += 1;
      lifespanMonthsSum += r.lifespanMonths;
    }
  }
  const customerCount = rows.length;
  const avgLtvCents =
    customerCount > 0 ? Math.round(totalRevenueCents / customerCount) : 0;
  const avgCacCents =
    customersWithCost > 0
      ? Math.round(knownAcquisitionCostCents / customersWithCost)
      : null;
  // Ratio from the unrounded sums (avoids the ratio-of-rounded-integers nit):
  // (totalRevenue / count) / (knownCost / costedCount). Equivalent to
  // avgLtv/avgCac but without the double-rounding error.
  const ltvToCacRatio =
    customersWithCost > 0 && knownAcquisitionCostCents > 0
      ? totalRevenueCents /
        customerCount /
        (knownAcquisitionCostCents / customersWithCost)
      : null;

  // Margin-adjusted LTV: apply the revenue-weighted margin of the
  // margin-supplying subset to the channel's gross avg LTV. null when no
  // customer supplied a margin ratio (don't assume 100% margin).
  const marginRatio =
    customersWithMargin > 0 && marginRevenueCents > 0
      ? marginContributionCents / marginRevenueCents
      : null;
  const avgGrossMarginLtvCents =
    marginRatio != null ? Math.round(avgLtvCents * marginRatio) : null;

  // CAC payback: months of monthly margin contribution to recoup avg CAC.
  // Needs avg CAC (> 0), a margin-adjusted LTV, and a positive avg lifespan.
  const avgLifespanMonths =
    customersWithLifespan > 0
      ? lifespanMonthsSum / customersWithLifespan
      : null;
  const cacPaybackMonths =
    avgCacCents != null &&
    avgCacCents > 0 &&
    avgGrossMarginLtvCents != null &&
    avgGrossMarginLtvCents > 0 &&
    avgLifespanMonths != null
      ? avgCacCents / (avgGrossMarginLtvCents / avgLifespanMonths)
      : null;

  return {
    channel,
    customerCount,
    totalRevenueCents,
    avgLtvCents,
    customersWithCost,
    knownAcquisitionCostCents,
    avgCacCents,
    ltvToCacRatio,
    avgGrossMarginLtvCents,
    cacPaybackMonths,
  };
}

/**
 * Pure: group customers by channel (null channel → "unattributed"),
 * summarize each, sort by total revenue desc, and roll up a blended
 * total. CAC is averaged over costed customers only; LTV:CAC is null
 * when CAC is unknown/zero. The base LTV is GROSS revenue; a
 * margin-adjusted LTV and CAC payback are also reported per channel when
 * callers supply grossMarginRatio / lifespanMonths (null otherwise).
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
      avgGrossMarginLtvCents: totalsSummary.avgGrossMarginLtvCents,
      cacPaybackMonths: totalsSummary.cacPaybackMonths,
    },
  };
}
