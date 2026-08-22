/**
 * The static fallback catalog's size bands, held to the same coverage
 * rule as the DB catalog's.
 *
 * `staticCatalogAsMasks` is what the engine runs on when the database is
 * unreachable or a tenant has not enabled the DB catalog. It partitions
 * each legacy entry's fit range into that model's sizes — and because
 * every legacy entry now carries the canonical-face ±18% envelope, a
 * partition of the envelope ALONE would leave the plausibility tails
 * uncovered: an adult with a 25 mm nose width or a 60 mm nose-to-chin
 * passes `measurementsOutOfBounds`, yet would sit outside every band of
 * every mask, so `runTiers` would report `outsideValidatedRange` and,
 * under confidence gating, withhold a fitting the DB path would size
 * without complaint. The DB bands run their edge sizes out to the
 * plausibility window (0511's outer-edge rule); this file pins that the
 * fallback adapter does the same.
 */

import { describe, expect, it } from "vitest";

import { staticCatalogAsMasks } from "./catalog-store.js";
import { ADULT_PLAUSIBILITY_BOUNDS } from "./confidence.js";
import { scoreFacialFit, scoreVariant } from "./tiers.js";
import type { FitMeasurements } from "./types.js";

const MASKS = staticCatalogAsMasks();

/** The dimension a static mask's bands gate on, per its interface. */
function gatedAxis(m: (typeof MASKS)[number]): "noseWidth" | "noseToChin" {
  return m.interfaceType === "nasal" || m.interfaceType === "nasal_pillow"
    ? "noseWidth"
    : "noseToChin";
}

describe("static fallback bands run out to the plausibility window", () => {
  it.each(MASKS.map((m) => m.slug))("%s", (slug) => {
    const mask = MASKS.find((m) => m.slug === slug)!;
    const axis = gatedAxis(mask);
    const [lo, hi] = ADULT_PLAUSIBILITY_BOUNDS[axis];
    const mins = mask.variants.map((v) =>
      axis === "noseWidth" ? v.noseWidthMin : v.noseToChinMin,
    );
    const maxes = mask.variants.map((v) =>
      axis === "noseWidth" ? v.noseWidthMax : v.noseToChinMax,
    );
    expect(Math.min(...mins.map((v) => v ?? Infinity))).toBe(lo);
    expect(Math.max(...maxes.map((v) => v ?? -Infinity))).toBe(hi);
  });

  it("a plausible tail face lands in a band on every mask", () => {
    // The exact case the envelope-only partition dropped: inside the
    // adult window, outside the ±18% envelope.
    const tail: FitMeasurements = {
      noseWidth: 25,
      noseHeight: 20,
      noseToChin: 60,
      mouthWidth: 33,
      faceWidthAtCheekbones: 120,
    };
    for (const mask of MASKS) {
      const inBand = mask.variants.some(
        (v) => scoreVariant(v, tail)?.inBand === true,
      );
      expect(inBand, mask.slug).toBe(true);
    }
  });

  it("every 0.1 mm of the window lands in some band, per mask", () => {
    for (const mask of MASKS) {
      const axis = gatedAxis(mask);
      const [lo, hi] = ADULT_PLAUSIBILITY_BOUNDS[axis];
      const spans = mask.variants
        .map((v) =>
          axis === "noseWidth"
            ? ([v.noseWidthMin, v.noseWidthMax] as const)
            : ([v.noseToChinMin, v.noseToChinMax] as const),
        )
        .filter((s): s is readonly [number, number] => s[0] !== null);
      for (let x = lo; x <= hi + 1e-9; x = Math.round((x + 0.1) * 10) / 10) {
        const covered = spans.some(([a, b]) => a - 1e-9 <= x && x <= b + 1e-9);
        expect(covered, `${mask.slug} ${axis} at ${x}`).toBe(true);
      }
    }
  });
});

