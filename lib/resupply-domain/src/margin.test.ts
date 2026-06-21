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
    expect(agg.lossLineCount).toBe(0);
    expect(agg.negativeMarginRevenueCents).toBe(0);
  });

  it("counts loss lines and the revenue sold below cost", () => {
    // Two profitable lines + one sold below cost. The loss line drags the
    // headline margin negative (5000 + (-2000) = 3000 margin on 17000?
    // no — see below), and is surfaced as a distinct "below cost" figure.
    const agg = aggregateMargin([
      { revenueCents: 10000, unitCostCents: 4000 }, // +6000 margin
      { revenueCents: 5000, unitCostCents: 2000 }, // +3000 margin
      { revenueCents: 1000, unitCostCents: 1500 }, // −500 loss line
    ]);
    expect(agg.lossLineCount).toBe(1);
    expect(agg.negativeMarginRevenueCents).toBe(1000);
    // Profitable here overall; loss line is still surfaced separately.
    expect(agg.costedRevenueCents).toBe(16000);
    expect(agg.costCents).toBe(7500);
    expect(agg.marginCents).toBe(8500);
    expect(agg.marginRatio).toBeCloseTo(8500 / 16000, 10);
  });

  it("lets the aggregate marginRatio go NEGATIVE when losses dominate", () => {
    // One small win, one big loss → total margin is negative, and the
    // ratio (over costed revenue) is below zero.
    const agg = aggregateMargin([
      { revenueCents: 1000, unitCostCents: 500 }, // +500
      { revenueCents: 2000, unitCostCents: 6000 }, // −4000 loss line
    ]);
    expect(agg.lossLineCount).toBe(1);
    expect(agg.negativeMarginRevenueCents).toBe(2000);
    expect(agg.costedRevenueCents).toBe(3000);
    expect(agg.costCents).toBe(6500);
    expect(agg.marginCents).toBe(-3500);
    expect(agg.marginRatio).toBeCloseTo(-3500 / 3000, 10);
    expect(agg.marginRatio).toBeLessThan(0);
  });

  it("never counts an UNCOSTED line as a loss line", () => {
    // An uncosted line's margin is unknown, not negative — it must not be
    // tallied into lossLineCount / negativeMarginRevenueCents.
    const agg = aggregateMargin([
      { revenueCents: 8000 }, // uncosted
      { revenueCents: 1000, unitCostCents: 1500 }, // costed loss
    ]);
    expect(agg.lossLineCount).toBe(1);
    expect(agg.negativeMarginRevenueCents).toBe(1000);
    expect(agg.uncostedRevenueCents).toBe(8000);
  });

  it("does not count a KNOWN break-even (zero margin) as a loss", () => {
    // marginCents === 0 is not < 0, so a break-even line is not a loss.
    const agg = aggregateMargin([
      { revenueCents: 5000, unitCostCents: 5000 }, // exactly break-even
    ]);
    expect(agg.lossLineCount).toBe(0);
    expect(agg.negativeMarginRevenueCents).toBe(0);
  });
});
