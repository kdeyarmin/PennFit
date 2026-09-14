import { describe, expect, it } from "vitest";
import {
  allocatePricingCents,
  evaluatePricing,
  recommendPricing,
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
        sku: "MASK-FIXTURE",
        quantity: 1,
        unitPriceCents: 9527,
        unitCostCents: 4200,
        costStatus: "verified",
      },
    ],
    costs: [
      {
        id: "drop",
        label: "Supplier fee",
        category: "dropship",
        basis: "shipment",
        amountCents: 300,
        status: "verified",
      },
      {
        id: "freight",
        label: "Supplier delivery",
        category: "shipping",
        basis: "parcel",
        amountCents: 700,
        status: "verified",
      },
      {
        id: "handling",
        label: "Handling",
        category: "handling",
        basis: "order",
        amountCents: 200,
        status: "verified",
      },
    ],
    revenue: { mode: "self_pay", shippingChargedCents: 0 },
    processing: { rateBps: 300, fixedCents: 30, basis: "customer_total" },
    policy: {
      targetMarginBps: 4000,
      floorMarginBps: 3000,
      basis: "contribution",
    },
  };
}

function setPrice(input: PricingInput, price: number): PricingInput {
  return {
    ...input,
    lines: input.lines.map((line) => ({ ...line, unitPriceCents: price })),
  };
}

