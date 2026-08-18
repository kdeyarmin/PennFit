import { describe, expect, it } from "vitest";

import { buildFitRangeGeometry, mm } from "./fit-range-diagram";

const base = { label: "Nose width", min: 30, max: 40 };

describe("buildFitRangeGeometry", () => {
  it("places a mid-range measurement inside the band", () => {
    const g = buildFitRangeGeometry({ ...base, value: 35 })!;
    expect(g.inRange).toBe(true);
    expect(g.markerPct).toBeGreaterThan(g.bandStartPct);
    expect(g.markerPct).toBeLessThan(g.bandStartPct + g.bandWidthPct);
  });

  it("treats a measurement exactly on the boundary as a fit", () => {
    // The published ranges are themselves rounded; calling the endpoint a
    // miss would invent precision the data doesn't have.
    expect(buildFitRangeGeometry({ ...base, value: 30 })!.inRange).toBe(true);
    expect(buildFitRangeGeometry({ ...base, value: 40 })!.inRange).toBe(true);
  });

  it("keeps an out-of-range measurement visible and off the edge", () => {
    // Pinned to 0% it would read as "on the line" rather than "outside",
    // which is the one thing this row exists to communicate.
    const g = buildFitRangeGeometry({ ...base, value: 22 })!;
    expect(g.inRange).toBe(false);
    expect(g.markerPct).toBeGreaterThan(0);
    expect(g.markerPct).toBeLessThan(g.bandStartPct);
  });

  it("keeps an over-range measurement inside the track too", () => {
    const g = buildFitRangeGeometry({ ...base, value: 55 })!;
    expect(g.inRange).toBe(false);
    expect(g.markerPct).toBeLessThan(100);
    expect(g.markerPct).toBeGreaterThan(g.bandStartPct + g.bandWidthPct);
  });

  it("survives a single-point range without dividing by zero", () => {
    const g = buildFitRangeGeometry({
      label: "x",
      min: 30,
      max: 30,
      value: 30,
    });
    expect(g).not.toBeNull();
    expect(g!.inRange).toBe(true);
    expect(Number.isFinite(g!.markerPct)).toBe(true);
  });

  it("refuses to draw an inverted range", () => {
    // A min above max is bad data; drawing it would render a negative
    // band that silently reads as "no range".
    expect(
      buildFitRangeGeometry({ label: "x", min: 40, max: 30, value: 35 }),
    ).toBeNull();
  });

  it("refuses to draw non-finite inputs", () => {
    expect(buildFitRangeGeometry({ ...base, value: Number.NaN })).toBeNull();
    expect(
      buildFitRangeGeometry({ label: "x", min: 0, max: Infinity, value: 5 }),
    ).toBeNull();
  });

  it("keeps every geometry value within the track", () => {
    for (const value of [1, 29, 35, 41, 500]) {
      const g = buildFitRangeGeometry({ ...base, value })!;
      expect(g.markerPct).toBeGreaterThanOrEqual(0);
      expect(g.markerPct).toBeLessThanOrEqual(100);
      expect(g.bandStartPct).toBeGreaterThanOrEqual(0);
      expect(g.bandStartPct + g.bandWidthPct).toBeLessThanOrEqual(100);
    }
  });
});

describe("mm", () => {
  it("rounds rather than implying sub-millimetre precision", () => {
    expect(mm(34.4)).toBe("34 mm");
    expect(mm(34.6)).toBe("35 mm");
  });
});
