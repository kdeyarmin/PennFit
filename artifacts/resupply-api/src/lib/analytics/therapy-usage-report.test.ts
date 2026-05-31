// Pure-function tests for the therapy-usage report aggregator.
//
// No DB — the route owns the Supabase read + the patient→bucket join;
// this pins the math (means, adherence rate, CMS-compliant patient
// count, distinct-patient dedup across buckets).

import { describe, it, expect } from "vitest";

import {
  aggregateTherapyUsageReport,
  type TherapyNightRow,
} from "./therapy-usage-report";

// Convenience builder: a night of `mins` usage for `patient` in bucket
// `key` (label defaults to the key).
function night(
  key: string,
  patient: string,
  mins: number | null,
  extra: Partial<TherapyNightRow> = {},
): TherapyNightRow {
  return {
    groupKey: key,
    groupLabel: extra.groupLabel ?? key,
    groupSublabel: extra.groupSublabel ?? null,
    patientId: patient,
    usageMinutes: mins,
    ahi: extra.ahi ?? null,
    leakRateLMin: extra.leakRateLMin ?? null,
  };
}

describe("aggregateTherapyUsageReport", () => {
  it("computes per-bucket usage, adherence, and CMS-compliant patients", () => {
    // Provider A: patient p1 has 5 nights (4 ≥4h → 80% ≥ 0.7 → compliant);
    // patient p2 has 2 nights (1 ≥4h → 50% < 0.7 → not compliant).
    const rows: TherapyNightRow[] = [
      night("provA", "p1", 300),
      night("provA", "p1", 360),
      night("provA", "p1", 240),
      night("provA", "p1", 480),
      night("provA", "p1", 60),
      night("provA", "p2", 300),
      night("provA", "p2", 120),
    ];

    const r = aggregateTherapyUsageReport("provider", rows);
    expect(r.groups).toHaveLength(1);
    const g = r.groups[0]!;
    expect(g.patientCount).toBe(2);
    expect(g.nightsWithData).toBe(7);
    // (300+360+240+480+60+300+120)/7 = 1860/7 = 265.7 min → 4.4h
    expect(g.avgUsageHours).toBe(4.4);
    // 5 of 7 nights ≥ 240 min
    expect(g.adherentNightRate).toBeCloseTo(5 / 7, 4);
    expect(g.cmsCompliantPatients).toBe(1);
    expect(g.cmsComplianceRate).toBe(0.5);
  });

  it("treats null usage minutes as a non-adherent zero night", () => {
    const rows = [night("m", "p1", null), night("m", "p1", 300)];
    const r = aggregateTherapyUsageReport("manufacturer", rows);
    const g = r.groups[0]!;
    // avg usage only averages nights that reported minutes → 300 = 5.0h
    expect(g.avgUsageHours).toBe(5);
    // but adherence counts both nights → 1 of 2
    expect(g.adherentNightRate).toBe(0.5);
  });

  it("dedups a patient who appears under multiple buckets in the summary", () => {
    // p1 referred by two providers → appears in both buckets.
    const rows = [
      night("provA", "p1", 300),
      night("provB", "p1", 300),
    ];
    const r = aggregateTherapyUsageReport("provider", rows);
    expect(r.groups).toHaveLength(2);
    expect(r.groups.every((g) => g.patientCount === 1)).toBe(true);
    // Summary dedups: still one distinct patient overall.
    expect(r.summary.patientCount).toBe(1);
    expect(r.summary.nightsWithData).toBe(2);
    expect(r.summary.cmsCompliantPatients).toBe(1);
  });

  it("averages AHI and leak only over nights that reported them", () => {
    const rows = [
      night("m", "p1", 300, { ahi: 2, leakRateLMin: 10 }),
      night("m", "p1", 300, { ahi: 4, leakRateLMin: null }),
      night("m", "p1", 300),
    ];
    const r = aggregateTherapyUsageReport("manufacturer", rows);
    const g = r.groups[0]!;
    expect(g.avgAhi).toBe(3); // (2+4)/2
    expect(g.avgLeakRateLMin).toBe(10); // only one reported
  });

  it("sorts buckets by patient count desc then label asc", () => {
    const rows = [
      night("solo", "p1", 300, { groupLabel: "Zeta" }),
      night("big", "p2", 300, { groupLabel: "Alpha" }),
      night("big", "p3", 300, { groupLabel: "Alpha" }),
    ];
    const r = aggregateTherapyUsageReport("provider", rows);
    expect(r.groups.map((g) => g.key)).toEqual(["big", "solo"]);
  });

  it("returns null metrics and empty groups for no data", () => {
    const r = aggregateTherapyUsageReport("patient", []);
    expect(r.groups).toEqual([]);
    expect(r.summary.patientCount).toBe(0);
    expect(r.summary.avgUsageHours).toBeNull();
    expect(r.summary.adherentNightRate).toBeNull();
    expect(r.summary.cmsComplianceRate).toBeNull();
  });
});
