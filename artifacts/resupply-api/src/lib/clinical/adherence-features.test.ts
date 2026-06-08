import { describe, it, expect } from "vitest";

import {
  buildTrainingSamples,
  extractAdherenceFeatures,
  FEATURE_NAMES,
  labelCompliant,
  toFeatureVector,
  type TherapyNightInput,
} from "./adherence-features";

function dayIso(i: number): string {
  const d = new Date(Date.UTC(2026, 0, 1));
  d.setUTCDate(d.getUTCDate() + i);
  return d.toISOString().slice(0, 10);
}
function nights(
  count: number,
  usageMinutes: number,
  leakLMin = 10,
  startDay = 0,
): TherapyNightInput[] {
  return Array.from({ length: count }, (_, i) => ({
    nightDate: dayIso(startDay + i),
    usageMinutes,
    leakLMin,
  }));
}

describe("extractAdherenceFeatures", () => {
  it("computes week-1 usage / compliance / coverage and the week-2 trend", () => {
    const f = extractAdherenceFeatures([
      ...nights(7, 300, 10, 0), // week 1: 5h/night, compliant, low leak
      ...nights(7, 120, 30, 7), // week 2: 2h/night, non-compliant, high leak
    ]);
    expect(f.week1AvgUsageHours).toBe(5);
    expect(f.week1CompliantRate).toBe(1);
    expect(f.week1HighLeakRate).toBe(0);
    expect(f.week1Coverage).toBe(1);
    expect(f.week2AvgUsageHours).toBe(2);
    expect(f.usageTrendHours).toBe(-3);
  });

  it("returns all-zero features for no nights", () => {
    const f = extractAdherenceFeatures([]);
    expect(toFeatureVector(f)).toEqual([0, 0, 0, 0, 0, 0]);
    expect(FEATURE_NAMES).toHaveLength(6);
  });
});

describe("labelCompliant", () => {
  it("is 1 when ≥21 compliant nights fall in a 30-day window", () => {
    expect(labelCompliant(nights(21, 300))).toBe(1);
  });
  it("is 0 with only 20 compliant nights", () => {
    expect(labelCompliant(nights(20, 300))).toBe(0);
  });
  it("is 0 when compliant nights are spread beyond any 30-day window", () => {
    // 21 compliant nights but one every 5 days → spans 100 days, never 21-in-30.
    const spread: TherapyNightInput[] = Array.from({ length: 21 }, (_, i) => ({
      nightDate: dayIso(i * 5),
      usageMinutes: 300,
      leakLMin: 10,
    }));
    expect(labelCompliant(spread)).toBe(0);
  });
});

describe("buildTrainingSamples", () => {
  it("skips patients with too few nights and labels the rest", () => {
    const samples = buildTrainingSamples([
      nights(21, 300), // compliant
      nights(10, 120), // not compliant, enough nights
      nights(3, 300), // too few → skipped
    ]);
    expect(samples).toHaveLength(2);
    expect(samples[0]!.y).toBe(1);
    expect(samples[1]!.y).toBe(0);
    expect(samples[0]!.x).toHaveLength(6);
  });
});
