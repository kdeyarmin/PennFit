// Pure aggregation for the platform super-admin's fleet revenue (MRR)
// view. The route reads the billing tables and hands the narrowed rows
// here; the recurring-revenue math is a pure, unit-tested function.
//
// MRR (Monthly Recurring Revenue) is the headline SaaS metric: the sum
// of every paying tenant's monthly subscription price + recurring
// add-ons. It is the platform's OWN revenue (what tenants pay to run on
// the platform) — distinct from a tenant's storefront GMV.
//
// Posture: aggregate dollar rollups only. No patient data; tenant
// billing rows are platform metadata.

/** A tenant's active/trialing/past_due subscription, narrowed. */
export interface FleetSubscription {
  status: string;
  /** Operator-set override; falls back to the plan's list price. */
  customMonthlyPriceCents: number | null;
  planCode: string;
  planName: string;
  planMonthlyPriceCents: number | null;
}

/** A tenant's active recurring add-on, narrowed. */
export interface FleetAddon {
  quantity: number;
  customRecurringPriceCents: number | null;
  addonRecurringPriceCents: number | null;
}

export interface FleetBillingTenant {
  orgId: string;
  subscription: FleetSubscription | null;
  addons: FleetAddon[];
}

export interface FleetBillingByPlan {
  planCode: string;
  planName: string;
  tenants: number;
  mrrCents: number;
}

export interface FleetBillingSummary {
  /** Active + trialing recurring revenue. */
  mrrCents: number;
  /** Recurring revenue from add-ons (a subset of mrrCents). */
  addonMrrCents: number;
  /** Recurring revenue that is past_due — booked but at risk. */
  atRiskMrrCents: number;
  /** Average revenue per paying (active/trialing) tenant. */
  arpuCents: number;
  payingTenants: number;
  trialingTenants: number;
  pastDueTenants: number;
  /** Tenants with no active/trialing/past_due subscription at all. */
  unsubscribedTenants: number;
  byPlan: FleetBillingByPlan[];
}

/** Monthly plan price for a subscription: the operator override wins,
 *  else the plan list price, else 0. */
export function subscriptionMonthlyCents(sub: FleetSubscription): number {
  return sub.customMonthlyPriceCents ?? sub.planMonthlyPriceCents ?? 0;
}

/** Recurring revenue contributed by a tenant's add-ons. */
export function addonsMonthlyCents(addons: ReadonlyArray<FleetAddon>): number {
  let cents = 0;
  for (const a of addons) {
    const unit = a.customRecurringPriceCents ?? a.addonRecurringPriceCents ?? 0;
    const qty = a.quantity > 0 ? a.quantity : 0;
    cents += unit * qty;
  }
  return cents;
}

const COUNTS_AS_MRR = new Set(["active", "trialing"]);

/**
 * Fold per-tenant billing into the fleet revenue summary. `totalTenants`
 * is the full tenant count (so "unsubscribed" can include tenants with
 * no billing row at all).
 */
export function summarizeFleetBilling(
  tenants: ReadonlyArray<FleetBillingTenant>,
  totalTenants: number,
): FleetBillingSummary {
  let mrrCents = 0;
  let addonMrrCents = 0;
  let atRiskMrrCents = 0;
  let payingTenants = 0;
  let trialingTenants = 0;
  let pastDueTenants = 0;
  let subscribedTenants = 0;

  const planMap = new Map<string, FleetBillingByPlan>();

  for (const t of tenants) {
    const sub = t.subscription;
    if (!sub) continue;
    subscribedTenants += 1;

    const planCents = subscriptionMonthlyCents(sub);
    const addonCents = addonsMonthlyCents(t.addons);
    const tenantRecurring = planCents + addonCents;

    if (sub.status === "past_due") {
      pastDueTenants += 1;
      atRiskMrrCents += tenantRecurring;
      continue;
    }
    if (!COUNTS_AS_MRR.has(sub.status)) continue;

    if (sub.status === "trialing") trialingTenants += 1;
    payingTenants += 1;
    mrrCents += tenantRecurring;
    addonMrrCents += addonCents;

    const existing = planMap.get(sub.planCode);
    if (existing) {
      existing.tenants += 1;
      existing.mrrCents += tenantRecurring;
    } else {
      planMap.set(sub.planCode, {
        planCode: sub.planCode,
        planName: sub.planName,
        tenants: 1,
        mrrCents: tenantRecurring,
      });
    }
  }

  const byPlan = [...planMap.values()].sort(
    (a, b) => b.mrrCents - a.mrrCents || a.planName.localeCompare(b.planName),
  );

  return {
    mrrCents,
    addonMrrCents,
    atRiskMrrCents,
    arpuCents: payingTenants > 0 ? Math.round(mrrCents / payingTenants) : 0,
    payingTenants,
    trialingTenants,
    pastDueTenants,
    unsubscribedTenants: Math.max(0, totalTenants - subscribedTenants),
    byPlan,
  };
}
