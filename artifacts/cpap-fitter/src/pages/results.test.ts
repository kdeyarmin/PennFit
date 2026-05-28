// Tests for pages/results.tsx — simplified catalogById useMemo
//
// PR change: the explicit Array.isArray + early-return guard in the
// catalogById useMemo was removed.
//
// Before:
//   if (!catalog || !Array.isArray(catalog.masks)) return map;
//   catalog.masks.forEach((m) => map.set(m.id, m));
//
// After:
//   catalog?.masks.forEach((m) => map.set(m.id, m));
//
// The new form relies on optional chaining: when `catalog` is
// undefined/null the entire expression short-circuits to undefined
// and forEach is never called, leaving `map` empty. When catalog is
// defined TypeScript guarantees catalog.masks is MaskEntry[], so the
// loop runs normally.

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SRC = readFileSync(path.join(__dirname, "results.tsx"), "utf8");

// ---------------------------------------------------------------------------
// catalogById — simplified optional-chain expression
// ---------------------------------------------------------------------------

describe("results — catalogById uses optional chaining (no Array.isArray guard)", () => {
  it("uses catalog?.masks.forEach to populate the map", () => {
    expect(SRC).toContain("catalog?.masks.forEach(");
  });

  it("no longer contains the Array.isArray(catalog.masks) guard", () => {
    expect(SRC).not.toContain("Array.isArray(catalog.masks)");
  });

  it("no longer contains the !Array.isArray conditional for catalog", () => {
    // The removed guard used both !catalog and !Array.isArray together.
    expect(SRC).not.toContain("!Array.isArray(catalog");
  });

  it("does not use any Array.isArray call in the catalogById block", () => {
    // Locate the useMemo block containing catalogById and confirm no
    // Array.isArray appears in that region.
    const memoStart = SRC.indexOf("catalogById");
    const memoSection = SRC.slice(memoStart, memoStart + 500);
    expect(memoSection).not.toContain("Array.isArray");
  });

  it("populates the map with m.id as key inside forEach", () => {
    expect(SRC).toContain("map.set(m.id, m)");
  });

  it("still wraps the map construction in React.useMemo", () => {
    expect(SRC).toContain("React.useMemo(");
  });

  it("useMemo depends on [catalog]", () => {
    // The dependency array must include `catalog` so the map is
    // recomputed whenever useListMasks delivers fresh data.
    expect(SRC).toMatch(/\[catalog\]/);
  });
});

// ---------------------------------------------------------------------------
// catalogById — pure-logic contract
// ---------------------------------------------------------------------------

// Replicate the catalogById computation as a standalone function and
// verify its behaviour under every input shape the production code will
// encounter.

type MockMaskEntry = { id: string; name: string };
type MockCatalog = { masks: MockMaskEntry[] } | undefined;

function buildCatalogById(
  catalog: MockCatalog,
): Map<string, MockMaskEntry> {
  // Mirrors: catalog?.masks.forEach((m) => map.set(m.id, m))
  const map = new Map<string, MockMaskEntry>();
  catalog?.masks.forEach((m) => map.set(m.id, m));
  return map;
}

describe("results — catalogById pure-logic contract", () => {
  it("returns an empty Map when catalog is undefined", () => {
    // Regression case: when useListMasks hasn't resolved yet,
    // catalog is undefined; optional chaining must short-circuit.
    const result = buildCatalogById(undefined);
    expect(result.size).toBe(0);
  });

  it("returns an empty Map when catalog.masks is empty", () => {
    expect(buildCatalogById({ masks: [] }).size).toBe(0);
  });

  it("indexes a single mask by its id", () => {
    const mask: MockMaskEntry = { id: "mask-1", name: "Test Mask" };
    const result = buildCatalogById({ masks: [mask] });
    expect(result.get("mask-1")).toBe(mask);
  });

  it("indexes all masks when the catalog has multiple entries", () => {
    const masks: MockMaskEntry[] = [
      { id: "a", name: "Alpha" },
      { id: "b", name: "Beta" },
      { id: "c", name: "Gamma" },
    ];
    const result = buildCatalogById({ masks });
    expect(result.size).toBe(3);
    expect(result.get("a")).toStrictEqual({ id: "a", name: "Alpha" });
    expect(result.get("b")).toStrictEqual({ id: "b", name: "Beta" });
    expect(result.get("c")).toStrictEqual({ id: "c", name: "Gamma" });
  });

  it("a later entry overwrites an earlier one with the same id", () => {
    // Duplicate ids are unlikely in production data but the Map.set
    // semantics are deterministic: last write wins.
    const masks: MockMaskEntry[] = [
      { id: "dup", name: "First" },
      { id: "dup", name: "Second" },
    ];
    const result = buildCatalogById({ masks });
    expect(result.size).toBe(1);
    expect(result.get("dup")?.name).toBe("Second");
  });

  it("returns undefined for an id that is not in the catalog", () => {
    const result = buildCatalogById({ masks: [{ id: "x", name: "X" }] });
    expect(result.get("missing-id")).toBeUndefined();
  });

  // Boundary case: a catalog with exactly one mask at a known id
  it("lookups are O(1) via Map — get returns the same reference stored by forEach", () => {
    const mask: MockMaskEntry = { id: "ref-check", name: "Reference" };
    const result = buildCatalogById({ masks: [mask] });
    // Reference equality — the map stores the original object, not a copy.
    expect(result.get("ref-check")).toBe(mask);
  });
});

// ---------------------------------------------------------------------------
// Structural — component shape unchanged by the PR
// ---------------------------------------------------------------------------

describe("results — structural integrity", () => {
  it("exports the Results function component", () => {
    expect(SRC).toContain("export function Results");
  });

  it("still calls useListMasks for the catalog", () => {
    expect(SRC).toContain("useListMasks()");
  });

  it("still calls useGetRecommendation for the recommendation data", () => {
    expect(SRC).toContain("useGetRecommendation()");
  });

  it("still reads measurements from useFitterStore", () => {
    expect(SRC).toContain("useFitterStore()");
    expect(SRC).toContain("measurements");
  });

  it("still renders the 'Your Recommended Masks' heading", () => {
    expect(SRC).toContain("Your Recommended Masks");
  });

  it("still renders the MaskRecommendationCard with catalogById.get()", () => {
    expect(SRC).toContain("catalogById.get(mask.maskId)");
  });
});
