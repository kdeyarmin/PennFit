import { describe, expect, it } from "vitest";
import { evaluatePricing, type PricingInput } from "@workspace/resupply-domain";
import type { ResolvedScenario } from "./contracts";
import { calculateDiscountHeadroom } from "./discount-headroom";

function scenario(change: Partial<PricingInput> = {}): ResolvedScenario {
  const input: PricingInput = {
    currency: "USD",
    evaluatedAt: "2026-09-14T12:00:00Z",
    lines: [
      {
        id: "line",
        sku: "MASK",
        quantity: 1,
        unitPriceCents: 10000,
        unitCostCents: 4000,
        costStatus: "verified",
      },
    ],
    costs: [],
    revenue: { mode: "self_pay", shippingChargedCents: 0 },
    processing: { basis: "net_sales", rateBps: 290, fixedCents: 0 },
    policy: {
      targetMarginBps: 4000,
      floorMarginBps: 2000,
      basis: "contribution",
    },
    ...change,
  };
  return { input, evaluation: evaluatePricing(input) } as ResolvedScenario;
}
describe("fixed-scenario discount headroom", () => {
  it("finds exact target and floor cents including processing rounding", async () => {
    const base = scenario();
    const result = await calculateDiscountHeadroom(base);
    expect(result.status).toBe("calculated");
    expect(result.wholeDomainSearched).toBe(true);
    expect(result.target?.additionalDiscountCents).toBe(2995);
    expect(result.floor?.additionalDiscountCents).toBe(4812);
    for (const [threshold, candidate] of [
      ["meetsTarget", result.target],
      ["meetsFloor", result.floor],
    ] as const) {
      expect(candidate?.evaluation[threshold]).toBe(true);
      const next = evaluatePricing({
        ...base.input,
        revenue: {
          mode: "self_pay",
          shippingChargedCents: 0,
          discountCents: candidate!.additionalDiscountCents + 1,
        },
      });
      expect(next[threshold]).toBe(false);
    }
  });
  it("preserves existing percentage and fixed discounts and labels partial searches", async () => {
    const base = scenario({
      revenue: {
        mode: "self_pay",
        shippingChargedCents: 0,
        discountBps: 1000,
        discountCents: 100,
      },
    });
    const result = await calculateDiscountHeadroom(base, 100);
    expect(result.status).toBe("search_limit");
    expect(result.wholeDomainSearched).toBe(false);
    expect(result.searchUpperBoundCents).toBe(100);
    expect(result.target?.evaluation.discountCents).toBe(1200);
    expect(base.input.revenue).toMatchObject({
      discountBps: 1000,
      discountCents: 100,
    });
  });
  it("retains per-line floors and minimum contribution", async () => {
    const result = await calculateDiscountHeadroom(
      scenario({
        processing: null,
        policy: {
          targetMarginBps: 4000,
          floorMarginBps: 2000,
          lineFloorMarginBps: 4500,
          minimumContributionCents: 5000,
          basis: "contribution",
        },
      }),
    );
    expect(result.target?.additionalDiscountCents).toBe(1000);
    expect(result.floor?.additionalDiscountCents).toBe(1000);
  });
  it("does not advertise discounts for unknown costs, insurance, frozen captures or forbidden billed amounts", async () => {
    expect(
      (
        await calculateDiscountHeadroom(
          scenario({
            revenue: {
              mode: "insurance",
              expectedCollectibleCents: 10000,
              status: "verified",
            },
          }),
        )
      ).status,
    ).toBe("self_pay_required");
    expect(
      (
        await calculateDiscountHeadroom(
          scenario({
            costs: [
              {
                id: "unknown",
                label: "Missing",
                category: "other",
                basis: "order",
                amountCents: null,
                status: "missing",
              },
            ],
          }),
        )
      ).status,
    ).toBe("cost_information_needed");
    expect(
      (
        await calculateDiscountHeadroom(
          scenario({
            processing: {
              rateBps: 290,
              fixedCents: 30,
              basis: "net_sales",
              chargeAmountsCents: [10000],
            },
          }),
        )
      ).status,
    ).toBe("fixed_capture_amounts");
    const blocked = scenario();
    blocked.evaluation.issues.push({
      code: "price_ceiling_exceeded",
      path: "lines",
      message: "fixture",
    });
    expect((await calculateDiscountHeadroom(blocked)).status).toBe(
      "blocked_policy",
    );
  });
});
