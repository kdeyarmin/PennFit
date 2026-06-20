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

  it("returns null margin fields when no grossMarginRatio is supplied", () => {
    const { byChannel } = buildLtvCacReport([
      {
        customerId: "a",
        channel: "paid_search",
        lifetimeRevenueCents: 30000,
        acquisitionCostCents: 5000,
      },
    ]);
    const paid = byChannel[0]!;
    // Base LTV stays gross; margin-adjusted fields are honestly null.
    expect(paid.avgLtvCents).toBe(30000);
    expect(paid.avgGrossMarginLtvCents).toBeNull();
    expect(paid.cacPaybackMonths).toBeNull();
  });

  it("computes margin-adjusted LTV and CAC payback when margin + lifespan supplied", () => {
    const customers: CustomerEconomicsInput[] = [
      {
        customerId: "a",
        channel: "paid_search",
        lifetimeRevenueCents: 30000,
        acquisitionCostCents: 6000,
        grossMarginRatio: 0.5,
        lifespanMonths: 10,
      },
      {
        customerId: "b",
        channel: "paid_search",
        lifetimeRevenueCents: 10000,
        acquisitionCostCents: 6000,
        grossMarginRatio: 0.5,
        lifespanMonths: 10,
      },
    ];
    const { byChannel } = buildLtvCacReport(customers);
    const paid = byChannel[0]!;
    expect(paid.avgLtvCents).toBe(20000); // gross (30000+10000)/2
    // revenue-weighted margin = (30000+10000)*0.5 / (30000+10000) = 0.5
    expect(paid.avgGrossMarginLtvCents).toBe(10000); // 20000 * 0.5
    // avgCac 6000, monthly margin = 10000/10 = 1000 → payback 6 months.
    expect(paid.cacPaybackMonths).toBeCloseTo(6, 5);
  });

  it("clamps an out-of-range margin ratio into [0,1]", () => {
    const { byChannel } = buildLtvCacReport([
      {
        customerId: "a",
        channel: "organic",
        lifetimeRevenueCents: 10000,
        acquisitionCostCents: null,
        grossMarginRatio: 1.5, // clamped to 1.0
      },
    ]);
    expect(byChannel[0]!.avgGrossMarginLtvCents).toBe(10000);
  });

  it("leaves cacPaybackMonths null when lifespan is missing", () => {
    const { byChannel } = buildLtvCacReport([
      {
        customerId: "a",
        channel: "paid_search",
        lifetimeRevenueCents: 30000,
        acquisitionCostCents: 6000,
        grossMarginRatio: 0.5,
        // no lifespanMonths → payback not derivable
      },
    ]);
    const paid = byChannel[0]!;
    expect(paid.avgGrossMarginLtvCents).toBe(15000); // margin LTV still derivable
    expect(paid.cacPaybackMonths).toBeNull();
  });

  it("is empty-safe", () => {
    const { byChannel, totals } = buildLtvCacReport([]);
    expect(byChannel).toEqual([]);
    expect(totals.customerCount).toBe(0);
    expect(totals.avgLtvCents).toBe(0);
    expect(totals.avgCacCents).toBeNull();
    expect(totals.avgGrossMarginLtvCents).toBeNull();
    expect(totals.cacPaybackMonths).toBeNull();
  });
});
