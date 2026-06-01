import { describe, it, expect } from "vitest";

import { computeMargin, aggregateMargin } from "./margin";

describe("computeMargin", () => {
  it("computes margin for a known cost", () => {
    const r = computeMargin({ revenueCents: 10000, unitCostCents: 4000 });
    expect(r.costKnown).toBe(true);
    expect(r.costCents).toBe(4000);
    expect(r.marginCents).toBe(6000);
    expect(r.marginRatio).toBeCloseTo(0.6, 10);
  });

  it("multiplies cost by quantity (revenue is already extended)", () => {
    const r = computeMargin({
      revenueCents: 30000,
      unitCostCents: 4000,
      quantity: 3,
    });
    expect(r.costCents).toBe(12000);
    expect(r.marginCents).toBe(18000);
  });

  it("treats a KNOWN zero cost as 100% margin (not unknown)", () => {
    const r = computeMargin({ revenueCents: 5000, unitCostCents: 0 });
    expect(r.costKnown).toBe(true);
    expect(r.costCents).toBe(0);
    expect(r.marginCents).toBe(5000);
    expect(r.marginRatio).toBe(1);
  });

  it("propagates UNKNOWN cost as null, never as zero", () => {
    const undef = computeMargin({ revenueCents: 5000 });
    expect(undef.costKnown).toBe(false);
    expect(undef.costCents).toBeNull();
    expect(undef.marginCents).toBeNull();
    expect(undef.marginRatio).toBeNull();

    const nul = computeMargin({ revenueCents: 5000, unitCostCents: null });
    expect(nul.costKnown).toBe(false);
    expect(nul.marginCents).toBeNull();
  });

  it("returns a null ratio (but a real margin) when revenue is 0", () => {
    const r = computeMargin({ revenueCents: 0, unitCostCents: 1000 });
    expect(r.marginCents).toBe(-1000);
    expect(r.marginRatio).toBeNull();
  });

  it("represents a loss as a negative margin and ratio", () => {
    const r = computeMargin({ revenueCents: 1000, unitCostCents: 1500 });
    expect(r.marginCents).toBe(-500);
    expect(r.marginRatio).toBeCloseTo(-0.5, 10);
  });

  it("clamps negative inputs and non-positive quantity defensively", () => {
    const r = computeMargin({
      revenueCents: -100,
      unitCostCents: -50,
      quantity: 0,
    });
    expect(r.revenueCents).toBe(0);
    expect(r.costCents).toBe(0); // quantity clamped to 1, cost clamped to 0
    expect(r.marginCents).toBe(0);
  });
});

describe("aggregateMargin", () => {
  it("keeps the known-cost / unknown-cost split explicit", () => {
    const agg = aggregateMargin([
      { revenueCents: 10000, unitCostCents: 4000 }, // costed
      { revenueCents: 5000, unitCostCents: 2000 }, // costed
      { revenueCents: 8000 }, // uncosted
    ]);
    expect(agg.lineCount).toBe(3);
    expect(agg.revenueCents).toBe(23000);
    expect(agg.costedRevenueCents).toBe(15000);
    expect(agg.uncostedRevenueCents).toBe(8000);
    expect(agg.costCents).toBe(6000);
    expect(agg.marginCents).toBe(9000);
    expect(agg.linesWithKnownCost).toBe(2);
    expect(agg.linesWithUnknownCost).toBe(1);
  });

  it("computes the ratio over COSTED revenue only", () => {
    // The uncosted $80 line must NOT dilute or inflate the headline %:
    // 9000 / 15000 = 0.60, not 9000 / 23000.
    const agg = aggregateMargin([
      { revenueCents: 10000, unitCostCents: 4000 },
      { revenueCents: 5000, unitCostCents: 2000 },
      { revenueCents: 8000 },
    ]);
    expect(agg.marginRatio).toBeCloseTo(0.6, 10);
  });

  it("returns a null ratio when nothing is costed", () => {
    const agg = aggregateMargin([
      { revenueCents: 8000 },
      { revenueCents: 2000 },
    ]);
    expect(agg.costedRevenueCents).toBe(0);
    expect(agg.marginRatio).toBeNull();
    expect(agg.uncostedRevenueCents).toBe(10000);
  });

  it("handles an empty list", () => {
    const agg = aggregateMargin([]);
    expect(agg.lineCount).toBe(0);
    expect(agg.revenueCents).toBe(0);
    expect(agg.marginRatio).toBeNull();
  });
});
