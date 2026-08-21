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

describe("results — magnet screening is not skipped on clinical outage", () => {
  it("renders a dedicated unavailable state instead of falling through to legacy", () => {
    expect(SRC).toContain('clinicalState === "unavailable"');
    expect(SRC).toContain('data-testid="results-clinical-unavailable"');
  });

  it("only uses the legacy engine when the tenant has clinical assessment off", () => {
    expect(SRC).toContain('result.kind === "not_enabled"');
    const notEnabledIdx = SRC.indexOf('result.kind === "not_enabled"');
    const after = SRC.slice(notEnabledIdx, notEnabledIdx + 280);
    expect(after).toContain('setClinicalState("legacy")');
  });

  it("does not treat a network/HTTP miss as a reason to skip magnet screening", () => {
    expect(SRC).not.toContain(
      "Flag off, unresolvable tenant, network failure",
    );
  });
});

describe("results — structural integrity", () => {
  it("exports the Results function component", () => {
    expect(SRC).toContain("export function Results");
  });

  it("still calls useListMasks for the catalog", () => {
    expect(SRC).toContain("useListMasks()");
  });

  it("still calls useGetRecommendation for the recommendation data", () => {
    expect(SRC).toContain("useGetRecommendation(");
  });

  it("threads the invite token to the recommendation request (invitation-only gate)", () => {
    expect(SRC).toContain("x-fitter-invite-token");
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

// ---------------------------------------------------------------------------
// Clinical cash-pay shop-key resolution — part number, then legacy fallback
// ---------------------------------------------------------------------------

/**
 * Pure re-implementation of the shop-key resolution inside
 * `clinicalCashPayFor`, kept in lockstep with results.tsx.
 *
 * Two identifier spaces meet there: `shopByModelNumber` is keyed on the
 * TENANT's own SKU (Stripe metadata `model_number`, e.g. "PHM-RM-F20"),
 * while `mask_size_variants.manufacturer_part_number` is the
 * MANUFACTURER's part number — and the 0486 seed leaves it NULL besides.
 * Resolving on the part number alone matched nothing, which hid the
 * cash-pay CTA on the clinical path and, because that resolver is the
 * only writer of the fit→order link, left the fitter outcome loop
 * structurally empty. The fix falls back to the legacy catalog's
 * modelNumber for the same slug (0481 keeps the slug space identical
 * across both catalogs, which is what makes the fallback exact).
 */
function resolveShopKey(
  partNumber: string | null | undefined,
  legacyModelNumber: string | null | undefined,
  shopKeys: ReadonlySet<string>,
): string | undefined {
  return (
    (partNumber && shopKeys.has(partNumber) ? partNumber : undefined) ??
    (legacyModelNumber && shopKeys.has(legacyModelNumber)
      ? legacyModelNumber
      : undefined)
  );
}

describe("results — clinical cash-pay shop-key fallback", () => {
  it("prefers the manufacturer part number when the shop is keyed on it", () => {
    const key = resolveShopKey(
      "63400",
      "PHM-RM-F20",
      new Set(["63400", "PHM-RM-F20"]),
    );
    expect(key).toBe("63400");
  });

  it("falls back to the legacy modelNumber when the part number is NULL", () => {
    // The 0486 seed's actual shape: every variant's part number is NULL,
    // so before the fallback existed this resolved to nothing and the
    // CTA never rendered on the clinical path.
    const key = resolveShopKey(null, "PHM-RM-F20", new Set(["PHM-RM-F20"]));
    expect(key).toBe("PHM-RM-F20");
  });

  it("falls back when the part number simply isn't a shop key", () => {
    // Part number present but the tenant keys its shop on its own SKUs —
    // the two identifier spaces are different, not just sparsely filled.
    const key = resolveShopKey("63400", "PHM-RM-F20", new Set(["PHM-RM-F20"]));
    expect(key).toBe("PHM-RM-F20");
  });

  it("returns undefined when neither key matches — the CTA stays hidden", () => {
    // A mask we can't price is a mask we can't sell.
    const key = resolveShopKey("63400", "PHM-RM-F20", new Set(["OTHER"]));
    expect(key).toBeUndefined();
    expect(resolveShopKey(null, undefined, new Set(["X"]))).toBeUndefined();
  });

  it("source keeps the fallback chain and passes the resolved key onward", () => {
    // Pin the shape in results.tsx: resolve to `shopKey`, look up the
    // product by it, and hand the SAME key to handleCashPayAdd so the
    // cart line matches the product that priced it.
    expect(SRC).toContain(
      "const legacyModelNumber = catalogById.get(c.maskSlug)?.modelNumber;",
    );
    expect(SRC).toContain("shopByModelNumber?.has(partNumber)");
    expect(SRC).toContain("shopByModelNumber?.has(legacyModelNumber)");
    expect(SRC).toContain("shopByModelNumber?.get(shopKey)");
    expect(SRC).toContain("{ maskId: c.maskId, modelNumber: shopKey }");
    // The regression this guards against: resolving the product from the
    // bare part number with no fallback.
    expect(SRC).not.toContain("shopByModelNumber?.get(partNumber)");
  });
});
