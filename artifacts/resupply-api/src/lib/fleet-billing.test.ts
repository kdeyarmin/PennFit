import { describe, it, expect } from "vitest";

import {
  addonsMonthlyCents,
  subscriptionMonthlyCents,
  summarizeFleetBilling,
  type FleetBillingTenant,
} from "./fleet-billing";

describe("subscriptionMonthlyCents", () => {
  it("prefers the operator override over the plan list price", () => {
    expect(
      subscriptionMonthlyCents({
        status: "active",
        customMonthlyPriceCents: 12345,
        planCode: "pro",
        planName: "Pro",
        planMonthlyPriceCents: 9900,
      }),
    ).toBe(12345);
  });

  it("falls back to the plan price, then 0", () => {
    expect(
      subscriptionMonthlyCents({
        status: "active",
        customMonthlyPriceCents: null,
        planCode: "pro",
        planName: "Pro",
        planMonthlyPriceCents: 9900,
      }),
    ).toBe(9900);
    expect(
      subscriptionMonthlyCents({
        status: "active",
        customMonthlyPriceCents: null,
        planCode: "free",
        planName: "Free",
        planMonthlyPriceCents: null,
      }),
    ).toBe(0);
  });
});

describe("addonsMonthlyCents", () => {
  it("sums override-or-list price times quantity, ignoring bad quantities", () => {
    expect(
      addonsMonthlyCents([
        {
          quantity: 2,
          customRecurringPriceCents: null,
          addonRecurringPriceCents: 500,
        },
        {
          quantity: 1,
          customRecurringPriceCents: 1000,
          addonRecurringPriceCents: 500,
        },
        {
          quantity: 0,
          customRecurringPriceCents: null,
          addonRecurringPriceCents: 9999,
        },
        {
          quantity: -3,
          customRecurringPriceCents: null,
          addonRecurringPriceCents: 9999,
        },
      ]),
    ).toBe(2 * 500 + 1 * 1000);
  });
});

function tenant(over: Partial<FleetBillingTenant>): FleetBillingTenant {
  return {
    orgId: over.orgId ?? "org",
    subscription: over.subscription ?? null,
    addons: over.addons ?? [],
  };
}

describe("summarizeFleetBilling", () => {
  it("computes MRR, ARPU, plan breakdown, and at-risk revenue", () => {
    const summary = summarizeFleetBilling(
      [
        // Active Pro @ $99 + 2× $5 addon = $109
        tenant({
          orgId: "a",
          subscription: {
            status: "active",
            customMonthlyPriceCents: null,
            planCode: "pro",
            planName: "Pro",
            planMonthlyPriceCents: 9900,
          },
          addons: [
            {
              quantity: 2,
              customRecurringPriceCents: null,
              addonRecurringPriceCents: 500,
            },
          ],
        }),
        // Active Pro custom @ $150
        tenant({
          orgId: "b",
          subscription: {
            status: "active",
            customMonthlyPriceCents: 15000,
            planCode: "pro",
            planName: "Pro",
            planMonthlyPriceCents: 9900,
          },
        }),
        // Trialing Starter @ $49 (counts toward MRR + paying)
        tenant({
          orgId: "c",
          subscription: {
            status: "trialing",
            customMonthlyPriceCents: null,
            planCode: "starter",
            planName: "Starter",
            planMonthlyPriceCents: 4900,
          },
        }),
        // Past-due Pro @ $99 → at-risk, NOT in MRR
        tenant({
          orgId: "d",
          subscription: {
            status: "past_due",
            customMonthlyPriceCents: null,
            planCode: "pro",
            planName: "Pro",
            planMonthlyPriceCents: 9900,
          },
        }),
      ],
      // 6 tenants total → 2 have no subscription row at all.
      6,
    );

    // MRR = 10900 + 15000 + 4900 = 30800
    expect(summary.mrrCents).toBe(30800);
    expect(summary.addonMrrCents).toBe(1000);
    expect(summary.atRiskMrrCents).toBe(9900);
    expect(summary.payingTenants).toBe(3);
    expect(summary.trialingTenants).toBe(1);
    expect(summary.pastDueTenants).toBe(1);
    // 6 total − 4 subscribed (incl. past_due) = 2 unsubscribed.
    expect(summary.unsubscribedTenants).toBe(2);
    // ARPU = round(30800 / 3) = 10267
    expect(summary.arpuCents).toBe(10267);

    // Plan breakdown sorted by MRR desc: Pro ($109+$150=$259) before Starter.
    expect(summary.byPlan).toEqual([
      { planCode: "pro", planName: "Pro", tenants: 2, mrrCents: 25900 },
      { planCode: "starter", planName: "Starter", tenants: 1, mrrCents: 4900 },
    ]);
  });

  it("is all-zero for a fleet with no subscriptions", () => {
    const summary = summarizeFleetBilling([tenant({ orgId: "a" })], 3);
    expect(summary.mrrCents).toBe(0);
    expect(summary.arpuCents).toBe(0);
    expect(summary.payingTenants).toBe(0);
    expect(summary.unsubscribedTenants).toBe(3);
    expect(summary.byPlan).toEqual([]);
  });
});
