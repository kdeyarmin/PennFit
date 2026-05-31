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

  it("preserves the grouping field in the result", () => {
    expect(aggregateTherapyUsageReport("patient", []).grouping).toBe("patient");
    expect(aggregateTherapyUsageReport("provider", []).grouping).toBe(
      "provider",
    );
    expect(
      aggregateTherapyUsageReport("manufacturer", []).grouping,
    ).toBe("manufacturer");
  });

  it("propagates sublabel from the first row in the bucket", () => {
    const rows = [
      night("provA", "p1", 300, { groupSublabel: "NPI 123 · Clinic A" }),
      night("provA", "p2", 300, { groupSublabel: "NPI 123 · Clinic A" }),
    ];
    const r = aggregateTherapyUsageReport("provider", rows);
    expect(r.groups[0]!.sublabel).toBe("NPI 123 · Clinic A");
  });

  it("CMS compliance boundary: exactly 70% of nights are compliant → is compliant", () => {
    // 7 nights, 5 adherent (≥240 min) = 5/7 ≈ 71.4% → compliant
    // To get exactly 70% without floating point: 7 nights, floor(0.7 * 7) = 4.9 → need 7 nights 5 compliant
    // Let's use 10 nights, 7 adherent = exactly 70% → compliant
    const rows: TherapyNightRow[] = [
      ...Array.from({ length: 7 }, () => night("m", "p1", 240)), // exactly 240 min
      ...Array.from({ length: 3 }, () => night("m", "p1", 0)),
    ];
    const r = aggregateTherapyUsageReport("manufacturer", rows);
    const g = r.groups[0]!;
    expect(g.cmsCompliantPatients).toBe(1);
    expect(g.cmsComplianceRate).toBe(1);
  });

  it("CMS compliance boundary: below 70% of nights compliant → not compliant", () => {
    // 10 nights, 6 adherent = 60% → NOT compliant
    const rows: TherapyNightRow[] = [
      ...Array.from({ length: 6 }, () => night("m", "p1", 240)),
      ...Array.from({ length: 4 }, () => night("m", "p1", 0)),
    ];
    const r = aggregateTherapyUsageReport("manufacturer", rows);
    const g = r.groups[0]!;
    expect(g.cmsCompliantPatients).toBe(0);
    expect(g.cmsComplianceRate).toBe(0);
  });

  it("patient grouping: each patient becomes its own bucket key", () => {
    const rows = [
      night("patient-uuid-1", "patient-uuid-1", 300, {
        groupLabel: "Patient ABC",
      }),
      night("patient-uuid-2", "patient-uuid-2", 60, {
        groupLabel: "Patient DEF",
      }),
    ];
    const r = aggregateTherapyUsageReport("patient", rows);
    expect(r.groups).toHaveLength(2);
    expect(r.groups.map((g) => g.key)).toContain("patient-uuid-1");
    expect(r.groups.map((g) => g.key)).toContain("patient-uuid-2");
    // Summary sees 2 distinct patients
    expect(r.summary.patientCount).toBe(2);
  });

  it("avgUsageHours is null when every night reports null usage", () => {
    const rows = [
      night("m", "p1", null),
      night("m", "p1", null),
      night("m", "p2", null),
    ];
    const r = aggregateTherapyUsageReport("manufacturer", rows);
    const g = r.groups[0]!;
    expect(g.avgUsageHours).toBeNull();
    // null usage → 0 → not adherent
    expect(g.adherentNightRate).toBe(0);
    // summary also has no usage hours
    expect(r.summary.avgUsageHours).toBeNull();
  });

  it("avgAhi and avgLeakRateLMin are null when no nights report them", () => {
    const rows = [night("m", "p1", 300), night("m", "p1", 300)];
    const r = aggregateTherapyUsageReport("manufacturer", rows);
    const g = r.groups[0]!;
    expect(g.avgAhi).toBeNull();
    expect(g.avgLeakRateLMin).toBeNull();
    expect(r.summary.avgAhi).toBeNull();
    expect(r.summary.avgLeakRateLMin).toBeNull();
  });

  it("sorts two buckets with equal patient count alphabetically by label", () => {
    const rows = [
      night("zKey", "p1", 300, { groupLabel: "Zeta Manufacturer" }),
      night("aKey", "p2", 300, { groupLabel: "Alpha Manufacturer" }),
    ];
    const r = aggregateTherapyUsageReport("manufacturer", rows);
    expect(r.groups[0]!.label).toBe("Alpha Manufacturer");
    expect(r.groups[1]!.label).toBe("Zeta Manufacturer");
  });

  it("summary nightsWithData counts total rows, including those from multi-bucket patients", () => {
    // p1 under provA and provB → 2 rows in the aggregation input
    const rows = [
      night("provA", "p1", 300),
      night("provB", "p1", 300),
      night("provB", "p2", 120),
    ];
    const r = aggregateTherapyUsageReport("provider", rows);
    // Summary re-aggregates from raw rows → 3 nights total
    expect(r.summary.nightsWithData).toBe(3);
  });

  it("summary avgUsageHours is not an average-of-group-averages (exact raw mean)", () => {
    // Group A: p1 with 600 min (1 night); Group B: p2 with 120 min + 60 min (2 nights)
    // avg-of-averages would give (600/1 + (120+60)/2) / 2 = (600 + 90) / 2 = 345 min → 5.8h
    // exact raw mean:  (600 + 120 + 60) / 3 = 260 min → 4.3h
    const rows = [
      night("provA", "p1", 600),
      night("provB", "p2", 120),
      night("provB", "p2", 60),
    ];
    const r = aggregateTherapyUsageReport("provider", rows);
    expect(r.summary.avgUsageHours).toBe(4.3);
  });

  it("cmsComplianceRate is null when the bucket has no patients", () => {
    // This edge case occurs from an empty bucket (no patients) — the
    // groups array will be empty so cmsComplianceRate can't be accessed,
    // but the summary null case is covered by the empty-data test.
    const r = aggregateTherapyUsageReport("provider", []);
    expect(r.summary.cmsComplianceRate).toBeNull();
  });

  it("rounds avgUsageHours to one decimal place", () => {
    // 4 nights of 250 min = 1000 / 4 = 250 min = 4.1666... h → rounds to 4.2h
    const rows = Array.from({ length: 3 }, () => night("m", "p1", 250));
    rows.push(night("m", "p1", 251)); // 1001 / 4 = 250.25 min → 4.170... h → 4.2h
    const r = aggregateTherapyUsageReport("manufacturer", rows);
    // 1001 min / 4 = 250.25 / 60 = 4.170... → 4.2
    expect(r.groups[0]!.avgUsageHours).toBe(4.2);
  });
});
