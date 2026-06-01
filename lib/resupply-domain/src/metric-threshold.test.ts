import { describe, it, expect } from "vitest";

import { evaluateThreshold } from "./metric-threshold";

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
});
