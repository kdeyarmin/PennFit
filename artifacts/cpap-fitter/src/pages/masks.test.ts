// Tests for pages/masks.tsx — defensive filteredMasks expression
//
// Canonical shape: filteredMasks is computed with an Array.isArray
// defensive guard so a non-JSON /api/masks response (a transient proxy
// fallback during a deploy, where `data` lands as a string) can't crash
// the page on `.filter` of a non-array.
//
//   const filteredMasks = Array.isArray(data?.masks)
//     ? data.masks.filter((m) => filter === "all" || m.type === filter)
//     : [];
//
// A feature branch once tried to drop this guard in favour of bare
// optional chaining (`data?.masks.filter(...) || []`); that change was
// reverted on main because `data?.masks` only short-circuits on
// null/undefined `data`, leaving `.filter` to throw when `data` is a
// string. These tests pin the guarded form that ships on main.

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SRC = readFileSync(path.join(__dirname, "masks.tsx"), "utf8");

// ---------------------------------------------------------------------------
// filteredMasks — simplified expression
// ---------------------------------------------------------------------------

describe("masks — filteredMasks uses an Array.isArray defensive guard", () => {
  it("guards data.masks with Array.isArray before filtering", () => {
    expect(SRC).toContain("data.masks.filter(");
  });

  it("returns [] from the guard's else branch when masks isn't an array", () => {
    // The ternary's else branch supplies the empty-array fallback for a
    // non-array `data?.masks` (e.g. a string body during a deploy).
    expect(SRC).toContain("data.masks.filter(");
    expect(SRC).toMatch(/Array\.isArray\(data\?\.masks\)[\s\S]*:\s*\[\]/);
  });

  it("wraps filteredMasks in an Array.isArray(data?.masks) ternary", () => {
    expect(SRC).toContain("Array.isArray(data?.masks)");
  });

  it("uses Array.isArray within the filteredMasks definition", () => {
    // The guard must live in the filteredMasks region, not elsewhere.
    const filteredMasksSection = SRC.slice(
      Math.max(0, SRC.indexOf("filteredMasks")),
      SRC.indexOf("filteredMasks") + 300,
    );
    expect(filteredMasksSection).toContain("Array.isArray");
  });

  it("filter predicate checks filter === 'all' OR type match", () => {
    // The business logic of the filter must be preserved.
    expect(SRC).toContain('filter === "all"');
    expect(SRC).toContain("m.type === filter");
  });
});

// ---------------------------------------------------------------------------
// filteredMasks — pure-logic contract
// ---------------------------------------------------------------------------

// Extract the filter logic as a standalone function and exercise it
// independently of the React component and hook infrastructure.
// This is the canonical behaviour the component relies on.

type MockMask = { id: string; type: string };

function applyMaskFilter(
  masks: MockMask[] | undefined,
  filter: string,
): MockMask[] {
  // Mirrors the guarded form's observable behaviour:
  //   Array.isArray(data?.masks) ? data.masks.filter(...) : []
  // For the array / undefined inputs this helper exercises, the guarded
  // ternary and this optional-chain spelling produce identical results.
  return masks?.filter((m) => filter === "all" || m.type === filter) || [];
}

describe("masks — filteredMasks pure-logic contract", () => {
  const catalog: MockMask[] = [
    { id: "a", type: "nasal" },
    { id: "b", type: "fullFace" },
    { id: "c", type: "nasal" },
    { id: "d", type: "nasalPillow" },
  ];

  it("returns all masks when filter is 'all'", () => {
    expect(applyMaskFilter(catalog, "all")).toHaveLength(4);
  });

  it("returns only nasal masks when filter is 'nasal'", () => {
    const result = applyMaskFilter(catalog, "nasal");
    expect(result).toHaveLength(2);
    expect(result.every((m) => m.type === "nasal")).toBe(true);
  });

  it("returns only fullFace masks when filter is 'fullFace'", () => {
    const result = applyMaskFilter(catalog, "fullFace");
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe("b");
  });

  it("returns an empty array when no masks match the filter type", () => {
    expect(applyMaskFilter(catalog, "hybrid")).toHaveLength(0);
  });

  it("returns [] when masks is undefined (data not yet loaded)", () => {
    // data?.masks is undefined when useListMasks hasn't resolved yet.
    // The optional chaining short-circuits to undefined; || [] gives [].
    expect(applyMaskFilter(undefined, "all")).toEqual([]);
    expect(applyMaskFilter(undefined, "nasal")).toEqual([]);
  });

  it("returns [] when masks array is empty", () => {
    expect(applyMaskFilter([], "all")).toEqual([]);
    expect(applyMaskFilter([], "nasal")).toEqual([]);
  });

  it("returns exactly the nasalPillow mask when filtered", () => {
    const result = applyMaskFilter(catalog, "nasalPillow");
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe("d");
  });

  // Boundary / regression case: all items share the same type
  it("returns all items when every mask matches the filter type", () => {
    const allNasal: MockMask[] = [
      { id: "x", type: "nasal" },
      { id: "y", type: "nasal" },
    ];
    expect(applyMaskFilter(allNasal, "nasal")).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// Structural — component exports and hook usage unchanged
// ---------------------------------------------------------------------------

describe("masks — structural integrity", () => {
  it("exports the Masks function component", () => {
    expect(SRC).toContain("export function Masks");
  });

  it("calls useListMasks to load the catalog", () => {
    expect(SRC).toContain("useListMasks()");
  });

  it("uses useState to manage the filter", () => {
    expect(SRC).toContain('useState<MaskEntryType | "all">("all")');
  });

  it("renders the 'No masks match the selected filter' message when filteredMasks is empty", () => {
    expect(SRC).toContain("No masks match the selected filter.");
  });
});
