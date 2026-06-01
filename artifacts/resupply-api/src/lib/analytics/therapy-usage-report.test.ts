// Pure-function tests for the therapy-usage report aggregator.
//
// No DB — the route owns the Supabase read, the source-priority dedupe,
// and the patient→bucket join; this pins the math: means, adherent-night
// rate, CMS-compliant patient count (via the real findBestAdherenceWindow
// rule), and distinct-patient dedup across buckets in the summary.

import { describe, it, expect } from "vitest";

import {
  aggregateTherapyUsageReport,
  type GroupRef,
  type PatientNight,
} from "./therapy-usage-report";

// Build N consecutive nights starting at `start` (YYYY-MM-DD) for one
// patient, each `mins` long. Used to manufacture a qualifying CMS window
// (≥4h on ≥70% of a consecutive 30-day window).
function run(
  patientId: string,
  start: string,
  count: number,
  mins: number | null,
  extra: { ahi?: number | null; leak?: number | null } = {},
): PatientNight[] {
  const out: PatientNight[] = [];
  const base = new Date(`${start}T00:00:00Z`);
  for (let i = 0; i < count; i++) {
    const d = new Date(base);
    d.setUTCDate(d.getUTCDate() + i);
    out.push({
      patientId,
      date: d.toISOString().slice(0, 10),
      usageMinutes: mins,
      ahi: extra.ahi ?? null,
      leakRateLMin: extra.leak ?? null,
    });
  }
  return out;
}

const ASOF = "2026-05-31";

function single(patientId: string, ref: GroupRef): Map<string, GroupRef[]> {
  return new Map([[patientId, [ref]]]);
}