describe("static fallback magnet flags mirror the 0492 audit", () => {
  // Migration 0492's manufacturer-sourced corrections, restated for the
  // static catalog's id space. Deriving `hasMagneticComponents` from the
  // entries' marketing text got BOTH directions wrong: these four
  // magnetic masks carry no "magnet" wording at all…
  const MAGNETIC_WITHOUT_MAGNET_COPY = [
    "resmed-airfit-f30", // FDA Class I recall list
    "resmed-airfit-f40", // ResMed IFU: magnets in frame + lower clips
    "philips-amara-view", // Philips 6 Sep 2022 field safety notice
    "philips-dreamwear-ff", // Philips 6 Sep 2022 field safety notice
  ];
  // …and these are flagged magnetic by their own copy, correctly.
  const MAGNETIC_WITH_MAGNET_COPY = [
    "resmed-airfit-f20",
    "resmed-airtouch-f20",
    "resmed-airfit-n20",
    "resmed-airtouch-n20",
    "resmed-airfit-f30i",
    "philips-dreamwisp",
    "react-health-numa-full-face", // unverified — err toward exclusion
  ];

  const bySlug = new Map(MASKS.map((m) => [m.slug, m]));

  it.each([...MAGNETIC_WITHOUT_MAGNET_COPY, ...MAGNETIC_WITH_MAGNET_COPY])(
    "%s is flagged magnetic",
    (slug) => {
      const mask = bySlug.get(slug);
      // Existence is part of the pin: a typo in the override map must
      // fail here, not silently guard nothing.
      expect(mask, `${slug} missing from the static catalog`).toBeDefined();
      expect(mask!.hasMagneticComponents).toBe(true);
    },
  );

  it("the whole Fisher & Paykel range is magnet-free (their public statement)", () => {
    // Including the Evora Full, whose "magnetic-style clips" copy is a
    // clasp description that used to false-positive the text heuristic —
    // excluding the safest option for implant patients precisely when
    // screening is down.
    const fp = MASKS.filter((m) => m.slug.startsWith("fisher-paykel-"));
    expect(fp.length).toBeGreaterThan(0);
    for (const mask of fp) {
      expect(mask.hasMagneticComponents, mask.slug).toBe(false);
    }
  });
});

describe("static fallback wide sizes follow the 0511 convention", () => {
  const bySlug = new Map(MASKS.map((m) => [m.slug, m]));
  const bands = (
    mask: (typeof MASKS)[number],
    axis: "noseWidth" | "noseToChin",
  ) =>
    Object.fromEntries(
      mask.variants.map((v) => [
        v.sizeCode,
        axis === "noseWidth"
          ? [v.noseWidthMin, v.noseWidthMax]
          : [v.noseToChinMin, v.noseToChinMax],
      ]),
    );

  it("N30i: SW shares M's width band and W steps one bucket above M", () => {
    // 0511: "Small Wide" is a small nose height with a WIDER nose — the
    // linear ladder S < SW < M < W put a small-wide patient two sizes
    // off. On the static width-only axis, SW takes M's width bucket and
    // W the bucket above it.
    const n30i = bySlug.get("resmed-airfit-n30i")!;
    const b = bands(n30i, "noseWidth");
    expect(b.SW).toEqual(b.M);
    expect(b.W![0]).toBe(b.M![1]);
    expect(b.S![1]).toBe(b.M![0]);
  });

  it("N30i: the plain base size wins the shared bucket", () => {
    // SW and M are indistinguishable on a single width axis; the picker
    // must deterministically prefer the base cut, not depend on array
    // order.
    const n30i = bySlug.get("resmed-airfit-n30i")!;
    const mBand = bands(n30i, "noseWidth").M!;
    const mid = (mBand[0]! + mBand[1]!) / 2;
    const fit = scoreFacialFit(n30i, {
      noseWidth: mid,
      noseHeight: 29,
      noseToChin: 89,
      mouthWidth: 49,
      faceWidthAtCheekbones: 153,
    });
    expect(fit.cushion?.sizeCode).toBe("M");
    expect(fit.cushion?.inBand).toBe(true);
  });

  it("F40: Small Wide with no plain Small is an ordinary ladder step", () => {
    // 0511: "the AirFit F40 ships Small Wide / Medium / Large with no
    // plain Small, so it is an ordinary three-step ladder whose smallest
    // size merely has 'wide' in its name."
    const f40 = bySlug.get("resmed-airfit-f40")!;
    const b = bands(f40, "noseToChin");
    expect(b.SW![1]).toBe(b.M![0]);
    expect(b.M![1]).toBe(b.L![0]);
  });

  it("DreamWear FF: MW shares M's nose-to-chin band — wide is not taller", () => {
    const dreamwearFf = bySlug.get("philips-dreamwear-ff")!;
    const b = bands(dreamwearFf, "noseToChin");
    expect(b.MW).toEqual(b.M);
    expect(b.M![1]).toBe(b.L![0]);
  });
});