describe("contribution pricing financial acceptance", () => {
  it("enforces the exact one-cent boundary hidden by rounded displayed percentages", () => {
    const input = fixture();
    const result = evaluatePricing(input);
    expect(result).toMatchObject({
      state: "meets_target",
      deliveredCostCents: 5400,
      processingFeeCents: 316,
      totalVariableCostCents: 5716,
      contributionCents: 3811,
      netRevenueCents: 9527,
      meetsTarget: true,
      meetsFloor: true,
      costsComplete: true,
    });
    expect(result.contributionMarginBps).toBeCloseTo(4000.20992967);
    expect(evaluatePricing(setPrice(input, 9526))).toMatchObject({
      state: "approval_needed",
      contributionCents: 3810,
      meetsTarget: false,
    });
    const recommendation = recommendPricing(setPrice(input, 6000));
    expect(recommendation.recommendedUnitPriceCents).toBe(9527);
    expect(recommendation.evaluation.state).toBe("meets_target");
  });

  it("does not assume a card fee on a no-fee collection method", () => {
    const input = { ...fixture(), processing: null };
    const result = recommendPricing(input);
    expect(result.recommendedUnitPriceCents).toBe(9000);
    expect(result.evaluation).toMatchObject({
      processingFeeCents: 0,
      contributionCents: 3600,
      meetsTarget: true,
    });
  });

  it("treats charged shipping as revenue while retaining actual delivery expense", () => {
    const input = setPrice(fixture(), 8927);
    input.revenue = { mode: "self_pay", shippingChargedCents: 600 };
    const result = evaluatePricing(input);
    expect(result).toMatchObject({
      shippingChargedCents: 600,
      netRevenueCents: 9527,
      deliveredCostCents: 5400,
      contributionCents: 3811,
    });
    expect(recommendPricing(input).recommendedUnitPriceCents).toBe(8927);
  });

  it("excludes tax from sales but includes it in the configured processor basis", () => {
    const input = setPrice(fixture(), 9577);
    input.lines = input.lines.map((line) => ({ ...line, taxBps: 1000 }));
    expect(evaluatePricing(input)).toMatchObject({
      netRevenueCents: 9577,
      taxCents: 958,
      customerTotalCents: 10535,
      processingBaseCents: 10535,
      processingFeeCents: 346,
      contributionCents: 3831,
      meetsTarget: true,
    });
    expect(recommendPricing(input).recommendedUnitPriceCents).toBe(9577);
    expect(evaluatePricing(setPrice(input, 9527)).meetsTarget).toBe(false);
  });

  it("applies a rounded merchandise discount before the actual tax and fee", () => {
    const input = setPrice(fixture(), 10586);
    input.revenue = {
      mode: "self_pay",
      shippingChargedCents: 0,
      discountBps: 1000,
    };
    expect(evaluatePricing(input)).toMatchObject({
      discountCents: 1059,
      netRevenueCents: 9527,
      contributionCents: 3811,
      meetsTarget: true,
    });
    expect(recommendPricing(input).recommendedUnitPriceCents).toBe(10586);
  });

  it("counts extra supplier/parcel charges without inventing another payment fee", () => {
    const input = setPrice(fixture(), 11280);
    input.costs = input.costs.map((cost) => ({
      ...cost,
      quantity: cost.basis === "order" ? 1 : 2,
    }));
    expect(evaluatePricing(input)).toMatchObject({
      deliveredCostCents: 6400,
      processingFeeCents: 368,
      contributionCents: 4512,
      meetsTarget: true,
    });
    expect(recommendPricing(input).recommendedUnitPriceCents).toBe(11280);
  });

  it("returns the ceiling conflict rather than a below-target recommendation", () => {
    const input = setPrice(fixture(), 9000);
    input.policy.priceCeilingCents = 9000;
    expect(evaluatePricing(input).contributionMarginBps).toBeCloseTo(
      3666.6666667,
    );
    expect(recommendPricing(input)).toMatchObject({
      status: "ceiling_exceeded",
      recommendedUnitPriceCents: null,
      recommendedInput: null,
    });
  });

  it("uses expected net sales for returns and counts the retained original fee only once", () => {
    const input = setPrice(fixture(), 10000);
    input.lines = input.lines.map((line) => ({ ...line, unitCostCents: 6000 }));
    input.costs = [];
    input.adjustments = {
      expectedRefundCents: 1000,
      returnCostCents: 200,
      recoveryCents: 500,
    };
    expect(evaluatePricing(input)).toMatchObject({
      originalRevenueCents: 10000,
      netRevenueCents: 9000,
      processingBaseCents: 10000,
      processingFeeCents: 330,
      totalVariableCostCents: 6030,
      contributionCents: 2970,
      contributionMarginBps: 3300,
    });
    input.adjustments.processingFeeCreditCents = 30;
    expect(evaluatePricing(input)).toMatchObject({
      processingFeeCents: 300,
      contributionCents: 3000,
    });
  });

  it("separates contribution and optional overhead-controlled profit", () => {
    const input = fixture();
    input.adjustments = { overheadCents: 500 };
    const contribution = evaluatePricing(input);
    expect(contribution).toMatchObject({
      contributionCents: 3811,
      profitAfterOverheadCents: 3311,
      state: "meets_target",
    });
    input.policy.basis = "after_overhead";
    expect(evaluatePricing(input)).toMatchObject({
      contributionCents: 3811,
      selectedBasisProfitCents: 3311,
      state: "approval_needed",
    });
    const recommendation = recommendPricing(input);
    expect(recommendation.evaluation.meetsTarget).toBe(true);
    expect(recommendation.recommendedUnitPriceCents).toBeGreaterThan(9527);
  });

  it("keeps insurance collections fixed and does not manufacture patient liability", () => {
    const input = fixture();
    input.revenue = {
      mode: "insurance",
      expectedCollectibleCents: 8000,
      status: "verified",
    };
    input.processing = null;
    const result = evaluatePricing(input);
    expect(result).toMatchObject({
      netRevenueCents: 8000,
      customerTotalCents: null,
      contributionCents: 2600,
      maximumDeliveredCostCents: 4800,
      state: "approval_needed",
    });
    expect(recommendPricing(input)).toMatchObject({
      status: "fixed_revenue",
      recommendedUnitPriceCents: null,
    });
    expect(evaluatePricing(setPrice(input, 50000)).netRevenueCents).toBe(8000);
  });

  it("uses the selected margin basis AND minimum contribution in the affordable cost ceiling", () => {
    const input = fixture();
    input.revenue = {
      mode: "insurance",
      expectedCollectibleCents: 10000,
      status: "verified",
    };
    input.processing = null;
    input.adjustments = { overheadCents: 1000 };
    input.policy.basis = "after_overhead";
    expect(evaluatePricing(input).maximumDeliveredCostCents).toBe(5000);
    input.policy.minimumContributionCents = 5500;
    expect(evaluatePricing(input)).toMatchObject({
      maximumDeliveredCostCents: 4500,
      meetsMinimumContribution: false,
      state: "blocked",
    });
  });
});

