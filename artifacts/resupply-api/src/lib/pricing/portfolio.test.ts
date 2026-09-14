import { describe, expect, it } from "vitest";
import { evaluatePricing, type PricingInput } from "@workspace/resupply-domain";
import { comparePublishedPrices } from "./portfolio";
import { proposalDto } from "./service";
import type { PriceBatch, ResolvedScenario, Scenario } from "./contracts";
const input: PricingInput = {
  currency: "USD",
  evaluatedAt: "2026-09-14T12:00:00Z",
  lines: [
    {
      id: "a",
      sku: "MASK",
      quantity: 2,
      unitPriceCents: 10000,
      unitCostCents: 3000,
      costStatus: "verified",
    },
  ],
  costs: [
    {
      id: "freight",
      label: "Current freight",
      category: "freight",
      basis: "order",
      quantity: 1,
      amountCents: 1000,
      status: "verified",
    },
  ],
  revenue: { mode: "self_pay", shippingChargedCents: 500 },
  policy: {
    targetMarginBps: 4000,
    floorMarginBps: 2000,
    basis: "contribution",
  },
};
function resolved(overrides: Partial<PricingInput> = {}): ResolvedScenario {
  const current = { ...structuredClone(input), ...overrides };
  return {
    input: current,
    evaluation: evaluatePricing(current),
    dependencies: [],
    policyId: "policy",
    policyVersion: 2,
    scenario: {
      lines: current.lines.map((line) => ({
        ...line,
        unitAmountCents: line.unitPriceCents,
      })),
      revenue: current.revenue,
    } as unknown as Scenario,
  };
}
function batch(price = 8000, quantity = 2): PriceBatch {
  const historical = resolved();
  historical.scenario.lines[0].unitAmountCents = price;
  historical.scenario.lines[0].quantity = quantity;
  // Historical economics deliberately differ; comparison must not reuse them.
  historical.input.lines[0].unitCostCents = 100;
  return { id: "prior-list", entries: [historical] } as PriceBatch;
}
describe("frozen previous-price comparisons", () => {
  it("changes only previous unit amounts under identical current assumptions", () => {
    const proposed = resolved();
    const previous = batch();
    const frozen = structuredClone(proposed);
    const result = comparePublishedPrices(proposed, previous);
    expect(result).toMatchObject({
      status: "comparable",
      previousPriceListId: "prior-list",
      previousEntryIndexes: [0],
      previousUnitAmounts: [
        { sku: "MASK", quantity: 2, unitAmountCents: 8000 },
      ],
      previousEvaluation: {
        netRevenueCents: 16500,
        deliveredCostCents: 7000,
        contributionCents: 9500,
      },
    });
    expect(result.previousInput).toEqual({
      ...proposed.input,
      lines: [{ ...proposed.input.lines[0], unitPriceCents: 8000 }],
    });
    expect(proposed).toEqual(frozen);
  });
  it("does not invent a price when no exact quantity context exists or modes differ", () => {
    expect(comparePublishedPrices(resolved(), batch(8000, 1)).status).toBe(
      "no_published_price",
    );
    const previous = batch();
    previous.entries[0].scenario.revenue = {
      mode: "insurance",
      expectedCollectibleCents: 5000,
      status: "verified",
    };
    expect(
      comparePublishedPrices(resolved(), previous).previousEvaluation,
    ).toBeNull();
  });
  it("rejects conflicting matching published prices", () => {
    const previous = batch();
    previous.entries.push(batch(9000).entries[0]);
    expect(comparePublishedPrices(resolved(), previous)).toMatchObject({
      status: "ambiguous_published_price",
      previousEvaluation: null,
    });
  });
  it("preserves expected insurance collections instead of double-counting billed changes", () => {
    const insurance = {
      mode: "insurance" as const,
      expectedCollectibleCents: 12000,
      status: "verified" as const,
    };
    const proposed = resolved({ revenue: insurance });
    const previous = batch();
    previous.entries[0].scenario.revenue = insurance;
    expect(
      comparePublishedPrices(proposed, previous).previousEvaluation
        ?.netRevenueCents,
    ).toBe(12000);
  });
  it("reports incompatible fixed captures without fabricating a margin", () => {
    const proposed = resolved({
      processing: {
        basis: "customer_total",
        rateBps: 290,
        fixedCents: 30,
        chargeAmountsCents: [20500],
      },
    });
    expect(comparePublishedPrices(proposed, batch())).toMatchObject({
      status: "comparison_unavailable",
      previousEvaluation: null,
      reason: "previous_amounts_incompatible_with_current_assumptions",
    });
  });
});
it("re-derives proposal expiry from durable evidence without altering its repeatable payload", () => {
  const payload = {
    comparison: {
      currency: "USD",
      quantity: 1,
      destination: "19000",
      service: "Ground",
      suppliers: [
        {
          id: "one",
          supplierName: "One",
          source: "Synthetic quote",
          expiresAt: "2026-09-15T00:00:00Z",
          packCostCents: 500,
          unitsPerPack: 1,
          minimumPacks: 1,
          availability: "available",
          leadTimeDays: 1,
          terms: "Synthetic",
          fees: [
            "inbound",
            "dropship",
            "freight",
            "handling",
            "packaging",
            "other",
          ].map((category) => ({
            id: category,
            label: category,
            category,
            amountCents: 0,
            basis: "order",
            count: 1,
          })),
        },
      ],
    },
  };
  const row = { id: "candidate", data: payload } as unknown as Parameters<
    typeof proposalDto
  >[0];
  const frozen = structuredClone(row);
  expect(
    proposalDto(row, new Date("2026-09-14T00:00:00Z")).comparisonResult
      ?.suppliers[0],
  ).toMatchObject({ status: "estimated", deliveredCostCents: 500 });
  expect(
    proposalDto(row, new Date("2026-09-15T00:00:00Z")).comparisonResult
      ?.suppliers[0],
  ).toMatchObject({
    status: "expired",
    deliveredCostCents: null,
    knownDeliveredCostCents: 500,
  });
  expect(row).toEqual(frozen);
});
