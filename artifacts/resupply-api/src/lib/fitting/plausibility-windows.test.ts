/**
 * The plausibility windows, held to ground truth.
 *
 * Every window in this repository decides one thing: whether a set of
 * millimetres is a real face or a measurement failure. Get a bound wrong
 * and the failure is silent and one-directional — a real patient is told
 * their face is out of range and handed off to a human, and nobody ever
 * sees a bug report, because from the outside it looks exactly like the
 * feature working.
 *
 * So the windows are pinned to the one face whose millimetres are known
 * exactly: MediaPipe's canonical face model — the metric reference mesh
 * the landmark indices are themselves defined against
 * (google-ai-edge/mediapipe, Apache-2.0), the same fixture the
 * measurement math is verified against in cpap-fitter's
 * `face-measurements.accuracy.test.ts`.
 *
 * The assertion is not merely "the average adult face is inside the
 * window" — a bound sitting 0.6 mm above the average passes that and is
 * still broken. It is "inside with enough room for a real patient",
 * where the room needed is:
 *
 *   * ±18% of population spread (facial dimensions run SD ≈ 6% of the
 *     mean, so ±3 SD ≈ ±18%), and
 *   * 7% of pipeline error — the verified worst case for
 *     `extractMeasurementValues` across a 28–55 cm capture distance and
 *     a true camera FOV of 55–85°.
 *
 * Both historical defects fail this one assertion: the adult
 * `noseToChin` ceiling of 90 mm cleared the canonical average by 0.7%,
 * and the pediatric `noseToChin` / `faceWidthAtCheekbones` ceilings sat
 * BELOW it entirely — because they were set below the adult ceilings,
 * which is backwards for a population that includes 17-year-olds.
 */

import { describe, expect, it } from "vitest";

import {
  ADULT_PLAUSIBILITY_BOUNDS,
  PEDIATRIC_PLAUSIBILITY_BOUNDS,
  PLAUSIBILITY_FIELDS,
  UNION_PLAUSIBILITY_BOUNDS,
  measurementsOutOfBounds,
  type PlausibilityField,
} from "./confidence.js";

/**
 * Vertices of MediaPipe's `canonical_face_model.obj` (centimetres →
 * millimetres), keyed by landmark index. Frame: +y up, +z toward the
 * camera, origin mid-head. Only the vertices the five measured spans
 * touch are reproduced here.
 */
const CANONICAL_FACE_MM: Record<number, readonly [number, number, number]> = {
  4: [0, -4.63, 75.87], // nose tip
  6: [0, 24.73, 57.89], // nose bridge
  61: [-24.56, -43.43, 42.84], // left mouth corner
  129: [-17.86, -9.78, 48.5], // left alar
  152: [0, -94.03, 42.64], // chin (menton)
  234: [-76.64, 6.73, -24.36], // left face side
  291: [24.56, -43.43, 42.84], // right mouth corner
  358: [17.86, -9.78, 48.5], // right alar
  454: [76.64, 6.73, -24.36], // right face side
};

/**
 * The landmark pairs the production extractor measures
 * (`MEASUREMENT_LANDMARKS` in cpap-fitter's face-measurements.ts). Held
 * here rather than imported — it lives in the other workspace — so a
 * change to a pair shows up as a diff against this table.
 */
const MEASURED_PAIRS: Record<PlausibilityField, readonly [number, number]> = {
  noseWidth: [129, 358],
  noseHeight: [6, 4],
  noseToChin: [4, 152],
  mouthWidth: [61, 291],
  faceWidthAtCheekbones: [234, 454],
};

/** Frontal (x/y-plane) span between two canonical vertices, mm — what a
 * head-on capture of this face actually presents to the camera. */
function frontalSpanMm(a: number, b: number): number {
  const [ax, ay] = CANONICAL_FACE_MM[a]!;
  const [bx, by] = CANONICAL_FACE_MM[b]!;
  return Math.hypot(ax - bx, ay - by);
}

/** The canonical average adult face, as this pipeline measures it. */
const CANONICAL_ADULT = Object.fromEntries(
  PLAUSIBILITY_FIELDS.map((field) => [
    field,
    frontalSpanMm(...MEASURED_PAIRS[field]),
  ]),
) as Record<PlausibilityField, number>;

/** ±3 SD of adult population spread at SD ≈ 6% of the mean. */
const POPULATION_SPREAD = 0.18;
/** Verified worst-case error of `extractMeasurementValues`. */
const PIPELINE_WORST_CASE_ERROR = 0.07;
/** What a window must clear the canonical average by, on each edge. */
const REQUIRED_MARGIN = POPULATION_SPREAD + PIPELINE_WORST_CASE_ERROR;

const WINDOWS = {
  adult: ADULT_PLAUSIBILITY_BOUNDS,
  pediatric: PEDIATRIC_PLAUSIBILITY_BOUNDS,
  "adult ∪ pediatric": UNION_PLAUSIBILITY_BOUNDS,
} as const;

