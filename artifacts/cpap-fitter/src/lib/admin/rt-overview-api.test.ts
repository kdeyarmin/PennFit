import { describe, it, expect } from "vitest";

import {
  distinctSources,
  filterRtRows,
  RT_FILTER_DEFAULT,
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

describe("filterRtRows", () => {
  const link = (source: string) => ({
    source,
    status: "active",
    lastSyncedAt: null,
    lastSyncStatus: null,
  });
  const alert = (kind: string) => ({
    id: `a_${kind}`,
    kind,
    label: kind,
    detectedAt: "",
  });

  const fleet: RtOverviewRow[] = [
    row({
      patientId: "p1",
      lastName: "Adams",
      firstName: "Alice",
      pacwareId: "PW-001",
      nightsInWindow: 5,
      activeAlerts: [alert("leak_rising")],
      therapyLinks: [link("airview")],
    }),
    row({
      patientId: "p2",
      lastName: "Brown",
      firstName: "Bob",
      pacwareId: "PW-002",
      nightsInWindow: 0,
      activeAlerts: [],
      therapyLinks: [link("care_orchestrator")],
    }),
    row({
      patientId: "p3",
      lastName: "Carter",
      firstName: "Carol",
      pacwareId: "PW-003",
      nightsInWindow: 7,
      activeAlerts: [],
      therapyLinks: [link("airview"), link("react_health")],
    }),
  ];

  it("returns every row with the default (no-op) filter", () => {
    const out = filterRtRows(fleet, RT_FILTER_DEFAULT);
    expect(out).toHaveLength(3);
  });

  it("alertingOnly keeps only patients with ≥1 active alert", () => {
    const out = filterRtRows(fleet, { ...RT_FILTER_DEFAULT, alertingOnly: true });
    expect(out.map((r) => r.patientId)).toEqual(["p1"]);
  });

  it("staleOnly keeps only patients with zero nights in the window", () => {
    const out = filterRtRows(fleet, { ...RT_FILTER_DEFAULT, staleOnly: true });
    expect(out.map((r) => r.patientId)).toEqual(["p2"]);
  });

  it("source filter keeps rows that match ANY of the listed sources", () => {
    const out = filterRtRows(fleet, {
      ...RT_FILTER_DEFAULT,
      sources: new Set(["airview"]),
    });
    expect(out.map((r) => r.patientId)).toEqual(["p1", "p3"]);
  });

  it("empty source set means 'no source filter', NOT 'show nothing'", () => {
    const out = filterRtRows(fleet, {
      ...RT_FILTER_DEFAULT,
      sources: new Set(),
    });
    expect(out).toHaveLength(3);
  });

  it("search matches case-insensitively across last + first + pacware id", () => {
    expect(
      filterRtRows(fleet, { ...RT_FILTER_DEFAULT, search: "adams" }).map(
        (r) => r.patientId,
      ),
    ).toEqual(["p1"]);
    expect(
      filterRtRows(fleet, { ...RT_FILTER_DEFAULT, search: "BOB" }).map(
        (r) => r.patientId,
      ),
    ).toEqual(["p2"]);
    expect(
      filterRtRows(fleet, { ...RT_FILTER_DEFAULT, search: "pw-003" }).map(
        (r) => r.patientId,
      ),
    ).toEqual(["p3"]);
  });

  it("trims whitespace around the search term", () => {
    const out = filterRtRows(fleet, {
      ...RT_FILTER_DEFAULT,
      search: "   alice   ",
    });
    expect(out.map((r) => r.patientId)).toEqual(["p1"]);
  });

  it("combines filters with AND semantics", () => {
    const out = filterRtRows(fleet, {
      ...RT_FILTER_DEFAULT,
      alertingOnly: true,
      sources: new Set(["airview"]),
    });
    expect(out.map((r) => r.patientId)).toEqual(["p1"]);

    // alerting AND care_orchestrator-only — no rows match.
    expect(
      filterRtRows(fleet, {
        ...RT_FILTER_DEFAULT,
        alertingOnly: true,
        sources: new Set(["care_orchestrator"]),
      }),
    ).toEqual([]);
  });

  it("does not mutate the input array", () => {
    const before = fleet.map((r) => r.patientId);
    filterRtRows(fleet, { ...RT_FILTER_DEFAULT, alertingOnly: true });
    expect(fleet.map((r) => r.patientId)).toEqual(before);
  });
});

describe("distinctSources", () => {
  const link = (source: string) => ({
    source,
    status: "active",
    lastSyncedAt: null,
    lastSyncStatus: null,
  });

  it("returns the alphabetically-sorted distinct source list", () => {
    const rows: RtOverviewRow[] = [
      row({ patientId: "p1", therapyLinks: [link("airview")] }),
      row({
        patientId: "p2",
        therapyLinks: [link("care_orchestrator"), link("airview")],
      }),
      row({ patientId: "p3", therapyLinks: [link("react_health")] }),
    ];
    expect(distinctSources(rows)).toEqual([
      "airview",
      "care_orchestrator",
      "react_health",
    ]);
  });

  it("returns an empty array for an empty fleet", () => {
    expect(distinctSources([])).toEqual([]);
  });

  it("deduplicates sources that appear across multiple patients", () => {
    const rows: RtOverviewRow[] = [
      row({ patientId: "p1", therapyLinks: [link("airview")] }),
      row({ patientId: "p2", therapyLinks: [link("airview")] }),
      row({ patientId: "p3", therapyLinks: [link("airview")] }),
    ];
    expect(distinctSources(rows)).toEqual(["airview"]);
  });

  it("deduplicates sources that appear multiple times within the same patient", () => {
    const rows: RtOverviewRow[] = [
      row({
        patientId: "p1",
        therapyLinks: [link("airview"), link("airview")],
      }),
    ];
    expect(distinctSources(rows)).toEqual(["airview"]);
  });

  it("returns an empty array when all patients have no therapy links", () => {
    const rows: RtOverviewRow[] = [
      row({ patientId: "p1", therapyLinks: [] }),
      row({ patientId: "p2", therapyLinks: [] }),
    ];
    expect(distinctSources(rows)).toEqual([]);
  });

  it("sorts alphabetically — z-source before a-source in insertion order is still returned a-first", () => {
    const rows: RtOverviewRow[] = [
      row({ patientId: "p1", therapyLinks: [link("react_health")] }),
      row({ patientId: "p2", therapyLinks: [link("airview")] }),
    ];
    expect(distinctSources(rows)).toEqual(["airview", "react_health"]);
  });
});

describe("RT_FILTER_DEFAULT", () => {
  it("has alertingOnly set to false", () => {
    expect(RT_FILTER_DEFAULT.alertingOnly).toBe(false);
  });

  it("has staleOnly set to false", () => {
    expect(RT_FILTER_DEFAULT.staleOnly).toBe(false);
  });

  it("has an empty sources set", () => {
    expect(RT_FILTER_DEFAULT.sources.size).toBe(0);
  });

  it("has an empty search string", () => {
    expect(RT_FILTER_DEFAULT.search).toBe("");
  });
});

describe("filterRtRows — additional edge cases", () => {
  const link = (source: string) => ({
    source,
    status: "active",
    lastSyncedAt: null,
    lastSyncStatus: null,
  });
  const alert = (kind: string) => ({
    id: `a_${kind}`,
    kind,
    label: kind,
    detectedAt: "",
  });

  it("returns empty array when given an empty fleet", () => {
    expect(filterRtRows([], RT_FILTER_DEFAULT)).toEqual([]);
  });

  it("returns empty array when no rows satisfy an active filter", () => {
    const rows = [
      row({ patientId: "p1", activeAlerts: [], therapyLinks: [] }),
    ];
    expect(
      filterRtRows(rows, { ...RT_FILTER_DEFAULT, alertingOnly: true }),
    ).toEqual([]);
  });

  it("source filter uses OR semantics — a row with EITHER listed source passes", () => {
    const rows = [
      row({ patientId: "p1", therapyLinks: [link("airview")] }),
      row({ patientId: "p2", therapyLinks: [link("care_orchestrator")] }),
      row({ patientId: "p3", therapyLinks: [link("react_health")] }),
    ];
    const out = filterRtRows(rows, {
      ...RT_FILTER_DEFAULT,
      sources: new Set(["airview", "care_orchestrator"]),
    });
    expect(out.map((r) => r.patientId)).toEqual(["p1", "p2"]);
  });

  it("source filter: row with multiple links passes if ANY link matches", () => {
    const rows = [
      row({
        patientId: "p1",
        therapyLinks: [link("react_health"), link("airview")],
      }),
    ];
    const out = filterRtRows(rows, {
      ...RT_FILTER_DEFAULT,
      sources: new Set(["airview"]),
    });
    expect(out).toHaveLength(1);
  });

  it("source filter: row with no therapy links is excluded when source filter is active", () => {
    const rows = [row({ patientId: "p1", therapyLinks: [] })];
    const out = filterRtRows(rows, {
      ...RT_FILTER_DEFAULT,
      sources: new Set(["airview"]),
    });
    expect(out).toHaveLength(0);
  });

  it("staleOnly: rows with nightsInWindow > 0 are excluded", () => {
    const rows = [
      row({ patientId: "p1", nightsInWindow: 1 }),
      row({ patientId: "p2", nightsInWindow: 7 }),
      row({ patientId: "p3", nightsInWindow: 0 }),
    ];
    const out = filterRtRows(rows, { ...RT_FILTER_DEFAULT, staleOnly: true });
    expect(out.map((r) => r.patientId)).toEqual(["p3"]);
  });

  it("alertingOnly + staleOnly combined — AND semantics; both conditions required", () => {
    const rows = [
      // alerting but NOT stale
      row({
        patientId: "p1",
        nightsInWindow: 5,
        activeAlerts: [alert("leak_rising")],
      }),
      // stale but NOT alerting
      row({ patientId: "p2", nightsInWindow: 0, activeAlerts: [] }),
      // stale AND alerting
      row({
        patientId: "p3",
        nightsInWindow: 0,
        activeAlerts: [alert("usage_dropping")],
      }),
    ];
    const out = filterRtRows(rows, {
      ...RT_FILTER_DEFAULT,
      alertingOnly: true,
      staleOnly: true,
    });
    expect(out.map((r) => r.patientId)).toEqual(["p3"]);
  });

  it("search matches partial pacware id fragment (e.g. only the numeric part)", () => {
    const rows = [
      row({ patientId: "p1", pacwareId: "PW-001", lastName: "Zulu", firstName: "Zara" }),
      row({ patientId: "p2", pacwareId: "PW-999", lastName: "Zulu", firstName: "Zara" }),
    ];
    const out = filterRtRows(rows, { ...RT_FILTER_DEFAULT, search: "999" });
    expect(out.map((r) => r.patientId)).toEqual(["p2"]);
  });

  it("search matches partial first name", () => {
    const rows = [
      row({ patientId: "p1", firstName: "Bartholomew", lastName: "Smith" }),
      row({ patientId: "p2", firstName: "Beth", lastName: "Smith" }),
    ];
    const out = filterRtRows(rows, { ...RT_FILTER_DEFAULT, search: "bartho" });
    expect(out.map((r) => r.patientId)).toEqual(["p1"]);
  });

  it("search with whitespace-only string is treated as no search filter", () => {
    const rows = [
      row({ patientId: "p1" }),
      row({ patientId: "p2" }),
    ];
    const out = filterRtRows(rows, { ...RT_FILTER_DEFAULT, search: "   " });
    expect(out).toHaveLength(2);
  });

  it("search returning no match gives empty array (not an error)", () => {
    const rows = [row({ patientId: "p1", lastName: "Adams", firstName: "Alice", pacwareId: "PW-001" })];
    const out = filterRtRows(rows, { ...RT_FILTER_DEFAULT, search: "zzz_no_match" });
    expect(out).toEqual([]);
  });

  it("preserves row object identity — the returned rows are the same references as the input", () => {
    const r1 = row({ patientId: "p1" });
    const r2 = row({ patientId: "p2" });
    const out = filterRtRows([r1, r2], RT_FILTER_DEFAULT);
    expect(out[0]).toBe(r1);
    expect(out[1]).toBe(r2);
  });

  it("all four filters active — only a row satisfying every predicate passes", () => {
    const rows = [
      // Passes all: alerting, stale (0 nights), airview source, name matches 'alice'
      row({
        patientId: "p1",
        firstName: "Alice",
        lastName: "Adams",
        pacwareId: "PW-001",
        nightsInWindow: 0,
        activeAlerts: [alert("leak_rising")],
        therapyLinks: [link("airview")],
      }),
      // Alerting + airview + name match but NOT stale
      row({
        patientId: "p2",
        firstName: "Alice",
        lastName: "Adams",
        pacwareId: "PW-002",
        nightsInWindow: 3,
        activeAlerts: [alert("leak_rising")],
        therapyLinks: [link("airview")],
      }),
    ];
    const out = filterRtRows(rows, {
      alertingOnly: true,
      staleOnly: true,
      sources: new Set(["airview"]),
      search: "alice",
    });
    expect(out.map((r) => r.patientId)).toEqual(["p1"]);
  });
});
