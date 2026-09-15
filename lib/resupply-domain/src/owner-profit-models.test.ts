import { describe, expect, it } from "vitest";
import {
  analyzeOwnerProfitModels,
  ownerProfitAssumptionsSchema,
  type OwnerProfitAssumptions,
} from "./owner-profit-models";
import {
  evaluatePricing,
  PricingValidationError,
  PRICING_MAX_CENTS,
  type PricingInput,
} from "./pricing";

function fixture(): PricingInput {
  return {
    currency: "USD",
    evaluatedAt: "2026-09-14T12:00:00Z",
    lines: [
      {
        id: "mask",
        sku: "MASK",
        quantity: 1,
        unitPriceCents: 10000,
        unitCostCents: 4000,
        costStatus: "verified",
      },
    ],
    costs: [
      {
        id: "freight",
        label: "Delivery",
        category: "freight",
        basis: "order",
        amountCents: 1000,
        quantity: 1,
        status: "verified",
      },
    ],
    revenue: { mode: "self_pay", shippingChargedCents: 0 },
    policy: {
      targetMarginBps: 4000,
      floorMarginBps: 2000,
      basis: "contribution",
    },
  };
}
const monthly = { fixedCostCents: 10000, orders: 10, targetProfitCents: 20000 };
const acquisition = {
  horizonMonths: 12,
  customers: 10,
  ordersPerCustomer: 4,
  acquisitionCostPerCustomerCents: 10000,
  retentionCostPerOrderCents: 1000,
  fixedCostCents: 20000,
};
const capital = {
  periodDays: 30,
  orders: 10,
  cashOutlayPerOrderCents: 5000,
  inventoryDays: 10,
  daysToCollect: 45,
  daysToPayVendor: 30,
};

