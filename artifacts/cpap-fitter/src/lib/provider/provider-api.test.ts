// Tests for filterRosterPatients in provider-api.ts — the client-side
// "My patients" search. Pure function, driven directly (behavior).

import { describe, expect, it } from "vitest";

import { filterRosterPatients } from "./provider-api";

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