describe("cost completeness and exact allocation", () => {
  it.each(["missing", "stale", "estimated"] as const)(
    "does not silently approve %s costs",
    (quality) => {
      const input = fixture();
      input.lines = input.lines.map((line) => ({
        ...line,
        costStatus: quality,
      }));
      expect(evaluatePricing(input)).toMatchObject({
        state: "cost_information_needed",
        costsComplete: false,
      });
      expect(recommendPricing(input).status).toBe("cost_information_needed");
    },
  );

  it("propagates missing costs instead of treating them as zero", () => {
    const input = fixture();
    input.lines = input.lines.map((line) => ({ ...line, unitCostCents: null }));
    expect(evaluatePricing(input)).toMatchObject({
      goodsCostCents: null,
      deliveredCostCents: null,
      knownDeliveredCostCents: 1200,
      contributionCents: null,
      meetsTarget: null,
      state: "cost_information_needed",
    });
  });

  it("distinguishes known zero and expiry equality from missing values", () => {
    const input = fixture();
    input.lines = input.lines.map((line) => ({ ...line, unitCostCents: 0 }));
    expect(evaluatePricing(input).costsComplete).toBe(true);
    input.lines = input.lines.map((line) => ({
      ...line,
      costExpiresAt: input.evaluatedAt,
    }));
    expect(evaluatePricing(input).issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "stale_input" }),
      ]),
    );
  });

  it("does not hide unknown insurance reimbursement behind billed line amounts", () => {
    const input = fixture();
    input.revenue = {
      mode: "insurance",
      expectedCollectibleCents: null,
      status: "missing",
    };
    expect(evaluatePricing(input)).toMatchObject({
      netRevenueCents: null,
      contributionCents: null,
      processingFeeCents: null,
      state: "cost_information_needed",
    });
  });

  it("extends unit goods cost and explicitly counted costs; included freight is not double counted", () => {
    const input = fixture();
    input.lines = input.lines.map((line) => ({
      ...line,
      quantity: 2,
      unitCostCents: 4900,
    }));
    input.costs = input.costs.map((cost) =>
      cost.id === "freight" ? { ...cost, includedInId: "mask" } : cost,
    );
    expect(evaluatePricing(input)).toMatchObject({
      goodsCostCents: 9800,
      additionalFulfillmentCostCents: 500,
      deliveredCostCents: 10300,
    });
    expect(
      evaluatePricing(input).costs.find((cost) => cost.id === "freight"),
    ).toEqual({ id: "freight", included: true, extendedCostCents: 0 });
  });

  it("rejects inclusion cycles and references that cannot prove inclusion", () => {
    const input = fixture();
    input.costs = input.costs.map((cost) => ({
      ...cost,
      includedInId: cost.id,
    }));
    expect(() => evaluatePricing(input)).toThrow(PricingValidationError);
    input.costs = [{ ...fixture().costs[0], includedInId: "unknown" }];
    expect(() => evaluatePricing(input)).toThrow(PricingValidationError);
  });

  it("allocates pennies deterministically and preserves the total across large unequal weights", () => {
    expect(allocatePricingCents(2, [1, 1, 1])).toEqual([1, 1, 0]);
    for (let total = 0; total < 111; total++) {
      const allocated = allocatePricingCents(
        total,
        [99_999_999_999, 70_000_000_000, 7],
      );
      expect(allocated.reduce((sum, amount) => sum + amount, 0)).toBe(total);
      expect(allocated.every(Number.isSafeInteger)).toBe(true);
    }
    expect(() => allocatePricingCents(1, [0, 0])).toThrow(
      PricingValidationError,
    );
    expect(allocatePricingCents(0, [0, 0])).toEqual([0, 0]);
  });

  it("allocates order discounts before different line taxes and preserves shared costs", () => {
    const input = fixture();
    input.lines = [
      {
        ...input.lines[0],
        unitPriceCents: 100,
        unitCostCents: 10,
        taxBps: 1000,
      },
      {
        ...input.lines[0],
        id: "tube",
        sku: "TUBE",
        unitPriceCents: 100,
        unitCostCents: 10,
        taxBps: 0,
      },
    ];
    input.revenue = {
      mode: "self_pay",
      shippingChargedCents: 100,
      shippingTaxBps: 500,
      discountCents: 1,
    };
    const result = evaluatePricing(input);
    expect(result.lines.map((line) => line.discountCents)).toEqual([1, 0]);
    expect(result.taxCents).toBe(15);
    expect(
      result.lines.reduce(
        (sum, line) => sum + line.allocatedSharedCostCents!,
        0,
      ),
    ).toBe(result.additionalFulfillmentCostCents! + result.processingFeeCents!);
  });

  it("rounds fees per actual capture, independently of parcel count", () => {
    const input = setPrice(fixture(), 102);
    input.processing = {
      rateBps: 100,
      fixedCents: 30,
      basis: "customer_total",
      chargeAmountsCents: [51, 51],
    };
    expect(evaluatePricing(input).processingFeeCents).toBe(62);
    input.processing.chargeAmountsCents = [102];
    expect(evaluatePricing(input).processingFeeCents).toBe(31);
    input.processing.chargeAmountsCents = [100];
    expect(() => evaluatePricing(input)).toThrow(PricingValidationError);
  });

  it("supports a separately specified paid portion and explicit fee credits", () => {
    const input = fixture();
    input.processing = {
      rateBps: 300,
      fixedCents: 30,
      basis: "explicit",
      explicitBaseCents: 1000,
    };
    expect(evaluatePricing(input)).toMatchObject({
      processingBaseCents: 1000,
      processingFeeCents: 60,
    });
    input.adjustments = { processingFeeCreditCents: 61 };
    expect(() => evaluatePricing(input)).toThrow(PricingValidationError);
  });

  it.each(["self_pay", "insurance"] as const)(
    "reconciles allocated %s revenue, refunds, recoveries, costs and overhead exactly",
    (mode) => {
      const input = fixture();
      input.lines = [
        ...input.lines,
        {
          ...input.lines[0],
          id: "tube",
          sku: "TUBE",
          unitPriceCents: 1901,
          unitCostCents: 700,
          quantity: 3,
        },
      ];
      input.revenue =
        mode === "self_pay"
          ? { mode, shippingChargedCents: 599, discountCents: 133 }
          : { mode, expectedCollectibleCents: 14703, status: "verified" };
      input.adjustments = {
        expectedRefundCents: 997,
        recoveryCents: 431,
        overheadCents: 1237,
        riskCostCents: 43,
        returnCostCents: 171,
      };
      input.policy.basis = "after_overhead";
      const result = evaluatePricing(input);
      expect(
        result.lines.reduce((sum, line) => sum + line.netRevenueCents!, 0),
      ).toBe(result.netRevenueCents);
      expect(
        result.lines.reduce(
          (sum, line) => sum + line.allocatedRecoveryCents,
          0,
        ),
      ).toBe(result.recoveryCents);
      expect(
        result.lines.reduce(
          (sum, line) => sum + line.allocatedOverheadCents,
          0,
        ),
      ).toBe(result.overheadCents);
      expect(
        result.lines.reduce((sum, line) => sum + line.contributionCents!, 0),
      ).toBe(result.contributionCents);
      expect(
        result.lines.reduce(
          (sum, line) => sum + line.profitAfterOverheadCents!,
          0,
        ),
      ).toBe(result.profitAfterOverheadCents);
    },
  );
});

