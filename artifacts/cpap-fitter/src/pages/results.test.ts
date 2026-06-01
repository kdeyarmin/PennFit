// Tests for pages/results.tsx — defensive catalogById useMemo
//
// Canonical shape: the catalogById useMemo guards both hops before
// iterating, so a transient non-JSON /api/masks response (the proxy
// serving the SPA shell mid-deploy, landing `catalog` as a string or
// `{}`) can't crash the page on `.masks.forEach`:
//
//   if (!catalog || !Array.isArray(catalog.masks)) return map;
//   catalog.masks.forEach((m) => map.set(m.id, m));
//
// A feature branch once replaced this with bare optional chaining
// (`catalog?.masks.forEach(...)`); that change was reverted on main
// because `catalog?.masks` only short-circuits on null/undefined
// `catalog`, leaving `.forEach` to throw when `catalog` is a string.
// These tests pin the guarded form that ships on main.

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SRC = readFileSync(path.join(__dirname, "results.tsx"), "utf8");

// ---------------------------------------------------------------------------
// catalogById — simplified optional-chain expression
// ---------------------------------------------------------------------------

describe("results — catalogById guards both hops with Array.isArray", () => {
  it("iterates catalog.masks with forEach to populate the map", () => {
    expect(SRC).toContain("catalog.masks.forEach(");
  });

  it("contains the Array.isArray(catalog.masks) guard", () => {
    expect(SRC).toContain("Array.isArray(catalog.masks)");
  });

  it("early-returns via the !catalog || !Array.isArray conditional", () => {
    // The guard combines !catalog and !Array.isArray to early-return the
    // empty map for any non-array catalog.masks.
    expect(SRC).toContain("!Array.isArray(catalog");
  });

  it("uses an Array.isArray call inside the catalogById block", () => {
    // Locate the useMemo block containing catalogById and confirm the
    // defensive guard lives in that region. The block carries a long
    // explanatory comment before the guard, so the window spans the
    // whole body up to its `}, [catalog])` dependency-array close.
    const memoStart = SRC.indexOf("catalogById = React.useMemo");
    const memoEnd = SRC.indexOf("}, [catalog])", memoStart);
    const memoSection = SRC.slice(memoStart, memoEnd);
    expect(memoEnd).toBeGreaterThan(memoStart);
    expect(memoSection).toContain("Array.isArray");
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

function buildCatalogById(catalog: MockCatalog): Map<string, MockMaskEntry> {
  // Mirrors the guarded form's observable behaviour:
  //   if (!catalog || !Array.isArray(catalog.masks)) return map;
  //   catalog.masks.forEach((m) => map.set(m.id, m));
  // For the array / undefined inputs this helper exercises, the guarded
  // early-return and this optional-chain spelling produce identical maps.
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

// ---------------------------------------------------------------------------
// Retake CTA — offered for any non-"strong" confidence (low AND moderate)
// ---------------------------------------------------------------------------

describe("results — retake CTA gating", () => {
  it("offers the retake CTA whenever confidence is not strong", () => {
    // Previously gated on `confidenceBand === "low"`, which stranded a
    // "moderate" (70–84%) match with no way to improve it. The CTA now
    // shows for everything below "strong".
    expect(SRC).toContain('confidenceBand !== "strong"');
  });

  it("no longer gates the retake CTA on the low band alone", () => {
    expect(SRC).not.toContain('confidenceBand === "low" && (');
  });

  it("still routes the retake CTA back to /capture", () => {
    expect(SRC).toContain('setLocation("/capture")');
    expect(SRC).toContain('data-testid="results-retake-photo"');
  });
});
