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
 * plausibility window (0510's outer-edge rule); this file pins that the
 * fallback adapter does the same.
 */

import { describe, expect, it } from "vitest";

import { staticCatalogAsMasks } from "./catalog-store.js";
import { ADULT_PLAUSIBILITY_BOUNDS } from "./confidence.js";
import { scoreVariant } from "./tiers.js";
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
