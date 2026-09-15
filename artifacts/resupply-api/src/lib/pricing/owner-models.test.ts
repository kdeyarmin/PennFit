import { describe, expect, it } from "vitest";
import {
  evaluatePricing,
  type PricingInput,
  type PricingPolicy,
} from "@workspace/resupply-domain";
import type { ResolvedScenario } from "./contracts";
import { analyzeResolvedOwnerProfitModels } from "./owner-models";

function fixture(): ResolvedScenario {
  const policy: PricingPolicy = {
    targetMarginBps: 4000,
    floorMarginBps: 2000,
    basis: "contribution",
    priceIncrementCents: 100,
    priceEndingCents: 99,
  };
  const input: PricingInput = {
    currency: "USD",
    evaluatedAt: "2026-09-14T12:00:00Z",
    lines: ["mask", "tube"].map((id) => ({
      id,
      sku: id.toUpperCase(),
      quantity: 1,
      unitPriceCents: 10000,
      unitCostCents: 9000,
      costStatus: "verified",
    })),
    costs: [],
    revenue: { mode: "self_pay", shippingChargedCents: 0 },
    policy,
  };
  return {
    scenario: {
      validUntil: "2099-01-01T00:00:00Z",
      revenue: { mode: "self_pay", shippingChargedCents: 0 },
      lines: input.lines.map((line) => ({
        id: line.id,
        sku: line.sku,
        description: line.sku,
        quantity: line.quantity,
        unitAmountCents: line.unitPriceCents,
        fulfillmentMethod: "stock",
        offerId: `offer-${line.id}`,
        offerVersion: 1,
      })),
    },
    input,
    evaluation: {
      ...evaluatePricing(input),
      policyApplications: [
        { lineId: "mask", rules: { ...policy, priceCeilingCents: 12000 } },
        {
          lineId: "tube",
          rules: { ...policy, priceEndingCents: 49, priceCeilingCents: 25049 },
        },
      ],
    } as ResolvedScenario["evaluation"] & {
      policyApplications: Array<{ lineId: string; rules: PricingPolicy }>;
    },
    dependencies: [],
    policyId: "policy",
    policyVersion: 2,
  };
}

function applications(resolved: ResolvedScenario) {
  return (
    resolved.evaluation as ResolvedScenario["evaluation"] & {
      policyApplications: Array<{ lineId: string; rules: PricingPolicy }>;
    }
  ).policyApplications;
}