describe("policy and recommendation safety", () => {
  it("distinguishes target approval from hard-floor and minimum-dollar blocks", () => {
    expect(evaluatePricing(setPrice(fixture(), 9000)).state).toBe(
      "approval_needed",
    );
    expect(evaluatePricing(setPrice(fixture(), 7000)).state).toBe("blocked");
    const input = fixture();
    input.policy.minimumContributionCents = 4000;
    expect(evaluatePricing(input)).toMatchObject({
      meetsTarget: true,
      meetsMinimumContribution: false,
      state: "blocked",
    });
    expect(recommendPricing(input).evaluation.meetsMinimumContribution).toBe(
      true,
    );
  });

  it("requires an explicit item for a basket recommendation and preserves all other lines", () => {
    const input = fixture();
    input.lines = [
      ...input.lines,
      {
        ...input.lines[0],
        id: "second",
        sku: "SECOND",
        unitCostCents: 1000,
        unitPriceCents: 2000,
        quantity: 2,
      },
    ];
    expect(recommendPricing(input).status).toBe("selection_required");
    const before = JSON.stringify(input);
    const recommendation = recommendPricing(input, "mask");
    expect(recommendation.status).toBe("recommended");
    expect(recommendation.recommendedInput!.lines[1]).toEqual(input.lines[1]);
    expect(recommendation.evaluation.meetsTarget).toBe(true);
    expect(JSON.stringify(input)).toBe(before);
  });

  it("honors unit-price endings and ceilings after exact evaluation", () => {
    const input = fixture();
    input.policy.priceIncrementCents = 100;
    input.policy.priceEndingCents = 99;
    expect(recommendPricing(input).recommendedUnitPriceCents).toBe(9599);
    input.policy.priceCeilingCents = 9550;
    expect(recommendPricing(input).status).toBe("ceiling_exceeded");
  });

  it("enforces an optional allocated line floor while preserving explicit bundle subsidies", () => {
    const input = fixture();
    input.processing = null;
    input.costs = [];
    input.lines = [
      { ...input.lines[0], unitPriceCents: 10000, unitCostCents: 1000 },
      {
        ...input.lines[0],
        id: "tube",
        sku: "TUBE",
        unitPriceCents: 1000,
        unitCostCents: 1500,
      },
    ];
    expect(evaluatePricing(input)).toMatchObject({
      state: "meets_target",
      meetsLineFloors: true,
    });
    input.policy.lineFloorMarginBps = 0;
    const result = evaluatePricing(input);
    expect(result).toMatchObject({
      state: "blocked",
      meetsTarget: true,
      meetsLineFloors: false,
    });
    expect(result.lines.map((line) => line.meetsFloor)).toEqual([true, false]);
    expect(result.issues).toContainEqual(
      expect.objectContaining({ code: "below_line_floor" }),
    );
  });

  it("retains actual capture amounts and reports when they must be revised before repricing", () => {
    const input = fixture();
    input.processing = { ...input.processing!, chargeAmountsCents: [9527] };
    expect(recommendPricing(input)).toMatchObject({
      status: "recommended",
      recommendedUnitPriceCents: 9527,
    });
    input.policy.targetMarginBps = 4500;
    expect(recommendPricing(input)).toMatchObject({
      status: "fixed_capture_amounts",
      recommendedInput: null,
    });
    expect(input.processing.chargeAmountsCents).toEqual([9527]);
    input.processing = {
      ...input.processing,
      basis: "explicit",
      explicitBaseCents: 9527,
    };
    expect(recommendPricing(input).status).toBe("recommended");
  });

  it("finds a qualifying recovery-and-line-floor band skipped by exponential probes", () => {
    const input = fixture();
    input.processing = null;
    input.costs = [];
    input.lines = [
      { ...input.lines[0], unitPriceCents: 1000, unitCostCents: 1200 },
      {
        ...input.lines[0],
        id: "tube",
        sku: "TUBE",
        unitPriceCents: 1000,
        unitCostCents: 1100,
      },
    ];
    input.adjustments = { recoveryCents: 800 };
    input.policy.lineFloorMarginBps = 2000;
    // The order passes from1500 cents; the tube needs at least300 allocated
    // recovery cents, creating an upper bound near1666 (with penny rounding).
    for (const price of [1024, 2048]) {
      const tested = {
        ...input,
        lines: input.lines.map((line) =>
          line.id === "mask" ? { ...line, unitPriceCents: price } : line,
        ),
      };
      expect(evaluatePricing(tested).state).not.toBe("meets_target");
    }
    const recommendation = recommendPricing(input, "mask");
    expect(recommendation.status).toBe("recommended");
    expect(recommendation.recommendedUnitPriceCents).toBeGreaterThanOrEqual(
      1500,
    );
    expect(recommendation.recommendedUnitPriceCents).toBeLessThanOrEqual(1670);
    expect(recommendation.evaluation).toMatchObject({
      state: "meets_target",
      meetsLineFloors: true,
    });
  });

  it("does not claim a finite qualifying price when fees exceed the available margin", () => {
    const input = fixture();
    input.policy.targetMarginBps = 9900;
    expect(recommendPricing(input)).toMatchObject({
      status: "no_qualifying_price",
      recommendedInput: null,
    });
  });

  it("gives zero revenue no margin and retains negative contribution", () => {
    const input = setPrice(fixture(), 0);
    expect(evaluatePricing(input)).toMatchObject({
      netRevenueCents: 0,
      contributionMarginBps: null,
      contributionCents: -5430,
      state: "blocked",
    });
  });

  it.each([NaN, Infinity, -1, 1.5, Number.MAX_SAFE_INTEGER])(
    "rejects invalid cents %s without clamping",
    (value) => {
      expect(() => evaluatePricing(setPrice(fixture(), value))).toThrow(
        PricingValidationError,
      );
    },
  );

  it("rejects invalid currency, quantities, percentages and overflow", () => {
    expect(() =>
      evaluatePricing({
        ...fixture(),
        currency: "EUR",
      } as unknown as PricingInput),
    ).toThrow(PricingValidationError);
    for (const quantity of [0, -1, 1.5, Infinity]) {
      const input = fixture();
      input.lines = input.lines.map((line) => ({ ...line, quantity }));
      expect(() => evaluatePricing(input)).toThrow(PricingValidationError);
    }
    const input = fixture();
    input.policy.floorMarginBps = 5000;
    expect(() => evaluatePricing(input)).toThrow(PricingValidationError);
    input.policy.floorMarginBps = 3000;
    input.lines = input.lines.map((line) => ({
      ...line,
      unitPriceCents: PRICING_MAX_CENTS,
      quantity: 2,
    }));
    expect(() => evaluatePricing(input)).toThrow(PricingValidationError);
  });

  it("checks price endings, over-discounts, over-refunds and snapshot timestamp", () => {
    const input = fixture();
    input.policy.priceEndingCents = 1;
    expect(() => evaluatePricing(input)).toThrow(PricingValidationError);
    input.policy.priceEndingCents = 0;
    input.revenue = {
      mode: "self_pay",
      shippingChargedCents: 0,
      discountCents: 10000,
    };
    expect(() => evaluatePricing(input)).toThrow(PricingValidationError);
    input.revenue = { mode: "self_pay", shippingChargedCents: 0 };
    input.adjustments = { expectedRefundCents: 10000 };
    expect(() => evaluatePricing(input)).toThrow(PricingValidationError);
    input.adjustments = {};
    input.evaluatedAt = "2026-09-14";
    expect(() => evaluatePricing(input)).toThrow(PricingValidationError);
  });

  it("rejects calendar rollover instead of silently extending a cost validity date", () => {
    const input = fixture();
    input.lines = input.lines.map((line) => ({
      ...line,
      costExpiresAt: "2027-02-29T00:00:00Z",
    }));
    expect(() => evaluatePricing(input)).toThrow(PricingValidationError);
    input.lines = input.lines.map((line) => ({
      ...line,
      costExpiresAt: "2028-02-29T00:00:00-05:00",
    }));
    expect(evaluatePricing(input).costsComplete).toBe(true);
  });
});
