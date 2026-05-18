import { describe, it, expect } from "vitest";

import {
  sortRtRows,
  type RtOverviewRow,
  type RtSortKey,
} from "./rt-overview-api";

function row(overrides: Partial<RtOverviewRow>): RtOverviewRow {
  return {
    patientId: overrides.patientId ?? "p_default",
    pacwareId: overrides.pacwareId ?? "PW-000",
    firstName: overrides.firstName ?? "First",
    lastName: overrides.lastName ?? "Last",
    nightsInWindow: overrides.nightsInWindow ?? 0,
    lastNightDate: overrides.lastNightDate ?? null,
    staleDays: overrides.staleDays ?? null,
    ahiAvg: overrides.ahiAvg ?? null,
    leakAvg: overrides.leakAvg ?? null,
    usageMinutesAvg: overrides.usageMinutesAvg ?? null,
    activeAlerts: overrides.activeAlerts ?? [],
    therapyLinks: overrides.therapyLinks ?? [],
  };
}

describe("sortRtRows", () => {
  it("returns input unchanged when sort is 'default'", () => {
    const rows = [
      row({ patientId: "p1", lastName: "Brown" }),
      row({ patientId: "p2", lastName: "Adams" }),
    ];
    const out = sortRtRows(rows, "default", "asc");
    expect(out.map((r) => r.patientId)).toEqual(["p1", "p2"]);
  });

  it("sorts by patient name ascending", () => {
    const rows = [
      row({ patientId: "p1", lastName: "Brown", firstName: "Bob" }),
      row({ patientId: "p2", lastName: "Adams", firstName: "Alice" }),
      row({ patientId: "p3", lastName: "Adams", firstName: "Zane" }),
    ];
    const out = sortRtRows(rows, "patient", "asc");
    expect(out.map((r) => r.patientId)).toEqual(["p2", "p3", "p1"]);
  });

  it("sorts by AHI descending — worst first — and sinks nulls to bottom", () => {
    const rows = [
      row({ patientId: "p1", ahiAvg: 2 }),
      row({ patientId: "p2", ahiAvg: 8 }),
      row({ patientId: "p3", ahiAvg: null }),
      row({ patientId: "p4", ahiAvg: 5 }),
    ];
    const out = sortRtRows(rows, "ahi", "desc");
    expect(out.map((r) => r.patientId)).toEqual(["p2", "p4", "p1", "p3"]);
  });

  it("sorts by AHI ascending and still sinks nulls (null != 0)", () => {
    const rows = [
      row({ patientId: "p1", ahiAvg: 2 }),
      row({ patientId: "p2", ahiAvg: null }),
      row({ patientId: "p3", ahiAvg: 5 }),
    ];
    const out = sortRtRows(rows, "ahi", "asc");
    expect(out.map((r) => r.patientId)).toEqual(["p1", "p3", "p2"]);
  });

  it("sorts by alert count desc", () => {
    const rows = [
      row({
        patientId: "p1",
        activeAlerts: [
          { id: "a1", kind: "leak_rising", label: "Leak rising", detectedAt: "" },
        ],
      }),
      row({ patientId: "p2", activeAlerts: [] }),
      row({
        patientId: "p3",
        activeAlerts: [
          { id: "a2", kind: "leak_rising", label: "Leak rising", detectedAt: "" },
          { id: "a3", kind: "usage_dropping", label: "Usage dropping", detectedAt: "" },
        ],
      }),
    ];
    const out = sortRtRows(rows, "alerts", "desc");
    expect(out.map((r) => r.patientId)).toEqual(["p3", "p1", "p2"]);
  });

  it("sorts by usage minutes asc to find the least-adherent patients first", () => {
    const rows = [
      row({ patientId: "p1", usageMinutesAvg: 420 }),
      row({ patientId: "p2", usageMinutesAvg: 120 }),
      row({ patientId: "p3", usageMinutesAvg: null }),
      row({ patientId: "p4", usageMinutesAvg: 300 }),
    ];
    const out = sortRtRows(rows, "usage", "asc");
    expect(out.map((r) => r.patientId)).toEqual(["p2", "p4", "p1", "p3"]);
  });

  it("sorts by last-night date ascending (oldest first) — useful for stale triage", () => {
    const rows = [
      row({ patientId: "p1", lastNightDate: "2026-05-15" }),
      row({ patientId: "p2", lastNightDate: "2026-05-10" }),
      row({ patientId: "p3", lastNightDate: null }),
      row({ patientId: "p4", lastNightDate: "2026-05-17" }),
    ];
    const out = sortRtRows(rows, "lastNight", "asc");
    expect(out.map((r) => r.patientId)).toEqual(["p2", "p1", "p4", "p3"]);
  });

  it("does not mutate the input array", () => {
    const rows = [
      row({ patientId: "p1", ahiAvg: 2 }),
      row({ patientId: "p2", ahiAvg: 8 }),
    ];
    const orig = rows.map((r) => r.patientId);
    sortRtRows(rows, "ahi", "desc");
    expect(rows.map((r) => r.patientId)).toEqual(orig);
  });

  it("returns a stable result across every sort key (smoke)", () => {
    const rows = [row({ patientId: "p1" }), row({ patientId: "p2" })];
    const keys: RtSortKey[] = [
      "default",
      "patient",
      "alerts",
      "nights",
      "lastNight",
      "ahi",
      "leak",
      "usage",
    ];
    for (const k of keys) {
      expect(sortRtRows(rows, k, "asc")).toHaveLength(2);
      expect(sortRtRows(rows, k, "desc")).toHaveLength(2);
    }
  });
});
