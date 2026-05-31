// Tests for the pure sparkline geometry (buildSparkline).

import { describe, it, expect } from "vitest";

import { buildSparkline } from "./Sparkline";

describe("buildSparkline", () => {
  it("maps an ascending series to one segment, higher values plotting higher (smaller y)", () => {
    const geo = buildSparkline([1, 2, 3], 30, 10);
    expect(geo.min).toBe(1);
    expect(geo.max).toBe(3);
    expect(geo.sampleCount).toBe(3);
    expect(geo.segments).toHaveLength(1);
    const pts = geo.segments[0]!;
    // x spans 0 → width across (n-1) gaps.
    expect(pts.map((p) => p.x)).toEqual([0, 15, 30]);
    // y is inverted: min → bottom (height), max → top (0), mid → height/2.
    expect(pts.map((p) => p.y)).toEqual([10, 5, 0]);
    // last point is the newest sample.
    expect(geo.last).toEqual({ x: 30, y: 0 });
  });

  it("plots a flat series along the vertical midline", () => {
    const geo = buildSparkline([4, 4, 4], 20, 10);
    expect(geo.min).toBe(4);
    expect(geo.max).toBe(4);
    expect(geo.segments[0]!.every((p) => p.y === 5)).toBe(true);
  });

  it("breaks the line into separate segments across a null gap", () => {
    const geo = buildSparkline([1, null, 3, 4], 30, 10);
    expect(geo.sampleCount).toBe(3);
    // [1] then [3,4] → two segments.
    expect(geo.segments).toHaveLength(2);
    expect(geo.segments[0]).toHaveLength(1);
    expect(geo.segments[1]).toHaveLength(2);
    // last is the final non-null sample (value 4 → top).
    expect(geo.last).toEqual({ x: 30, y: 0 });
  });

  it("reports zero samples for an all-null / empty series", () => {
    expect(buildSparkline([], 10, 10).sampleCount).toBe(0);
    expect(buildSparkline([null, null], 10, 10).sampleCount).toBe(0);
    expect(buildSparkline([null, null], 10, 10).last).toBeNull();
  });
});
