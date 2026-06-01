import { describe, it, expect } from "vitest";

import { buildLtvCacReport, type CustomerEconomicsInput } from "./ltv-cac";

describe("buildLtvCacReport", () => {
  it("groups by channel, averages LTV, and computes CAC over the costed subset", () => {
    const customers: CustomerEconomicsInput[] = [
      // paid_search: 2 customers, both costed
      {
        customerId: "a",
        channel: "paid_search",
        lifetimeRevenueCents: 30000,
        acquisitionCostCents: 5000,
      },
      {
        customerId: "b",
        channel: "paid_search",
        lifetimeRevenueCents: 10000,
        acquisitionCostCents: 5000,
      },
      // organic: 1 customer, no cost (free)
      {
        customerId: "c",
        channel: "organic",
        lifetimeRevenueCents: 20000,
        acquisitionCostCents: null,
      },
    ];
    const { byChannel, totals } = buildLtvCacReport(customers);

    // Sorted by total revenue desc: paid_search (40000) before organic (20000)
    expect(byChannel.map((c) => c.channel)).toEqual(["paid_search", "organic"]);

    const paid = byChannel.find((c) => c.channel === "paid_search")!;
    expect(paid.customerCount).toBe(2);
    expect(paid.avgLtvCents).toBe(20000); // (30000+10000)/2
    expect(paid.customersWithCost).toBe(2);
    expect(paid.avgCacCents).toBe(5000);
    expect(paid.ltvToCacRatio).toBeCloseTo(4.0, 5); // 20000/5000

    const organic = byChannel.find((c) => c.channel === "organic")!;
    expect(organic.avgLtvCents).toBe(20000);
    expect(organic.customersWithCost).toBe(0);
    expect(organic.avgCacCents).toBeNull(); // no costed customers
    expect(organic.ltvToCacRatio).toBeNull(); // CAC unknown → null

    expect(totals.customerCount).toBe(3);
    expect(totals.totalRevenueCents).toBe(60000);
    // CAC averaged over the 2 costed customers only, not all 3.
    expect(totals.customersWithCost).toBe(2);
    expect(totals.avgCacCents).toBe(5000);
  });

  it("maps a null channel to the 'unattributed' bucket", () => {
    const { byChannel } = buildLtvCacReport([
      {
        customerId: "x",
        channel: null,
        lifetimeRevenueCents: 1000,
        acquisitionCostCents: null,
      },
    ]);
    expect(byChannel[0]!.channel).toBe("unattributed");
    expect(byChannel[0]!.avgCacCents).toBeNull();
  });

  it("treats a zero avg CAC as an undefined ratio (null, not Infinity)", () => {
    const { byChannel } = buildLtvCacReport([
      {
        customerId: "z",
        channel: "referral",
        lifetimeRevenueCents: 5000,
        acquisitionCostCents: 0, // known, but free
      },
    ]);
    const ref = byChannel[0]!;
    expect(ref.avgCacCents).toBe(0);
    expect(ref.ltvToCacRatio).toBeNull();
  });

  it("is empty-safe", () => {
    const { byChannel, totals } = buildLtvCacReport([]);
    expect(byChannel).toEqual([]);
    expect(totals.customerCount).toBe(0);
    expect(totals.avgLtvCents).toBe(0);
    expect(totals.avgCacCents).toBeNull();
  });
});
