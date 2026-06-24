// Tests for filterRosterPatients in provider-api.ts — the client-side
// "My patients" search. Pure function, driven directly (behavior).

import { describe, expect, it } from "vitest";

import {
  filterRosterPatients,
  pendingQueueIds,
  allPendingSelected,
} from "./provider-api";

const roster = [
  { patientName: "Alice Anderson" },
  { patientName: "Bob Brown" },
  { patientName: "carol clark" },
];

describe("filterRosterPatients", () => {
  it("returns the full list (a copy) for a blank query", () => {
    const out = filterRosterPatients(roster, "");
    expect(out).toHaveLength(3);
    expect(out).not.toBe(roster); // new array, not the same reference
  });

  it("treats a whitespace-only query as blank", () => {
    expect(filterRosterPatients(roster, "   ")).toHaveLength(3);
  });

  it("matches case-insensitively", () => {
    expect(filterRosterPatients(roster, "alice")).toEqual([
      { patientName: "Alice Anderson" },
    ]);
    expect(filterRosterPatients(roster, "CAROL")).toEqual([
      { patientName: "carol clark" },
    ]);
  });

  it("matches a substring anywhere in the name (last name, partial)", () => {
    expect(filterRosterPatients(roster, "brown")).toEqual([
      { patientName: "Bob Brown" },
    ]);
    expect(filterRosterPatients(roster, "ar")).toEqual([
      { patientName: "carol clark" },
    ]);
  });

  it("returns an empty array when nothing matches", () => {
    expect(filterRosterPatients(roster, "zzz")).toEqual([]);
  });

  it("trims surrounding whitespace before matching", () => {
    expect(filterRosterPatients(roster, "  bob  ")).toEqual([
      { patientName: "Bob Brown" },
    ]);
  });
});

describe("pendingQueueIds", () => {
  const requests = [
    { id: "a", status: "pending" },
    { id: "b", status: "signed" },
    { id: "c", status: "pending" },
    { id: "d", status: "declined" },
  ];

  it("returns only the ids of pending documents, in order", () => {
    expect(pendingQueueIds(requests)).toEqual(["a", "c"]);
  });

  it("returns an empty array when nothing is pending", () => {
    expect(pendingQueueIds([{ id: "x", status: "signed" }])).toEqual([]);
    expect(pendingQueueIds([])).toEqual([]);
  });
});

describe("allPendingSelected", () => {
  it("is true only when every pending id is checked", () => {
    expect(allPendingSelected(["a", "c"], new Set(["a", "c"]))).toBe(true);
    expect(allPendingSelected(["a", "c"], new Set(["a", "c", "z"]))).toBe(true);
  });

  it("is false when some pending ids are unchecked", () => {
    expect(allPendingSelected(["a", "c"], new Set(["a"]))).toBe(false);
  });

  it("is false when there are no pending ids (nothing to select)", () => {
    expect(allPendingSelected([], new Set())).toBe(false);
    expect(allPendingSelected([], new Set(["a"]))).toBe(false);
  });
});
