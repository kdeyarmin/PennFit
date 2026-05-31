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

  // ── Boundary: exactly 240 min (= CMS threshold) ────────────────────────────

  it("treats exactly 240 min as an adherent night (≥ threshold, not >)", () => {
    // One night at exactly 240 min should be adherent (CMS uses ≥4h).
    const rows = [night("m", "p1", 240)];
    const r = aggregateTherapyUsageReport("manufacturer", rows);
    const g = r.groups[0]!;
    expect(g.adherentNightRate).toBe(1);
    expect(g.cmsCompliantPatients).toBe(1); // 1/1 = 100% ≥ 70% → compliant
  });

  it("treats 239 min as a non-adherent night (< threshold)", () => {
    const rows = [night("m", "p1", 239)];
    const r = aggregateTherapyUsageReport("manufacturer", rows);
    const g = r.groups[0]!;
    expect(g.adherentNightRate).toBe(0);
    expect(g.cmsCompliantPatients).toBe(0); // 0% < 70% → not compliant
  });

  // ── CMS boundary: exactly 70% adherent nights ──────────────────────────────

  it("marks a patient as CMS-compliant when exactly 70% of their nights are adherent", () => {
    // 7 out of 10 nights ≥ 240 min → 70.00% ≥ 70% → compliant.
    const rows = [
      ...Array.from({ length: 7 }, () => night("m", "p1", 240)),
      ...Array.from({ length: 3 }, () => night("m", "p1", 60)),
    ];
    const r = aggregateTherapyUsageReport("manufacturer", rows);
    const g = r.groups[0]!;
    expect(g.cmsCompliantPatients).toBe(1);
  });

  it("marks a patient as NOT CMS-compliant when only 69% of their nights are adherent", () => {
    // 69 out of 100 nights → 69% < 70% → not compliant.
    const rows = [
      ...Array.from({ length: 69 }, () => night("m", "p1", 240)),
      ...Array.from({ length: 31 }, () => night("m", "p1", 60)),
    ];
    const r = aggregateTherapyUsageReport("manufacturer", rows);
    const g = r.groups[0]!;
    expect(g.cmsCompliantPatients).toBe(0);
  });

  // ── groupSublabel is preserved ─────────────────────────────────────────────

  it("preserves groupSublabel on the output group", () => {
    const rows = [
      night("provA", "p1", 300, {
        groupLabel: "Dr. Smith",
        groupSublabel: "NPI 1234567890 · Smith Clinic",
      }),
    ];
    const r = aggregateTherapyUsageReport("provider", rows);
    const g = r.groups[0]!;
    expect(g.sublabel).toBe("NPI 1234567890 · Smith Clinic");
  });

  it("outputs null sublabel when groupSublabel is not provided", () => {
    const rows = [night("m", "p1", 300)];
    const r = aggregateTherapyUsageReport("manufacturer", rows);
    expect(r.groups[0]!.sublabel).toBeNull();
  });

  // ── Summary is NOT an average-of-group-averages ────────────────────────────

  it("summary avgUsageHours aggregates raw rows, not group averages", () => {
    // Group A: 1 night at 120 min → avg 120/60=2.0h
    // Group B: 1 night at 360 min → avg 360/60=6.0h
    // Average-of-averages would be (2.0+6.0)/2=4.0h
    // Direct row aggregation: (120+360)/2=240 min → 4.0h (same here)
    // Use 3 vs 1 to make them diverge:
    // Group A: 3 nights at 60 min each → avg 1.0h
    // Group B: 1 night at 540 min → avg 9.0h
    // Avg-of-avgs: (1.0+9.0)/2 = 5.0h
    // Raw aggregation: (60+60+60+540)/4 = 720/4=180 min → 3.0h
    const rows = [
      night("groupA", "p1", 60),
      night("groupA", "p1", 60),
      night("groupA", "p1", 60),
      night("groupB", "p2", 540),
    ];
    const r = aggregateTherapyUsageReport("provider", rows);
    // 3.0h from direct row aggregation, NOT 5.0h from avg-of-avgs
    expect(r.summary.avgUsageHours).toBe(3);
  });

  // ── Sorting tie-breaking ───────────────────────────────────────────────────

  it("breaks ties in patient count alphabetically by label (asc)", () => {
    // Three buckets all with 1 patient each → sorted by label alphabetically.
    const rows = [
      night("z-key", "p1", 300, { groupLabel: "Zeta Provider" }),
      night("a-key", "p2", 300, { groupLabel: "Alpha Provider" }),
      night("m-key", "p3", 300, { groupLabel: "Middle Provider" }),
    ];
    const r = aggregateTherapyUsageReport("provider", rows);
    expect(r.groups.map((g) => g.label)).toEqual([
      "Alpha Provider",
      "Middle Provider",
      "Zeta Provider",
    ]);
  });

  // ── grouping field on the result ───────────────────────────────────────────

  it("sets the grouping field to the requested grouping axis", () => {
    expect(
      aggregateTherapyUsageReport("patient", []).grouping,
    ).toBe("patient");
    expect(
      aggregateTherapyUsageReport("provider", []).grouping,
    ).toBe("provider");
    expect(
      aggregateTherapyUsageReport("manufacturer", []).grouping,
    ).toBe("manufacturer");
  });

  // ── avgUsageHours rounding ─────────────────────────────────────────────────

  it("rounds avgUsageHours to 1 decimal place", () => {
    // 2 nights: 61 + 62 = 123 min → 61.5 min avg → 1.025h → rounds to 1.0
    const rows = [night("m", "p1", 61), night("m", "p1", 62)];
    const r = aggregateTherapyUsageReport("manufacturer", rows);
    const g = r.groups[0]!;
    // 123 / 2 = 61.5 min → 61.5/60 ≈ 1.025h → rounded to 1 decimal → 1.0
    expect(g.avgUsageHours).toBe(1.0);
  });

  // ── Single patient, zero adherent nights ──────────────────────────────────

  it("marks a single-patient bucket as not compliant when all nights are non-adherent", () => {
    const rows = [
      night("m", "p1", 60),
      night("m", "p1", 120),
      night("m", "p1", 180),
    ];
    const r = aggregateTherapyUsageReport("manufacturer", rows);
    const g = r.groups[0]!;
    expect(g.adherentNightRate).toBe(0);
    expect(g.cmsCompliantPatients).toBe(0);
    expect(g.cmsComplianceRate).toBe(0);
  });
});
