import { describe, it, expect } from "vitest";

import { evaluateThreshold, breachPersists } from "./metric-threshold";

describe("evaluateThreshold — absolute", () => {
  it("breaches when the value crosses a gt threshold", () => {
    const r = evaluateThreshold(
      { comparison: "gt", thresholdValue: 100, mode: "absolute" },
      150,
    );
    expect(r.breached).toBe(true);
    expect(r.comparedValue).toBe(150);
  });

  it("does not breach when within a gt threshold", () => {
    const r = evaluateThreshold(
      { comparison: "gt", thresholdValue: 100, mode: "absolute" },
      80,
    );
    expect(r.breached).toBe(false);
  });

  it("respects gte / lte boundary equality", () => {
    expect(
      evaluateThreshold(
        { comparison: "gte", thresholdValue: 100, mode: "absolute" },
        100,
      ).breached,
    ).toBe(true);
    expect(
      evaluateThreshold(
        { comparison: "gt", thresholdValue: 100, mode: "absolute" },
        100,
      ).breached,
    ).toBe(false);
    expect(
      evaluateThreshold(
        { comparison: "lte", thresholdValue: 4, mode: "absolute" },
        4,
      ).breached,
    ).toBe(true);
  });

  it("surfaces a non-finite (NaN) current value explicitly, not silently", () => {
    const r = evaluateThreshold(
      { comparison: "gt", thresholdValue: 100, mode: "absolute" },
      Number.NaN,
    );
    expect(r.breached).toBe(false);
    expect(r.comparedValue).toBeNull();
    expect(r.reason).toMatch(/not finite/i);
  });

  it("surfaces a non-finite (Infinity) current value explicitly", () => {
    const r = evaluateThreshold(
      { comparison: "gt", thresholdValue: 100, mode: "absolute" },
      Number.POSITIVE_INFINITY,
    );
    expect(r.breached).toBe(false);
    expect(r.comparedValue).toBeNull();
    expect(r.reason).toMatch(/not finite/i);
  });
});

describe("evaluateThreshold — delta_7d", () => {
  it("breaches on a week-over-week point jump (denial rate +5pts)", () => {
    // 12% denial this week vs 6% last week = +6 points, > 5.
    const r = evaluateThreshold(
      { comparison: "gt", thresholdValue: 5, mode: "delta_7d" },
      12,
      6,
    );
    expect(r.breached).toBe(true);
    expect(r.comparedValue).toBe(6);
  });

  it("does not breach when the delta is under the threshold", () => {
    const r = evaluateThreshold(
      { comparison: "gt", thresholdValue: 5, mode: "delta_7d" },
      9,
      6,
    );
    expect(r.breached).toBe(false);
    expect(r.comparedValue).toBe(3);
  });

  it("does not breach (and reports) when the baseline is missing", () => {
    const r = evaluateThreshold(
      { comparison: "gt", thresholdValue: 5, mode: "delta_7d" },
      12,
      null,
    );
    expect(r.breached).toBe(false);
    expect(r.comparedValue).toBeNull();
    expect(r.reason).toMatch(/no baseline/i);
  });
});

describe("evaluateThreshold — delta_pct_7d", () => {
  it("breaches on a large week-over-week percent drop", () => {
    // revenue 8000 vs 10000 last week = −20%; rule fires when < −15%.
    const r = evaluateThreshold(
      { comparison: "lt", thresholdValue: -15, mode: "delta_pct_7d" },
      8000,
      10000,
    );
    expect(r.breached).toBe(true);
    expect(r.comparedValue).toBeCloseTo(-20, 6);
  });

  it("does not breach on a small percent change", () => {
    const r = evaluateThreshold(
      { comparison: "lt", thresholdValue: -15, mode: "delta_pct_7d" },
      9500,
      10000,
    );
    expect(r.breached).toBe(false);
    expect(r.comparedValue).toBeCloseTo(-5, 6);
  });

  it("does not breach when the baseline is zero (undefined percent)", () => {
    const r = evaluateThreshold(
      { comparison: "gt", thresholdValue: 10, mode: "delta_pct_7d" },
      500,
      0,
    );
    expect(r.breached).toBe(false);
    expect(r.comparedValue).toBeNull();
    expect(r.reason).toMatch(/zero/i);
  });

  it("uses the baseline MAGNITUDE so a negative baseline keeps an intuitive sign", () => {
    // Baseline −100 → current −80 is a raw +20 move; dividing by |−100|
    // gives +20% ("got 20% less negative"), NOT −20%.
    const r = evaluateThreshold(
      { comparison: "gt", thresholdValue: 10, mode: "delta_pct_7d" },
      -80,
      -100,
    );
    expect(r.comparedValue).toBeCloseTo(20, 6);
    expect(r.breached).toBe(true);
  });

  it("reports a negative percent when a negative baseline moves further down", () => {
    // Baseline −100 → current −150 is a raw −50 move; / |−100| = −50%.
    const r = evaluateThreshold(
      { comparison: "lt", thresholdValue: -25, mode: "delta_pct_7d" },
      -150,
      -100,
    );
    expect(r.comparedValue).toBeCloseTo(-50, 6);
    expect(r.breached).toBe(true);
  });
});

describe("breachPersists", () => {
  it("returns true when the most recent N entries are all true", () => {
    expect(breachPersists([false, true, true, true], 3)).toBe(true);
  });

  it("returns false on a trailing false even if earlier entries are true", () => {
    expect(breachPersists([true, true, true, false], 3)).toBe(false);
  });

  it("returns false when history is shorter than minConsecutive", () => {
    expect(breachPersists([true, true], 3)).toBe(false);
  });

  it("returns false for an empty history", () => {
    expect(breachPersists([], 1)).toBe(false);
  });

  it("returns true when the whole history is true and exactly long enough", () => {
    expect(breachPersists([true, true, true], 3)).toBe(true);
  });

  it("only inspects the tail, ignoring older falses", () => {
    expect(breachPersists([false, false, true, true], 2)).toBe(true);
  });

  it("treats a non-positive minConsecutive as 1 (at least one breach)", () => {
    expect(breachPersists([false, false, true], 0)).toBe(true);
    expect(breachPersists([false, false, true], -5)).toBe(true);
    expect(breachPersists([false, false, false], 0)).toBe(false);
  });

  it("treats a non-finite minConsecutive as 1", () => {
    expect(breachPersists([true], Number.NaN)).toBe(true);
    expect(breachPersists([false], Number.NaN)).toBe(false);
  });
});
