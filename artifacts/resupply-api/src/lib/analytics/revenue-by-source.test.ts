import { describe, expect, it } from "vitest";

import {
  aggregateRevenueBySource,
  type RevenueSourceBucket,
} from "./revenue-by-source";

function bucket(
  result: ReturnType<typeof aggregateRevenueBySource>,
  source: RevenueSourceBucket["source"],
): RevenueSourceBucket {
  const b = result.bySource.find((x) => x.source === source);
  if (!b) throw new Error(`missing bucket ${source}`);
  return b;
}

describe("aggregateRevenueBySource", () => {
  it("returns zeroed buckets for empty input", () => {
    const r = aggregateRevenueBySource({
      shopOrders: [],
      fulfillments: [],
      clinicalFormOrderCount: 0,
    });
    expect(r.totalOrders).toBe(0);
    expect(r.totalCashRevenueCents).toBe(0);
    expect(r.bySource).toHaveLength(3);
    expect(bucket(r, "storefront").cashRevenueCents).toBe(0);
  });

  it("counts only paid storefront orders toward cash revenue", () => {
    const r = aggregateRevenueBySource({
      shopOrders: [
        { status: "paid", amount_total_cents: 7900 },
        { status: "paid", amount_total_cents: 4500 },
        { status: "pending", amount_total_cents: 9900 },
        { status: "refunded", amount_total_cents: 2500 },
        { status: "paid", amount_total_cents: null }, // paid but no amount
      ],
      fulfillments: [],
      clinicalFormOrderCount: 0,
    });
    const s = bucket(r, "storefront");
    expect(s.orders).toBe(5); // all rows in window
    expect(s.paidOrders).toBe(3); // 3 paid
    expect(s.cashRevenueCents).toBe(7900 + 4500); // null amount adds 0
    expect(r.totalCashRevenueCents).toBe(12400);
  });

  it("sums fulfillment units, treating a null quantity as one", () => {
    const r = aggregateRevenueBySource({
      shopOrders: [],
      fulfillments: [
        { status: "shipped", quantity: 2 },
        { status: "shipped", quantity: null },
        { status: "queued", quantity: 3 },
      ],
      clinicalFormOrderCount: 0,
    });
    const f = bucket(r, "resupply_fulfillment");
    expect(f.orders).toBe(3);
    expect(f.units).toBe(6); // 2 + 1 + 3
    expect(f.cashRevenueCents).toBeNull();
    expect(f.paidOrders).toBeNull();
  });

  it("passes clinical-form count through and clamps negatives", () => {
    const r = aggregateRevenueBySource({
      shopOrders: [],
      fulfillments: [],
      clinicalFormOrderCount: 4,
    });
    expect(bucket(r, "clinical_form").orders).toBe(4);

    const neg = aggregateRevenueBySource({
      shopOrders: [],
      fulfillments: [],
      clinicalFormOrderCount: -1,
    });
    expect(bucket(neg, "clinical_form").orders).toBe(0);
  });

  it("totals orders across all three sources", () => {
    const r = aggregateRevenueBySource({
      shopOrders: [
        { status: "paid", amount_total_cents: 1000 },
        { status: "pending", amount_total_cents: 2000 },
      ],
      fulfillments: [{ status: "shipped", quantity: 1 }],
      clinicalFormOrderCount: 3,
    });
    expect(r.totalOrders).toBe(2 + 1 + 3);
    expect(r.totalCashRevenueCents).toBe(1000);
  });
});