describe("the canonical face fits every plausibility window", () => {
  // This is the test. Everything below it is a more specific statement
  // of a way it can fail.
  it.each(Object.entries(WINDOWS))(
    "%s: clears the canonical average adult by ≥25% on both edges",
    (_name, window) => {
      for (const field of PLAUSIBILITY_FIELDS) {
        const truth = CANONICAL_ADULT[field];
        const [min, max] = window[field];

        expect(truth, `${field} floor`).toBeGreaterThan(min);
        expect(truth, `${field} ceiling`).toBeLessThan(max);

        // The margin is relative to the measurement itself: what has to
        // fit in it is a percentage of the span, not a fixed millimetre.
        expect(
          (truth - min) / truth,
          `${field}: floor ${min} mm is too close under the canonical ${truth.toFixed(1)} mm`,
        ).toBeGreaterThanOrEqual(REQUIRED_MARGIN);
        expect(
          (max - truth) / truth,
          `${field}: ceiling ${max} mm is too close over the canonical ${truth.toFixed(1)} mm`,
        ).toBeGreaterThanOrEqual(REQUIRED_MARGIN);
      }
    },
  );

  it("admits the canonical face under both populations, through the real predicate", () => {
    // The margin arithmetic above is only meaningful if the window it
    // reasons about is the one `resolveConfidence` actually consults.
    expect(measurementsOutOfBounds(CANONICAL_ADULT, "adult")).toBe(false);
    expect(measurementsOutOfBounds(CANONICAL_ADULT, "pediatric")).toBe(false);
  });

  it("still rejects measurements that are not a face", () => {
    // The windows exist to catch a bad iris calibration, which rescales
    // every span together. Recalibrating them must not have made them
    // permissive: half-scale and double-scale are both out.
    for (const factor of [0.5, 2]) {
      const scaled = Object.fromEntries(
        PLAUSIBILITY_FIELDS.map((f) => [f, CANONICAL_ADULT[f] * factor]),
      );
      expect(measurementsOutOfBounds(scaled, "adult"), `×${factor}`).toBe(true);
      expect(measurementsOutOfBounds(scaled, "pediatric"), `×${factor}`).toBe(
        true,
      );
    }
  });
});

describe("the pediatric window is the adult window with a lower floor", () => {
  it("never sets a ceiling below the adult one", () => {
    // "Pediatric" is age < 18 (fit-assess derives it from the chart's
    // date of birth), and a 17-year-old has an adult-sized face. A
    // pediatric ceiling below the adult one rejects them — which is
    // exactly what a 70 mm noseToChin and a 150 mm faceWidth did.
    for (const field of PLAUSIBILITY_FIELDS) {
      expect(
        PEDIATRIC_PLAUSIBILITY_BOUNDS[field][1],
        `${field} pediatric ceiling`,
      ).toBe(ADULT_PLAUSIBILITY_BOUNDS[field][1]);
    }
  });

  it("lowers every floor, so a small child is not a measurement failure", () => {
    for (const field of PLAUSIBILITY_FIELDS) {
      expect(
        PEDIATRIC_PLAUSIBILITY_BOUNDS[field][0],
        `${field} pediatric floor`,
      ).toBeLessThan(ADULT_PLAUSIBILITY_BOUNDS[field][0]);
    }
  });

  it("makes the union window exactly the pediatric one", () => {
    // Superset ⇒ the union the population-blind callers apply (the
    // public /api/recommend guard, the fitter-invite ingest, the
    // client's /measure gate) collapses to the pediatric window. Derived,
    // not transcribed — three hand-copies is how these drifted apart.
    for (const field of PLAUSIBILITY_FIELDS) {
      expect(UNION_PLAUSIBILITY_BOUNDS[field], field).toEqual(
        PEDIATRIC_PLAUSIBILITY_BOUNDS[field],
      );
    }
  });

  it("covers every measured span, and nothing it cannot measure", () => {
    // A sixth measurement added without a window would otherwise be
    // silently unvalidated.
    expect(new Set(PLAUSIBILITY_FIELDS)).toEqual(
      new Set(Object.keys(MEASURED_PAIRS)),
    );
    expect(new Set(Object.keys(PEDIATRIC_PLAUSIBILITY_BOUNDS))).toEqual(
      new Set(PLAUSIBILITY_FIELDS),
    );
  });
});

describe("the canonical face is what the anthropometry says it is", () => {
  it("measures an average adult through the production landmark pairs", () => {
    // If a landmark index were wrong — a cheek read as an alar, an
    // eyelid as a mouth corner — the span would move far enough that the
    // windows above would be calibrated to the wrong thing entirely.
    expect(CANONICAL_ADULT.noseWidth).toBeCloseTo(35.7, 1);
    expect(CANONICAL_ADULT.noseHeight).toBeCloseTo(29.4, 1);
    expect(CANONICAL_ADULT.noseToChin).toBeCloseTo(89.4, 1);
    expect(CANONICAL_ADULT.mouthWidth).toBeCloseTo(49.1, 1);
    expect(CANONICAL_ADULT.faceWidthAtCheekbones).toBeCloseTo(153.3, 1);
  });
});
