// Tests for lib/mask-catalog-coverage.ts — the parsing and static snapshot
// behind the /breathe/mask-fitting manufacturer roster.
//
// The invariant that matters most on a marketing page is that a bad or
// empty response degrades to the verified snapshot rather than to an empty
// roster or a row of zeros in front of a prospect.

import { describe, it, expect } from "vitest";

import {
  FALLBACK_COVERAGE,
  interfaceLabel,
  normalizeCoverage,
  summariseManufacturers,
} from "./mask-catalog-coverage";

const LIVE_BODY = {
  manufacturers: [
    { name: "ResMed", models: 25, currentModels: 20 },
    { name: "Philips Respironics", models: 17, currentModels: 16 },
  ],
  interfaceTypes: [
    { type: "nasal", models: 32 },
    { type: "full_face", models: 28 },
  ],
  totals: {
    manufacturers: 2,
    models: 42,
    currentModels: 36,
    discontinuedModels: 6,
    sizeVariants: 301,
    components: 244,
  },
  lastUpdatedAt: "2026-08-22T06:36:41.066Z",
};

describe("normalizeCoverage", () => {
  it("passes a well-formed live payload straight through", () => {
    expect(normalizeCoverage(LIVE_BODY)).toEqual(LIVE_BODY);
  });

  it.each([
    ["null", null],
    ["undefined", undefined],
    ["a string", "nope"],
    ["an object with no roster", { totals: { models: 83 } }],
    ["a non-array roster", { manufacturers: "ResMed" }],
    // The endpoint's own fail-soft shape.
    ["the empty fail-soft body", { manufacturers: [], totals: { models: 0 } }],
  ])("returns null for %s so the caller keeps the snapshot", (_label, body) => {
    expect(normalizeCoverage(body)).toBeNull();
  });

  it("drops malformed rows instead of discarding the whole roster", () => {
    const out = normalizeCoverage({
      manufacturers: [
        { name: "ResMed", models: 25, currentModels: 20 },
        { name: "", models: 9, currentModels: 9 }, // no name
        { name: "Ghost", models: 0, currentModels: 0 }, // nothing to show
        null,
        "Fisher & Paykel",
      ],
    });
    expect(out?.manufacturers).toEqual([
      { name: "ResMed", models: 25, currentModels: 20 },
    ]);
  });

  it("derives headline totals from the roster when the server omits them", () => {
    const out = normalizeCoverage({
      manufacturers: [
        { name: "ResMed", models: 25, currentModels: 20 },
        { name: "Sleepnet", models: 5, currentModels: 5 },
      ],
    });
    // The big number can never disagree with the rows beneath it.
    expect(out?.totals.models).toBe(30);
    expect(out?.totals.manufacturers).toBe(2);
  });

  it("nulls a missing child count rather than reporting it as zero", () => {
    const out = normalizeCoverage({
      manufacturers: [{ name: "ResMed", models: 25, currentModels: 20 }],
      totals: { models: 25, sizeVariants: null, components: 244 },
    });
    expect(out?.totals.sizeVariants).toBeNull();
    expect(out?.totals.components).toBe(244);
  });

  it("ignores a non-string lastUpdatedAt", () => {
    const out = normalizeCoverage({ ...LIVE_BODY, lastUpdatedAt: 1699999999 });
    expect(out?.lastUpdatedAt).toBeNull();
  });
});

describe("interfaceLabel", () => {
  it("maps the known catalog interface types to prose", () => {
    expect(interfaceLabel("full_face")).toBe("Full face");
    expect(interfaceLabel("nasal_pillow")).toBe("Nasal pillow");
    expect(interfaceLabel("total_face")).toBe("Total face");
  });

  it("title-cases a type added to the catalog after this deploy", () => {
    expect(interfaceLabel("oro_nasal")).toBe("Oro nasal");
  });
});

describe("FALLBACK_COVERAGE", () => {
  it("is internally consistent — the roster sums to the headline total", () => {
    const summed = FALLBACK_COVERAGE.manufacturers.reduce(
      (n, m) => n + m.models,
      0,
    );
    expect(summed).toBe(FALLBACK_COVERAGE.totals.models);
    expect(FALLBACK_COVERAGE.manufacturers).toHaveLength(
      FALLBACK_COVERAGE.totals.manufacturers,
    );
  });

  it("splits the headline total into current + discontinued exactly", () => {
    const { currentModels, discontinuedModels, models } =
      FALLBACK_COVERAGE.totals;
    expect(currentModels + discontinuedModels).toBe(models);
  });

  it("never claims more current models than a manufacturer carries", () => {
    for (const m of FALLBACK_COVERAGE.manufacturers) {
      expect(m.currentModels).toBeLessThanOrEqual(m.models);
    }
  });

  it("interface-type counts sum to the headline model total", () => {
    const summed = FALLBACK_COVERAGE.interfaceTypes.reduce(
      (n, t) => n + t.models,
      0,
    );
    expect(summed).toBe(FALLBACK_COVERAGE.totals.models);
  });

  it("survives its own parser — the snapshot is a valid payload", () => {
    expect(normalizeCoverage(FALLBACK_COVERAGE)).toEqual(FALLBACK_COVERAGE);
  });
});

describe("summariseManufacturers", () => {
  const roster = (n: number) =>
    Array.from({ length: n }, (_, i) => ({
      name: `M${i + 1}`,
      models: n - i,
      currentModels: n - i,
    }));

  it("names the first few and counts the rest", () => {
    expect(summariseManufacturers(roster(10))).toBe(
      "M1, M2, M3 and M4, plus 6 more",
    );
  });

  it("drops the 'plus N more' clause when nothing is left over", () => {
    expect(summariseManufacturers(roster(4))).toBe("M1, M2, M3 and M4");
  });

  it("reads correctly for a two-manufacturer roster", () => {
    expect(summariseManufacturers(roster(2))).toBe("M1 and M2");
  });

  it("emits no stray conjunction for a single manufacturer", () => {
    expect(summariseManufacturers(roster(1))).toBe("M1");
  });

  it("returns an empty string for an empty roster so the caller can bail", () => {
    expect(summariseManufacturers([])).toBe("");
  });

  it("summarises the shipped snapshot into a readable clause", () => {
    expect(summariseManufacturers(FALLBACK_COVERAGE.manufacturers)).toBe(
      "ResMed, Philips Respironics, Fisher & Paykel and React Health, plus 6 more",
    );
  });
});
