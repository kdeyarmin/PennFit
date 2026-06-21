import { describe, it, expect } from "vitest";

import { parsePeriodRange, computeGoalPace } from "./goal-pace";

describe("parsePeriodRange", () => {
  it("parses a calendar month into [first, first-of-next-month)", () => {
    expect(parsePeriodRange("2026-05")).toEqual({
      startDate: "2026-05-01",
      endExclusiveDate: "2026-06-01",
    });
  });

  it("rolls a December month into the next year", () => {
    expect(parsePeriodRange("2026-12")).toEqual({
      startDate: "2026-12-01",
      endExclusiveDate: "2027-01-01",
    });
  });

  it("parses a calendar year", () => {
    expect(parsePeriodRange("2026")).toEqual({
      startDate: "2026-01-01",
      endExclusiveDate: "2027-01-01",
    });
  });

  it("parses a calendar quarter into its 3-month UTC range", () => {
    expect(parsePeriodRange("2026-Q1")).toEqual({
      startDate: "2026-01-01",
      endExclusiveDate: "2026-04-01",
    });
    expect(parsePeriodRange("2026-Q2")).toEqual({
      startDate: "2026-04-01",
      endExclusiveDate: "2026-07-01",
    });
    expect(parsePeriodRange("2026-Q3")).toEqual({
      startDate: "2026-07-01",
      endExclusiveDate: "2026-10-01",
    });
    // Q4 rolls the exclusive end into the next January.
    expect(parsePeriodRange("2026-Q4")).toEqual({
      startDate: "2026-10-01",
      endExclusiveDate: "2027-01-01",
    });
  });

  it("returns null for an out-of-range quarter (Q0, Q5)", () => {
    expect(parsePeriodRange("2026-Q5")).toBeNull();
    expect(parsePeriodRange("2026-Q0")).toBeNull();
  });

  it("returns null for an invalid month or free-text period", () => {
    expect(parsePeriodRange("2026-13")).toBeNull();
    expect(parsePeriodRange("fy2026")).toBeNull();
  });
});

describe("computeGoalPace", () => {
  // 30-day period (April 2026). Target 30000 → 1000/day expected.
  const range = { startDate: "2026-04-01", endExclusiveDate: "2026-05-01" };

  it("flags 'on_track' when actual matches the linear expectation", () => {
    // 15 days elapsed → expected 15000; actual 15000 → pace 1.0.
    const r = computeGoalPace({
      targetValue: 30000,
      ...range,
      actualToDate: 15000,
      asOf: "2026-04-16T00:00:00Z",
    });
    expect(r.daysInPeriod).toBe(30);
    expect(r.daysElapsed).toBe(15);
    expect(r.expectedToDate).toBe(15000);
    expect(r.paceRatio).toBeCloseTo(1.0, 5);
    expect(r.attainmentRatio).toBeCloseTo(0.5, 5);
    expect(r.projectedValue).toBeCloseTo(30000, 5);
    expect(r.status).toBe("on_track");
  });

  it("flags 'behind' when the run-rate trails the track", () => {
    // 15 days elapsed, expected 15000, actual 9000 → pace 0.6.
    const r = computeGoalPace({
      targetValue: 30000,
      ...range,
      actualToDate: 9000,
      asOf: "2026-04-16T00:00:00Z",
    });
    expect(r.paceRatio).toBeCloseTo(0.6, 5);
    expect(r.projectedValue).toBeCloseTo(18000, 5);
    expect(r.status).toBe("behind");
  });

  it("flags 'ahead' when the run-rate exceeds the track", () => {
    const r = computeGoalPace({
      targetValue: 30000,
      ...range,
      actualToDate: 21000, // expected 15000 → pace 1.4
      asOf: "2026-04-16T00:00:00Z",
    });
    expect(r.status).toBe("ahead");
    expect(r.projectedValue).toBeCloseTo(42000, 5);
  });

  it("is 'unknown' before the period starts (no days elapsed)", () => {
    const r = computeGoalPace({
      targetValue: 30000,
      ...range,
      actualToDate: 0,
      asOf: "2026-03-15T00:00:00Z",
    });
    expect(r.daysElapsed).toBe(0);
    expect(r.paceRatio).toBeNull();
    expect(r.status).toBe("unknown");
  });

  it("caps elapsed at the period length after it ends", () => {
    const r = computeGoalPace({
      targetValue: 30000,
      ...range,
      actualToDate: 30000,
      asOf: "2026-06-01T00:00:00Z",
    });
    expect(r.daysElapsed).toBe(30);
    expect(r.expectedToDate).toBe(30000);
    expect(r.attainmentRatio).toBeCloseTo(1.0, 5);
    expect(r.status).toBe("on_track");
  });

  it("returns unknown for an inverted / unparseable window", () => {
    const r = computeGoalPace({
      targetValue: 100,
      startDate: "2026-05-01",
      endExclusiveDate: "2026-05-01",
      actualToDate: 50,
    });
    expect(r.status).toBe("unknown");
    expect(r.attainmentRatio).toBeCloseTo(0.5, 5);
    // No days elapsed → nothing to trust.
    expect(r.projectionConfidence).toBe("low");
  });

  describe("projectionConfidence bands", () => {
    it("is 'low' early in the period (< 20% elapsed)", () => {
      // 3 of 30 days elapsed = 10% → low. The run-rate explodes here:
      // actual 3000 over 3 days projects 30000 for the month.
      const r = computeGoalPace({
        targetValue: 30000,
        ...range,
        actualToDate: 3000,
        asOf: "2026-04-04T00:00:00Z",
      });
      expect(r.daysElapsed).toBe(3);
      expect(r.projectionConfidence).toBe("low");
      expect(r.projectedValue).toBeCloseTo(30000, 5);
    });

    it("is 'medium' between 20% and 50% elapsed", () => {
      // 9 of 30 days = 30% → medium.
      const r = computeGoalPace({
        targetValue: 30000,
        ...range,
        actualToDate: 9000,
        asOf: "2026-04-10T00:00:00Z",
      });
      expect(r.daysElapsed).toBe(9);
      expect(r.projectionConfidence).toBe("medium");
    });

    it("is 'high' at or past 50% elapsed", () => {
      // 15 of 30 days = 50% → high.
      const r = computeGoalPace({
        targetValue: 30000,
        ...range,
        actualToDate: 15000,
        asOf: "2026-04-16T00:00:00Z",
      });
      expect(r.daysElapsed).toBe(15);
      expect(r.projectionConfidence).toBe("high");
    });
  });

  it("clamps a negative target/actual to 0 so the band stays meaningful", () => {
    // A negative target would sign-flip paceRatio; clamp keeps magnitudes ≥ 0.
    const r = computeGoalPace({
      targetValue: -30000,
      ...range,
      actualToDate: -5000,
      asOf: "2026-04-16T00:00:00Z",
    });
    expect(r.actualToDate).toBe(0);
    // Clamped target → expectedToDate 0 → paceRatio null → status unknown.
    expect(r.expectedToDate).toBe(0);
    expect(r.paceRatio).toBeNull();
    expect(r.attainmentRatio).toBeNull();
    expect(r.status).toBe("unknown");
  });
});