describe("aggregateTherapyUsageReport", () => {
  it("computes per-bucket usage, adherence, and CMS compliance (real rule)", () => {
    // Nights are recent (inside ASOF's trailing 90-day CMS horizon).
    // p1: 30 consecutive 5h nights → a qualifying 30-day window → compliant.
    // p2: 5 consecutive 5h nights → only 5 of 30 calendar days compliant
    //     (17% < 70%) → not compliant.
    const nights = [
      ...run("p1", "2026-05-01", 30, 300),
      ...run("p2", "2026-05-01", 5, 300),
    ];
    const buckets = new Map<string, GroupRef[]>([
      ["p1", [{ key: "provA", label: "Dr A" }]],
      ["p2", [{ key: "provA", label: "Dr A" }]],
    ]);

    const r = aggregateTherapyUsageReport({
      grouping: "provider",
      nights,
      bucketsByPatient: buckets,
      asOfDate: ASOF,
    });
    expect(r.groups).toHaveLength(1);
    const g = r.groups[0]!;
    expect(g.patientCount).toBe(2);
    expect(g.nightsWithData).toBe(35);
    expect(g.avgUsageHours).toBe(5);
    // All 35 nights ≥ 4h.
    expect(g.adherentNightRate).toBe(1);
    // Only p1 has a qualifying 30-day window.
    expect(g.cmsCompliantPatients).toBe(1);
    expect(g.cmsComplianceRate).toBe(0.5);
  });

  it("does NOT mark a patient compliant on a single 4h night in the window", () => {
    // Regression for the original bug: one 4h night was 100% of reported
    // rows → falsely 'compliant'. The real CMS rule needs a 30-day window.
    const nights = run("p1", "2026-05-01", 1, 300);
    const r = aggregateTherapyUsageReport({
      grouping: "patient",
      nights,
      bucketsByPatient: single("p1", { key: "p1", label: "Patient ABC" }),
      asOfDate: ASOF,
    });
    expect(r.summary.cmsCompliantPatients).toBe(0);
    expect(r.summary.cmsComplianceRate).toBe(0);
    // Adherent-night rate still reflects the single ≥4h night.
    expect(r.summary.adherentNightRate).toBe(1);
  });

  it("scores CMS compliance over the RECENT horizon, not the start of therapy", () => {
    // pStale qualified a year before ASOF but has no recent data → NOT
    // currently compliant. pRecent qualified in the last 30 days → is.
    // (Anchoring the 90-day probe at the first pulled night would have
    // wrongly marked pStale compliant on a long report window.)
    const nights = [
      ...run("pStale", "2025-05-01", 30, 300),
      ...run("pRecent", "2026-05-01", 30, 300),
    ];
    const buckets = new Map<string, GroupRef[]>([
      ["pStale", [{ key: "x", label: "X" }]],
      ["pRecent", [{ key: "x", label: "X" }]],
    ]);
    const r = aggregateTherapyUsageReport({
      grouping: "provider",
      nights,
      bucketsByPatient: buckets,
      asOfDate: ASOF,
    });
    expect(r.summary.patientCount).toBe(2);
    // Only the recently-adherent patient counts toward current compliance.
    expect(r.summary.cmsCompliantPatients).toBe(1);
    expect(r.summary.cmsComplianceRate).toBe(0.5);
  });

  it("treats null usage minutes as a non-adherent zero night", () => {
    const nights = [
      {
        patientId: "p1",
        date: "2026-05-01",
        usageMinutes: null,
        ahi: null,
        leakRateLMin: null,
      },
      {
        patientId: "p1",
        date: "2026-05-02",
        usageMinutes: 300,
        ahi: null,
        leakRateLMin: null,
      },
    ];
    const r = aggregateTherapyUsageReport({
      grouping: "manufacturer",
      nights,
      bucketsByPatient: single("p1", { key: "ResMed", label: "ResMed" }),
      asOfDate: ASOF,
    });
    const g = r.groups[0]!;
    // avg usage only averages nights that reported minutes → 300 = 5.0h
    expect(g.avgUsageHours).toBe(5);
    // adherence counts both nights → 1 of 2
    expect(g.adherentNightRate).toBe(0.5);
  });

  it("dedups a patient who appears under multiple buckets in the summary", () => {
    // p1 referred by two providers → appears in both buckets, but the
    // summary counts the patient and the nights exactly once.
    const nights = run("p1", "2026-05-01", 30, 300);
    const buckets = new Map<string, GroupRef[]>([
      [
        "p1",
        [
          { key: "provA", label: "Dr A" },
          { key: "provB", label: "Dr B" },
        ],
      ],
    ]);
    const r = aggregateTherapyUsageReport({
      grouping: "provider",
      nights,
      bucketsByPatient: buckets,
      asOfDate: ASOF,
    });
    expect(r.groups).toHaveLength(2);
    expect(r.groups.every((g) => g.patientCount === 1)).toBe(true);
    expect(r.groups.every((g) => g.nightsWithData === 30)).toBe(true);
    // Summary dedups: one patient, 30 nights (not 60), counted once.
    expect(r.summary.patientCount).toBe(1);
    expect(r.summary.nightsWithData).toBe(30);
    expect(r.summary.cmsCompliantPatients).toBe(1);
  });

  it("averages AHI and leak only over nights that reported them", () => {
    const nights: PatientNight[] = [
      {
        patientId: "p1",
        date: "2026-05-01",
        usageMinutes: 300,
        ahi: 2,
        leakRateLMin: 10,
      },
      {
        patientId: "p1",
        date: "2026-05-02",
        usageMinutes: 300,
        ahi: 4,
        leakRateLMin: null,
      },
      {
        patientId: "p1",
        date: "2026-05-03",
        usageMinutes: 300,
        ahi: null,
        leakRateLMin: null,
      },
    ];
    const r = aggregateTherapyUsageReport({
      grouping: "manufacturer",
      nights,
      bucketsByPatient: single("p1", { key: "ResMed", label: "ResMed" }),
      asOfDate: ASOF,
    });
    const g = r.groups[0]!;
    expect(g.avgAhi).toBe(3); // (2+4)/2
    expect(g.avgLeakRateLMin).toBe(10); // only one reported
  });

  it("sorts buckets by patient count desc then label asc", () => {
    const nights = [
      ...run("p1", "2026-04-01", 1, 300),
      ...run("p2", "2026-04-01", 1, 300),
      ...run("p3", "2026-04-01", 1, 300),
    ];
    const buckets = new Map<string, GroupRef[]>([
      ["p1", [{ key: "solo", label: "Zeta" }]],
      ["p2", [{ key: "big", label: "Alpha" }]],
      ["p3", [{ key: "big", label: "Alpha" }]],
    ]);
    const r = aggregateTherapyUsageReport({
      grouping: "provider",
      nights,
      bucketsByPatient: buckets,
      asOfDate: ASOF,
    });
    expect(r.groups.map((g) => g.key)).toEqual(["big", "solo"]);
  });

  it("returns null metrics and empty groups for no data", () => {
    const r = aggregateTherapyUsageReport({
      grouping: "patient",
      nights: [],
      bucketsByPatient: new Map(),
      asOfDate: ASOF,
    });
    expect(r.groups).toEqual([]);
    expect(r.summary.patientCount).toBe(0);
    expect(r.summary.avgUsageHours).toBeNull();
    expect(r.summary.adherentNightRate).toBeNull();
    expect(r.summary.cmsComplianceRate).toBeNull();
  });
});