describe("owner models with resolved item policies", () => {
  it("uses the selected item's price grid and preserves the authoritative baseline", () => {
    const resolved = fixture();
    const original = structuredClone(resolved);
    const models = analyzeResolvedOwnerProfitModels(resolved, {
      selectedLineId: "tube",
      strategies: { targetMarginBps: 4000 },
    });
    expect(models.strategies.items[0]).toMatchObject({
      status: "calculated",
      unitPriceCents: 20049,
      recommendationStatus: "recommended",
    });
    expect(models.baseline).toEqual(resolved.evaluation);
    expect(resolved).toEqual(original);
  });

  it("does not inherit another item's grid when the selected policy has none", () => {
    const resolved = fixture();
    applications(resolved)[1].rules = {
      targetMarginBps: 4000,
      floorMarginBps: 2000,
      basis: "contribution",
    };
    const models = analyzeResolvedOwnerProfitModels(resolved, {
      selectedLineId: "tube",
      strategies: { targetMarginBps: 4000 },
    });
    expect(models.strategies.items[0].unitPriceCents).toBe(20000);
  });

  it("withholds recommendations above the selected item's ceiling", () => {
    const models = analyzeResolvedOwnerProfitModels(fixture(), {
      selectedLineId: "tube",
      strategies: { targetMarginBps: 7000 },
    });
    expect(models.strategies.items[0]).toMatchObject({
      unitPriceCents: null,
      recommendationStatus: "ceiling_exceeded",
    });
  });

  it("retains but blocks reference and volume what-ifs above an item ceiling", () => {
    const models = analyzeResolvedOwnerProfitModels(fixture(), {
      selectedLineId: "tube",
      strategies: { referenceUnitPriceCents: 26000 },
      priceVolume: {
        fixedCostCents: 0,
        cases: [{ id: "high", unitPriceCents: 26000, orders: 10 }],
      },
    });
    expect(
      models.strategies.items.find(
        (item) => item.strategy === "reference_price",
      ),
    ).toMatchObject({
      status: "blocked",
      unitPriceCents: 26000,
      evaluation: { state: "blocked" },
      issues: expect.arrayContaining([
        expect.objectContaining({
          code: "price_ceiling_exceeded",
          path: "lines.tube",
        }),
      ]),
    });
    expect(models.priceVolume.items[0]).toMatchObject({
      status: "blocked",
      projectedRevenueCents: 360000,
    });
  });

  it("blocks an unchanged item above its ceiling across relevant models", () => {
    const resolved = fixture();
    resolved.input.lines[0].unitPriceCents = 30000;
    resolved.scenario.lines[0].unitAmountCents = 30000;
    resolved.evaluation = {
      ...resolved.evaluation,
      ...evaluatePricing(resolved.input),
    };
    const models = analyzeResolvedOwnerProfitModels(resolved, {
      selectedLineId: "tube",
      strategies: { targetMarginBps: 4000 },
      monthly: { fixedCostCents: 0, orders: 10, targetProfitCents: 10000 },
      acquisition: {
        horizonMonths: 12,
        customers: 10,
        ordersPerCustomer: 1,
        acquisitionCostPerCustomerCents: 0,
        retentionCostPerOrderCents: 0,
        fixedCostCents: 0,
      },
      sensitivity: { cases: [{ id: "goods", goodsChangeBps: 100 }] },
    });
    expect(models.baseline.state).toBe("blocked");
    expect(models.strategies.items[0]).toMatchObject({
      status: "blocked",
      unitPriceCents: null,
      recommendationStatus: "no_qualifying_price",
    });
    expect(models.monthly.status).toBe("blocked");
    expect(models.acquisition.status).toBe("blocked");
    expect(models.sensitivity.items[0].status).toBe("blocked");
  });

  it("allows a new selected price to repair its own ceiling violation", () => {
    const resolved = fixture();
    resolved.input.lines[1].unitPriceCents = 30000;
    resolved.scenario.lines[1].unitAmountCents = 30000;
    resolved.evaluation = {
      ...resolved.evaluation,
      ...evaluatePricing(resolved.input),
    };
    const models = analyzeResolvedOwnerProfitModels(resolved, {
      selectedLineId: "tube",
      strategies: { targetMarginBps: 4000 },
    });
    expect(models.baseline.state).toBe("blocked");
    expect(models.strategies.items[0]).toMatchObject({
      status: "calculated",
      unitPriceCents: 20049,
    });
  });

  it("compares ceiling against unit price rather than the extended multi-unit price", () => {
    const resolved = fixture();
    resolved.input.lines[1].quantity = 3;
    resolved.scenario.lines[1].quantity = 3;
    resolved.evaluation = {
      ...resolved.evaluation,
      ...evaluatePricing(resolved.input),
    };
    const models = analyzeResolvedOwnerProfitModels(resolved, {
      selectedLineId: "tube",
      strategies: { referenceUnitPriceCents: 20000 },
    });
    const item = models.strategies.items.find(
      (entry) => entry.strategy === "reference_price",
    )!;
    expect(item.status).toBe("calculated");
    expect(
      item.issues.some((issue) => issue.code === "price_ceiling_exceeded"),
    ).toBe(false);
  });

  it.each(["missing", "duplicate", "incomplete"])(
    "fails closed for %s resolved policy context",
    (kind) => {
      const resolved = fixture();
      if (kind === "missing")
        resolved.evaluation = evaluatePricing(resolved.input);
      else if (kind === "duplicate") applications(resolved)[1].lineId = "mask";
      else applications(resolved).pop();
      expect(() => analyzeResolvedOwnerProfitModels(resolved, {})).toThrow(
        "pricing_policy_context_missing",
      );
    },
  );

  it("does not silently choose an item for an unknown selection", () => {
    const models = analyzeResolvedOwnerProfitModels(fixture(), {
      selectedLineId: "unknown",
      strategies: { targetMarginBps: 4000 },
    });
    expect(models.strategies.items[0].unitPriceCents).toBeNull();
    expect(models.strategies.items[0].status).toBe("needs_inputs");
  });

  it.each([0, 5000])(
    "blocks insurance collection stress above the allowed amount before %i cents of refunds",
    (expectedRefundCents) => {
      const resolved = fixture();
      resolved.input.revenue = {
        mode: "insurance",
        expectedCollectibleCents: 30000,
        status: "verified",
      };
      resolved.scenario.revenue = {
        ...resolved.input.revenue,
        expiresAt: resolved.input.revenue.expiresAt ?? undefined,
        allowedCents: 33000,
      };
      resolved.input.adjustments = { expectedRefundCents };
      resolved.evaluation = {
        ...resolved.evaluation,
        ...evaluatePricing(resolved.input),
      };
      const models = analyzeResolvedOwnerProfitModels(resolved, {
        sensitivity: {
          cases: [
            { id: "at-limit", collectibleChangeBps: 1000 },
            { id: "over-limit", collectibleChangeBps: 2000 },
          ],
        },
      });
      expect(models.sensitivity.items[0]).toMatchObject({
        status: "estimated",
        evaluation: { netRevenueCents: 33000 - expectedRefundCents },
      });
      expect(models.sensitivity.items[1]).toMatchObject({
        status: "blocked",
        evaluation: {
          state: "blocked",
          netRevenueCents: 36000 - expectedRefundCents,
        },
        issues: expect.arrayContaining([
          expect.objectContaining({ code: "collectible_exceeds_allowed" }),
        ]),
      });
    },
  );
});