describe("owner profit planning models", () => {
  it("keeps every model independently incomplete when assumptions are omitted", () => {
    const result = analyzeOwnerProfitModels(fixture(), {});
    for (const key of [
      "strategies",
      "monthly",
      "sensitivity",
      "priceVolume",
      "acquisition",
      "workingCapital",
    ] as const)
      expect(result[key].status).toBe("needs_inputs");
    expect(result.monthly.projectedProfitCents).toBeNull();
    expect(result.workingCapital.estimatedFundingCents).toBeNull();
  });
  it("calculates exact monthly thresholds without counting allocated overhead twice", () => {
    const input = fixture();
    input.adjustments = { overheadCents: 1000 };
    input.policy.basis = "after_overhead";
    const result = analyzeOwnerProfitModels(input, { monthly });
    expect(result.baseline.profitAfterOverheadCents).toBe(4000);
    expect(result.monthly).toMatchObject({
      status: "calculated",
      contributionPerOrderCents: 5000,
      breakEvenOrders: 2,
      targetProfitOrders: 6,
      projectedRevenueCents: 100000,
      projectedContributionCents: 50000,
      projectedProfitCents: 40000,
    });
    expect(result.overheadTreatment).toBe(
      "explicit_fixed_costs_replace_allocated_overhead",
    );
  });
  it("rounds order counts upward at exact whole-order thresholds", () => {
    expect(
      analyzeOwnerProfitModels(fixture(), {
        monthly: {
          ...monthly,
          fixedCostCents: 10001,
          targetProfitCents: 20000,
        },
      }).monthly,
    ).toMatchObject({ breakEvenOrders: 3, targetProfitOrders: 7 });
  });
  it.each([0, 5000])(
    "reports unattainable positive monthly targets at price %i",
    (price) => {
      const input = fixture();
      input.lines = [{ ...input.lines[0], unitPriceCents: price }];
      expect(
        analyzeOwnerProfitModels(input, { monthly }).monthly,
      ).toMatchObject({
        status: "unattainable",
        breakEvenOrders: null,
        targetProfitOrders: null,
      });
    },
  );
  it("treats explicit zero assumptions as values", () => {
    const result = analyzeOwnerProfitModels(fixture(), {
      monthly: { fixedCostCents: 0, orders: 0, targetProfitCents: 0 },
      workingCapital: { ...capital, orders: 0 },
    });
    expect(result.monthly).toMatchObject({
      status: "calculated",
      breakEvenOrders: 0,
      targetProfitOrders: 0,
      projectedProfitCents: 0,
    });
    expect(result.workingCapital.estimatedFundingCents).toBe(0);
  });
  it("compares all strategies through the existing exact order calculation", () => {
    const result = analyzeOwnerProfitModels(fixture(), {
      strategies: {
        targetMarginBps: 6000,
        markupBps: 5000,
        targetContributionCents: 3000,
        referenceUnitPriceCents: 9000,
      },
    });
    expect(result.strategies.items.map((item) => item.unitPriceCents)).toEqual([
      12500, 7501, 8000, 9000,
    ]);
    expect(result.strategies.items[1].equivalentTargetMarginBps).toBe(3334);
    expect(result.strategies.items[1].evaluation?.state).toBe(
      "approval_needed",
    );
    for (const item of result.strategies.items) {
      expect(item.status).toBe("calculated");
      expect(item.evaluation).toEqual(
        evaluatePricing({
          ...fixture(),
          lines: [
            { ...fixture().lines[0], unitPriceCents: item.unitPriceCents! },
          ],
        }),
      );
    }
  });
  it("uses contribution owner targets while retaining an after-overhead hard floor", () => {
    const input = fixture();
    input.policy.basis = "after_overhead";
    input.adjustments = { overheadCents: 2000 };
    const result = analyzeOwnerProfitModels(input, {
      strategies: {
        markupBps: 5000,
        targetContributionCents: 3000,
        targetMarginBps: 3000,
      },
    });
    for (const item of result.strategies.items.slice(0, 3)) {
      expect(item.unitPriceCents).toBe(8750);
      expect(item.evaluation).toMatchObject({
        selectedBasis: "after_overhead",
        contributionCents: 3750,
        profitAfterOverheadCents: 1750,
        meetsFloor: true,
      });
    }
    // Solving 50% markup on all costs including overhead would incorrectly ask 10,501.
    expect(result.strategies.items[1].unitPriceCents).not.toBe(10501);
  });
  it.each([5000, 6000])(
    "does not call a price a percentage markup when recovery %i removes its cost denominator",
    (recoveryCents) => {
      const input = fixture();
      input.adjustments = { recoveryCents };
      const result = analyzeOwnerProfitModels(input, {
        strategies: { markupBps: 5000, referenceUnitPriceCents: 9000 },
        monthly,
      });
      expect(result.strategies.items[1]).toMatchObject({
        status: "not_applicable",
        unitPriceCents: null,
        evaluation: expect.objectContaining({
          totalVariableCostCents: 5000 - recoveryCents,
        }),
        recommendationStatus: null,
        equivalentTargetMarginBps: null,
        issues: [expect.objectContaining({ code: "nonpositive_markup_cost" })],
      });
      // Recovery is still valid financial evidence for other planning models.
      expect(result.strategies.items[3].status).toBe("calculated");
      expect(result.monthly.projectedProfitCents).toBe(
        (5000 + recoveryCents) * monthly.orders - monthly.fixedCostCents,
      );
    },
  );
  it("checks the markup denominator after fee rounding at the candidate amount", () => {
    const input = fixture();
    input.adjustments = { recoveryCents: 5000 };
    input.processing = { rateBps: 300, fixedCents: 0, basis: "net_sales" };
    expect(evaluatePricing(input).totalVariableCostCents).toBe(300);
    const result = analyzeOwnerProfitModels(input, {
      strategies: { markupBps: 5000 },
    }).strategies.items[1];
    expect(result.status).toBe("not_applicable");
    expect(result.unitPriceCents).toBeNull();
    expect(result.evaluation!.totalVariableCostCents).toBe(0);
    expect(result.issues[0].code).toBe("nonpositive_markup_cost");
  });
  it("allows markup when the final policy-constrained amount has positive variable costs", () => {
    const input = fixture();
    input.adjustments = { recoveryCents: 5000, overheadCents: 10000 };
    input.policy.basis = "after_overhead";
    input.processing = { rateBps: 300, fixedCents: 0, basis: "net_sales" };
    input.lines = [{ ...input.lines[0], unitPriceCents: 0 }];
    expect(evaluatePricing(input).totalVariableCostCents).toBe(0);
    const result = analyzeOwnerProfitModels(input, {
      strategies: { markupBps: 5000 },
    }).strategies.items[1];
    expect(result.status).toBe("calculated");
    expect(result.evaluation!.totalVariableCostCents).toBeGreaterThan(0);
    expect(result.evaluation!.meetsFloor).toBe(true);
  });
  it("retains tax, refund and processing fee math in recommendations", () => {
    const input = fixture();
    input.lines = [{ ...input.lines[0], taxBps: 800 }];
    input.processing = {
      rateBps: 300,
      fixedCents: 30,
      basis: "customer_total",
    };
    input.adjustments = {
      expectedRefundCents: 100,
      returnCostCents: 50,
      recoveryCents: 20,
      riskCostCents: 30,
    };
    const result = analyzeOwnerProfitModels(input, {
      strategies: { targetMarginBps: 4000 },
    }).strategies.items[0];
    expect(result.status).toBe("calculated");
    expect(
      result.evaluation!.contributionCents! * 10000,
    ).toBeGreaterThanOrEqual(result.evaluation!.netRevenueCents! * 4000);
    expect(result.evaluation!.taxCents).toBeGreaterThan(0);
    expect(result.evaluation!.processingBaseCents).toBe(
      result.evaluation!.customerTotalCents,
    );
  });
  it("requires a selected line for multi-item pricing and preserves the other line", () => {
    const input = fixture();
    input.lines = [
      ...input.lines,
      {
        id: "tube",
        sku: "TUBE",
        quantity: 2,
        unitPriceCents: 1000,
        unitCostCents: 200,
        costStatus: "verified",
      },
    ];
    expect(
      analyzeOwnerProfitModels(input, {
        strategies: { referenceUnitPriceCents: 9000 },
      }).strategies.items[3].status,
    ).toBe("needs_inputs");
    const result = analyzeOwnerProfitModels(input, {
      selectedLineId: "mask",
      strategies: { referenceUnitPriceCents: 9000 },
    }).strategies.items[3];
    expect(result.evaluation?.merchandiseSubtotalCents).toBe(11000);
    expect(
      result.evaluation?.lines.find((line) => line.id === "tube")
        ?.extendedPriceCents,
    ).toBe(2000);
  });
  it("preserves minimum contribution, price ceilings and recommendation endings", () => {
    const input = fixture();
    input.policy = {
      ...input.policy,
      minimumContributionCents: 4000,
      priceCeilingCents: 10000,
      priceIncrementCents: 100,
      priceEndingCents: 99,
    };
    const result = analyzeOwnerProfitModels(input, {
      strategies: {
        targetMarginBps: 9000,
        targetContributionCents: 1000,
        referenceUnitPriceCents: 11000,
      },
    });
    expect(result.strategies.items[0].status).toBe("unattainable");
    expect(result.strategies.items[2].unitPriceCents).toBe(9099);
    expect(result.strategies.items[2].evaluation?.contributionCents).toBe(4099);
    expect(result.strategies.items[3].status).toBe("blocked");
  });
  it("keeps insurance collectible revenue fixed for strategy/price-volume requests", () => {
    const input = fixture();
    input.revenue = {
      mode: "insurance",
      expectedCollectibleCents: 8000,
      status: "verified",
    };
    const result = analyzeOwnerProfitModels(input, {
      strategies: { referenceUnitPriceCents: 99999 },
      monthly,
      priceVolume: {
        fixedCostCents: 0,
        cases: [{ id: "price", unitPriceCents: 100, orders: 10 }],
      },
    });
    expect(result.strategies.status).toBe("not_applicable");
    expect(result.strategies.items[3].evaluation).toBeNull();
    expect(result.priceVolume.status).toBe("not_applicable");
    expect(result.monthly.projectedRevenueCents).toBe(80000);
  });
  it("labels cost/freight/collection shocks hypothetical and keeps collections counted once", () => {
    const input = fixture();
    input.revenue = {
      mode: "insurance",
      expectedCollectibleCents: 10000,
      status: "verified",
    };
    const result = analyzeOwnerProfitModels(input, {
      sensitivity: {
        cases: [
          {
            id: "stress",
            goodsChangeBps: 1000,
            freightChangeBps: 5000,
            collectibleChangeBps: -1000,
          },
        ],
      },
    }).sensitivity.items[0];
    expect(result.status).toBe("estimated");
    expect(result.evaluation).toMatchObject({
      goodsCostCents: 4400,
      additionalFulfillmentCostCents: 1500,
      netRevenueCents: 9000,
      contributionCents: 3100,
      costsComplete: false,
    });
    expect(result.contributionDeltaCents).toBe(-1900);
    expect(
      result.evaluation!.issues.filter(
        (entry) => entry.code === "estimated_input",
      ),
    ).toHaveLength(3);
  });
  it("rounds changed charge amounts once and preserves the declared quantity", () => {
    const input = fixture();
    input.lines = [{ ...input.lines[0], unitCostCents: 101, quantity: 3 }];
    const result = analyzeOwnerProfitModels(input, {
      sensitivity: { cases: [{ id: "half", goodsChangeBps: -5000 }] },
    }).sensitivity.items[0];
    expect(result.evaluation!.goodsCostCents).toBe(153);
  });
  it("does not invent separately changeable freight within goods or use collection shocks for self-pay", () => {
    const input = fixture();
    input.costs = [{ ...input.costs[0], includedInId: "mask" }];
    const result = analyzeOwnerProfitModels(input, {
      sensitivity: {
        cases: [
          { id: "freight", freightChangeBps: 1000 },
          { id: "collection", collectibleChangeBps: -1000 },
        ],
      },
    });
    expect(result.sensitivity.items[0].status).toBe("needs_inputs");
    expect(result.sensitivity.items[1].status).toBe("not_applicable");
  });
  it.each([false, true])(
    "changes a separately itemized freight parent once when it has a freight alias (nested: %s)",
    (nested) => {
      const input = fixture();
      input.costs = [
        ...input.costs,
        ...(nested
          ? [
              {
                id: "included-service",
                label: "Included delivery service",
                category: "other" as const,
                basis: "order" as const,
                amountCents: null,
                status: "missing" as const,
                includedInId: "freight",
              },
            ]
          : []),
        {
          id: "carrier-charge",
          label: "Carrier charge included in delivery",
          category: "shipping",
          basis: "parcel",
          amountCents: null,
          quantity: 2,
          status: "missing",
          includedInId: nested ? "included-service" : "freight",
        },
      ];
      expect(evaluatePricing(input).costsComplete).toBe(true);
      const before = structuredClone(input);
      const result = analyzeOwnerProfitModels(input, {
        sensitivity: {
          cases: [{ id: "delivery-increase", freightChangeBps: 5000 }],
        },
      }).sensitivity.items[0];
      expect(result.status).toBe("estimated");
      expect(result.evaluation).toMatchObject({
        additionalFulfillmentCostCents: 1500,
        goodsCostCents: 4000,
        contributionCents: 4500,
      });
      expect(result.contributionDeltaCents).toBe(-500);
      expect(
        result.evaluation?.costs.find((cost) => cost.id === "carrier-charge"),
      ).toMatchObject({ included: true, extendedCostCents: 0 });
      expect(input).toEqual(before);
    },
  );
  it("still requires separate freight evidence when an alias ultimately belongs to a non-freight charge", () => {
    const input = fixture();
    input.costs = [
      { ...input.costs[0], category: "handling" },
      {
        id: "carrier-charge",
        label: "Included carrier charge",
        category: "shipping",
        basis: "order",
        amountCents: 500,
        status: "verified",
        includedInId: "freight",
      },
    ];
    const result = analyzeOwnerProfitModels(input, {
      sensitivity: {
        cases: [{ id: "delivery-increase", freightChangeBps: 5000 }],
      },
    }).sensitivity.items[0];
    expect(result.status).toBe("needs_inputs");
    expect(result.evaluation).toBeNull();
    expect(result.issues[0].code).toBe("freight_scope_needed");
  });
  it.each(["missing", "stale"] as const)(
    "does not use an included alias to repair %s freight-parent evidence",
    (status) => {
      const input = fixture();
      input.costs = [
        {
          ...input.costs[0],
          status,
          amountCents: status === "missing" ? null : 1000,
        },
        {
          id: "carrier-charge",
          label: "Included carrier charge",
          category: "shipping",
          basis: "order",
          amountCents: 1000,
          status: "verified",
          includedInId: "freight",
        },
      ];
      const result = analyzeOwnerProfitModels(input, {
        sensitivity: {
          cases: [{ id: "delivery-increase", freightChangeBps: 5000 }],
        },
      }).sensitivity.items[0];
      expect(result.status).toBe("needs_inputs");
      expect(result.evaluation).toBeNull();
      expect(
        result.issues.some((entry) => entry.code === `${status}_input`),
      ).toBe(true);
    },
  );
  it("evaluates explicit price-volume alternatives without predicting demand", () => {
    const result = analyzeOwnerProfitModels(fixture(), {
      priceVolume: {
        fixedCostCents: 10000,
        cases: [
          { id: "lower", unitPriceCents: 8000, orders: 100 },
          { id: "current", unitPriceCents: 10000, orders: 50 },
        ],
      },
    });
    expect(result.priceVolume.items).toMatchObject([
      {
        projectedRevenueCents: 800000,
        projectedContributionCents: 300000,
        projectedProfitCents: 290000,
      },
      {
        projectedRevenueCents: 500000,
        projectedContributionCents: 250000,
        projectedProfitCents: 240000,
      },
    ]);
  });
  it("does not resize exact payment captures to make a hypothetical reference price work", () => {
    const input = fixture();
    input.processing = {
      rateBps: 300,
      fixedCents: 30,
      basis: "customer_total",
      chargeAmountsCents: [10000],
    };
    const result = analyzeOwnerProfitModels(input, {
      strategies: { referenceUnitPriceCents: 9000 },
      priceVolume: {
        fixedCostCents: 0,
        cases: [{ id: "lower", unitPriceCents: 9000, orders: 1 }],
      },
    });
    expect(result.strategies.items[3]).toMatchObject({
      status: "blocked",
      evaluation: null,
    });
    expect(result.priceVolume.items[0]).toMatchObject({
      status: "blocked",
      evaluation: null,
    });
  });
  it("calculates finite-horizon acquisition economics and order payback", () => {
    const result = analyzeOwnerProfitModels(fixture(), {
      acquisition,
    }).acquisition;
    expect(result).toMatchObject({
      status: "calculated",
      horizonMonths: 12,
      totalOrders: 40,
      contributionPerCustomerCents: 20000,
      netPerCustomerCents: 6000,
      totalAcquisitionCostCents: 100000,
      projectedProfitCents: 40000,
      acquisitionPaybackOrders: 3,
      paybackWithinHorizon: true,
    });
    expect(
      analyzeOwnerProfitModels(fixture(), {
        acquisition: { ...acquisition, ordersPerCustomer: 2 },
      }).acquisition.paybackWithinHorizon,
    ).toBe(false);
  });
  it("cannot repay acquisition when retention consumes all per-order contribution", () => {
    expect(
      analyzeOwnerProfitModels(fixture(), {
        acquisition: { ...acquisition, retentionCostPerOrderCents: 5000 },
      }).acquisition,
    ).toMatchObject({
      status: "unattainable",
      acquisitionPaybackOrders: null,
      paybackWithinHorizon: false,
    });
  });
  it("estimates working capital with explicit days and conservative cent rounding", () => {
    expect(
      analyzeOwnerProfitModels(fixture(), { workingCapital: capital })
        .workingCapital,
    ).toMatchObject({
      status: "estimated",
      fundingGapDays: 25,
      periodCashOutlayCents: 50000,
      estimatedFundingCents: 41667,
    });
    expect(
      analyzeOwnerProfitModels(fixture(), {
        workingCapital: { ...capital, daysToPayVendor: 90 },
      }).workingCapital.estimatedFundingCents,
    ).toBe(0);
  });
  it.each(["missing", "stale"] as const)(
    "does not project profit from %s evidence while independent cash assumptions remain usable",
    (status) => {
      const input = fixture();
      input.lines = [{ ...input.lines[0], costStatus: status }];
      const result = analyzeOwnerProfitModels(input, {
        monthly,
        acquisition,
        workingCapital: capital,
      });
      expect(result.monthly.status).toBe("needs_inputs");
      expect(result.monthly.projectedProfitCents).toBeNull();
      expect(result.acquisition.status).toBe("needs_inputs");
      expect(result.workingCapital.status).toBe("estimated");
    },
  );
  it("keeps estimated financial projections explicitly estimated", () => {
    const input = fixture();
    input.lines = [{ ...input.lines[0], costStatus: "estimated" }];
    expect(analyzeOwnerProfitModels(input, { monthly }).monthly).toMatchObject({
      status: "estimated",
      projectedProfitCents: 40000,
    });
  });
  it("isolates overflowing model outputs without returning unsafe cents", () => {
    const input = fixture();
    input.lines = [{ ...input.lines[0], unitPriceCents: PRICING_MAX_CENTS }];
    const result = analyzeOwnerProfitModels(input, {
      monthly: { ...monthly, orders: 1000000 },
      workingCapital: {
        ...capital,
        cashOutlayPerOrderCents: PRICING_MAX_CENTS,
        orders: 1000000,
      },
    });
    expect(result.monthly).toMatchObject({
      status: "blocked",
      projectedProfitCents: null,
    });
    expect(result.workingCapital).toMatchObject({
      status: "blocked",
      estimatedFundingCents: null,
    });
    expect(JSON.stringify(result)).not.toMatch(/NaN|Infinity/);
  });
  it.each(["sensitivity", "priceVolume"] as const)(
    "rejects duplicate %s case identifiers",
    (key) => {
      const item =
        key === "sensitivity"
          ? { id: "same", goodsChangeBps: 1 }
          : { id: "same", unitPriceCents: 1000, orders: 1 };
      expect(
        ownerProfitAssumptionsSchema.safeParse({
          [key]: { cases: [item, item] },
        }).success,
      ).toBe(false);
    },
  );
  it("bounds inputs and distinguishes invalid assumptions from missing ones", () => {
    for (const value of [
      { monthly: { orders: 0.5 } },
      { workingCapital: { periodDays: 0 } },
      { acquisition: { horizonMonths: 121 } },
      { monthly: { fixedCostCents: -1 } },
      {
        sensitivity: {
          cases: Array.from({ length: 13 }, (_, n) => ({ id: String(n) })),
        },
      },
    ])
      expect(() =>
        analyzeOwnerProfitModels(fixture(), value as OwnerProfitAssumptions),
      ).toThrow(PricingValidationError);
  });
  it("bounds automated recommendations for large baskets but still evaluates reference prices", () => {
    const input = fixture();
    input.costs = Array.from({ length: 160 }, (_, n) => ({
      id: String(n),
      label: "Cost",
      category: "other",
      basis: "order",
      amountCents: 1,
      status: "verified",
    }));
    const result = analyzeOwnerProfitModels(input, {
      strategies: { targetMarginBps: 5000, referenceUnitPriceCents: 10000 },
    });
    expect(result.strategies.items[0].issues[0].code).toBe(
      "scenario_too_large",
    );
    expect(result.strategies.items[3].status).toBe("calculated");
  });
  it("does not mutate inputs and returns only serializable values", () => {
    const input = fixture(),
      before = structuredClone(input);
    const assumptions = {
      strategies: { targetMarginBps: 5000 },
      monthly,
      acquisition,
      workingCapital: capital,
    };
    const result = analyzeOwnerProfitModels(input, assumptions);
    expect(input).toEqual(before);
    expect(JSON.parse(JSON.stringify(result))).toEqual(result);
  });
});
