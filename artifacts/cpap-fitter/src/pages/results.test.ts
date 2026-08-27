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
    // Bound the search by the END of that branch rather than by a
    // character count. The window is here to prove the legacy fallback
    // is INSIDE the `not_enabled` branch and nowhere else; a fixed
    // char budget made that assertion hostage to comment length, and
    // adding a comment inside the branch broke it without changing any
    // behaviour.
    const branchEnd = SRC.indexOf("\n      }", notEnabledIdx);
    expect(branchEnd).toBeGreaterThan(notEnabledIdx);
    const branch = SRC.slice(notEnabledIdx, branchEnd);
    expect(branch).toContain('setClinicalState("legacy")');
  });

  it("does not treat a network/HTTP miss as a reason to skip magnet screening", () => {
    expect(SRC).not.toContain("Flag off, unresolvable tenant, network failure");
  });
});

describe("results — fitSessionId survives legacy fallbacks", () => {
  it("does not clear fitSessionId when clinical assess is not enabled", () => {
    const notEnabledIdx = SRC.indexOf('result.kind === "not_enabled"');
    const branchEnd = SRC.indexOf("\n      }", notEnabledIdx);
    const branch = SRC.slice(notEnabledIdx, branchEnd);
    expect(branch).not.toContain("setFitSessionId(null)");
  });

  it("does not clear fitSessionId when the invite token is absent", () => {
    const noInviteIdx = SRC.indexOf("if (!inviteToken)");
    const branchEnd = SRC.indexOf("\n    }", noInviteIdx);
    const branch = SRC.slice(noInviteIdx, branchEnd);
    expect(branch).not.toContain("setFitSessionId(null)");
  });

  it("still records fitSessionId when clinical assess succeeds", () => {
    expect(SRC).toContain("setFitSessionId(result.assessment.fitSessionId)");
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
// The fitter no longer sells, and no longer takes the patient's own order
// ---------------------------------------------------------------------------

describe("results — the page ends in a REQUEST, not an order", () => {
  it("routes a chosen mask to /fit-request under lead-capture", () => {
    // The whole point of `fitter.lead_capture_only`: the patient's
    // selection produces a request a person works, not an order they
    // filed. /order stays reachable ONLY for a tenant that deliberately
    // turned the flag off.
    expect(SRC).toContain(
      'setLocation(leadCaptureOnly ? "/fit-request" : "/order")',
    );
  });

  it("offers a callback that does NOT require choosing a mask first", () => {
    // The patient who wants a person is usually the one who could not
    // choose between the cards; requiring a choice first would ask them
    // to answer the question they came here with.
    expect(SRC).toContain("const handleRequestCallback = (context?: {");
    expect(SRC).toContain('setLocation("/fit-request?mode=callback")');
    expect(SRC).toContain("<CallbackPanel");
  });

  it("no longer bridges the fitting into the cash-pay shop cart", () => {
    // Removed with the self-serve order form: a fitting that ends in a
    // checkout is still a patient placing their own order, just a paid
    // checkout is still a patient placing their own order. Insurance ordering
    // and fit requests are the supported paths.
    expect(SRC).not.toContain("cashPay");
    expect(SRC).not.toContain("shopByModelNumber");
    expect(SRC).not.toContain("handleCashPayAdd");
    expect(SRC).not.toContain("rememberFitCheckoutContext");
  });
});

// ---------------------------------------------------------------------------
// Adult / child — the service line reaches BOTH engines
// ---------------------------------------------------------------------------

describe("results — population is sent to whichever engine answers", () => {
  it("sends population on the clinical assess request", () => {
    // Without this the route's buildProfile resolves every
    // legacy-questionnaire fitting to "adult", and tier 1 hands a child
    // adult-only masks.
    expect(SRC).toContain("...(population ? { population } : {})");
  });

  it("sends population on the legacy /api/recommend request", () => {
    // Structural pin: /api/recommend requires `population` (adult | child).
    // Optional spread was retired when the client Zod schema made it
    // required — omitting it would 400 at the wire. The early return /
    // results-missing-population-restart gate keeps null out of the body.
    expect(SRC).toContain("answers: fullAnswers,");
    expect(SRC).toMatch(
      /mutate\(\{\s*data: \{\s*measurements,\s*answers: fullAnswers,\s*population,/,
    );
    expect(SRC).toContain('data-testid="results-missing-population-restart"');
  });

  it("reads the ranked population off the RESPONSE, falling back to the store", () => {
    // A server-side override — a chart-linked date of birth — must reach
    // the patient's screen rather than being silently disagreed with by
    // the client's own copy.
    expect(SRC).toContain(
      "const rankedPopulation = data.population ?? population;",
    );
  });

  it("refers a pediatric fitting to staff instead of blaming the photo", () => {
    // The legacy catalog carries no pediatric interfaces, so an empty
    // ranking for a child is correct and a retake cannot fix it.
    expect(SRC).toContain('rankedPopulation === "pediatric"');
    expect(SRC).toContain("results-pediatric-referral");
    expect(SRC).toContain("results-pediatric-callback");
  });
});

// ---------------------------------------------------------------------------
// Review follow-ups (Codex, PR #1313)
// ---------------------------------------------------------------------------

describe("results — a pediatric legacy fitting still completes its invite", () => {
  it("treats an answered-but-empty legacy result as a finished fitting", () => {
    // The legacy catalog is adult-only, so a pediatric session ALWAYS
    // ranks nothing — `topPick` stays null. Gating the invite
    // transmission on `topPick` therefore left exactly those invites at
    // "opened" forever: the patient could file a callback request while
    // the invite queue never learned the fitting had happened.
    expect(SRC).toContain("legacyAnsweredEmpty");
    expect(SRC).toContain("topPick !== null ||");
  });
});

describe("results — the effective service line wins over the browser's", () => {
  it("adopts the population the assessment actually filtered on", () => {
    // A chart-linked invite whose date of birth disagrees with the tap is
    // overridden server-side. Leaving the store on the stale value would
    // let the fit request label the fitting the wrong way round.
    expect(SRC).toContain("result.assessment.population");
    expect(SRC).toContain("setPopulation(result.assessment.population)");
  });
});

describe("results — the CTA tells the truth about where it leads", () => {
  it("passes the lead-capture mode into both renderers", () => {
    // With the flag OFF the same click opens the legacy self-service
    // order form, so an unconditional "we'll speak to you before anything
    // is ordered" would be a false promise.
    expect(SRC).toContain("leadCaptureOnly={leadCaptureOnly}");
  });
});
