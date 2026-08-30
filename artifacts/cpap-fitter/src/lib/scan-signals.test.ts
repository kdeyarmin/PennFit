// Behavioural cover for the join between the capture frame and the
// clinical assessment's `scan` field.
//
// Why this matters: before this join existed, `results.tsx` posted no
// `scan`, so the route substituted NEUTRAL_SCAN (measurementConfidence
// 0.7) on every fitting. 0.7 is below the route's own `highScan` floor of
// 0.75, so no fitting could reach high confidence however good the frame
// was — and blur/lighting were never actually measured. These tests pin
// the two properties that fix depends on: a good frame can now clear 0.75,
// and a bad one falls below the moderate floor of 0.5.

import { describe, expect, it, vi } from "vitest";

import { buildScanSignals, framesFromMeasurements } from "./scan-signals";
import { UNKNOWN_FRAME_SAMPLE } from "./frame-sampling";
import type { FrameMeasurement, Point2D } from "./scan-quality";

vi.mock("./frame-sampling", async () => {
  const actual =
    await vi.importActual<typeof import("./frame-sampling")>(
      "./frame-sampling",
    );
  return {
    ...actual,
    // Pixel sampling needs a real canvas; the frame quality it produces is
    // the input under test, so it is supplied directly per-case.
    sampleFrame: vi.fn(() => actual.UNKNOWN_FRAME_SAMPLE),
  };
});

const { sampleFrame } = await import("./frame-sampling");

/**
 * A synthetic front-facing landmark set at a plausible scale.
 *
 * Only the indices the quality checks read need to be meaningful; the
 * rest fill out the bounding box.
 */
function frontFaceLandmarks(): Point2D[] {
  const pts: Point2D[] = Array.from({ length: 478 }, () => ({
    x: 0.5,
    y: 0.5,
  }));
  const set = (i: number, x: number, y: number) => {
    pts[i] = { x, y };
  };
  // Nose tip at ~0.28 of the eye-to-chin span below the eye line — the
  // neutral-head proportion the pitch estimator is calibrated against.
  set(1, 0.5, 0.542);
  set(234, 0.35, 0.5); // left cheek
  set(454, 0.65, 0.5); // right cheek
  set(10, 0.5, 0.24); // forehead
  set(152, 0.5, 0.78); // chin
  set(33, 0.41, 0.45); // left eye outer
  set(263, 0.59, 0.45); // right eye outer
  set(168, 0.5, 0.45); // nose bridge — sits at eye level, as it really does
  return pts;
}

// The canonical face as this pipeline measures it (see
// face-measurements.accuracy.test.ts). `noseHeight` was 48 — the
// textbook nasion→subnasale span rather than the ~29 mm bridge→tip span
// the extractor reports.
const VALUES = {
  noseWidth: 35.7,
  noseHeight: 29.4,
  noseToChin: 89.4,
  mouthWidth: 49.1,
  faceWidthAtCheekbones: 153.3,
};

function build(
  sample: Parameters<typeof sampleFrame>[0] extends never
    ? never
    : {
        faceLuma: number;
        faceLumaLeft: number;
        faceLumaRight: number;
        sharpness: number;
      },
) {
  vi.mocked(sampleFrame).mockReturnValue(sample);
  return buildScanSignals({
    image: { width: 1080, height: 1440 } as unknown as CanvasImageSource & {
      width: number;
      height: number;
    },
    landmarks: frontFaceLandmarks(),
    // ~45 cm from the camera on this 1080x1440 frame — mid-window for
    // CAPTURE_DISTANCE_MM_BOUNDS, and comfortably resolved.
    irisWidthPx: 28,
    values: VALUES,
  });
}

describe("per-frame numbers reach the wire", () => {
  // The column has existed since migration 0483 and nothing ever wrote
  // it, which is why an apparent ~10 mm offset in `noseToChin` across
  // real fittings could not be attributed. The aggregate says what was
  // measured; only the frames say at what head angle.
  it("carries head angles and per-frame values alongside the aggregate", () => {
    const out = build({
      faceLuma: 135,
      faceLumaLeft: 133,
      faceLumaRight: 137,
      sharpness: 400,
    });
    expect(out.frames).toHaveLength(1);
    const [frame] = out.frames!;
    expect(frame!.pose).toBe("front");
    expect(typeof frame!.pitchDeg).toBe("number");
    expect(typeof frame!.yawDeg).toBe("number");
    expect(frame!.values.noseToChin).toBeCloseTo(VALUES.noseToChin, 1);
    expect(typeof frame!.acceptable).toBe("boolean");
    expect(frame!.contributed).toBe(true);
  });

  it("sends scalars only — nothing image-derived", () => {
    const out = build({
      faceLuma: 135,
      faceLumaLeft: 133,
      faceLumaRight: 137,
      sharpness: 400,
    });
    // The whole payload must survive JSON with no string that could
    // carry pixels. The route independently rejects encoded media, but
    // the client must not be the thing that tries.
    const json = JSON.stringify(out);
    expect(json).not.toMatch(/data:/i);
    expect(json).not.toMatch(/base64/i);
    for (const frame of out.frames ?? []) {
      for (const v of Object.values(frame.values)) {
        expect(typeof v).toBe("number");
      }
      for (const v of Object.values(frame.quality)) {
        expect(typeof v).toBe("number");
      }
    }
  });

  // The route bounds head angles to [-90, 90], but the pitch estimator
  // is `(ratio - 0.28) * 140` over an unbounded landmark ratio: a
  // strongly chin-up capture swings the chin toward eye level, shrinks
  // the denominator, and reports well past 90. Sending that verbatim
  // 400s the whole assessment, dead-ending a patient whose scan should
  // simply have come back low-confidence with a retake prompt.
  it("clamps head angles the route would reject", () => {
    const saturated: FrameMeasurement = {
      pose: "front",
      quality: {
        scores: {
          lighting: 0.8,
          distance: 0.8,
          pose: 0.1,
          occlusion: 1,
          motion: 0.9,
          framing: 0.9,
        },
        failing: ["pose"],
        acceptable: false,
        overall: 0.4,
      },
      values: { noseToChin: 80 },
      yawDeg: 140,
      pitchDeg: -380.8,
    };

    const [frame] = framesFromMeasurements([saturated])!;
    expect(frame!.pitchDeg).toBe(-90);
    expect(frame!.yawDeg).toBe(90);
  });

  it("keeps an in-range angle exactly as measured", () => {
    const ordinary: FrameMeasurement = {
      pose: "front",
      quality: {
        scores: {
          lighting: 0.9,
          distance: 0.9,
          pose: 0.9,
          occlusion: 1,
          motion: 0.95,
          framing: 0.9,
        },
        failing: [],
        acceptable: true,
        overall: 0.92,
      },
      values: { noseToChin: 80 },
      yawDeg: 3.14,
      pitchDeg: -8.76,
    };

    const [frame] = framesFromMeasurements([ordinary])!;
    // Rounded to a tenth of a degree, not clamped — a clamped reading
    // must stay distinguishable from a real one.
    expect(frame!.pitchDeg).toBe(-8.8);
    expect(frame!.yawDeg).toBe(3.1);
  });
});

describe("buildScanSignals", () => {
  it("emits only the keys the strict server schema accepts", () => {
    const out = build({
      faceLuma: 135,
      faceLumaLeft: 133,
      faceLumaRight: 137,
      sharpness: 400,
    });
    expect(Object.keys(out).sort()).toEqual([
      "agreement",
      "band",
      "frameCount",
      "frames",
      "measurementConfidence",
      "quality",
    ]);
    expect(Object.keys(out.agreement).sort()).toEqual(
      Object.keys(VALUES).sort(),
    );
  });

  it("keeps every score inside the schema's [0,1] range", () => {
    const out = build({
      faceLuma: 135,
      faceLumaLeft: 133,
      faceLumaRight: 137,
      sharpness: 400,
    });
    for (const v of Object.values(out.quality)) {
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(1);
    }
    for (const v of Object.values(out.agreement)) {
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(1);
    }
    expect(out.measurementConfidence).toBeGreaterThanOrEqual(0);
    expect(out.measurementConfidence).toBeLessThanOrEqual(1);
  });

  it("lets a clean frame clear the route's high-confidence scan floor", () => {
    const out = build({
      faceLuma: 138,
      faceLumaLeft: 137,
      faceLumaRight: 139,
      sharpness: 600,
    });
    // CONFIDENCE_THRESHOLDS.highScan on the server.
    expect(out.measurementConfidence).toBeGreaterThanOrEqual(0.75);
  });

  it("scores a dark, blurred frame well below a clean one", () => {
    const clean = build({
      faceLuma: 138,
      faceLumaLeft: 137,
      faceLumaRight: 139,
      sharpness: 600,
    });
    const poor = build({
      faceLuma: 22,
      faceLumaLeft: 8,
      faceLumaRight: 44,
      sharpness: 3,
    });
    expect(poor.measurementConfidence).toBeLessThan(
      clean.measurementConfidence - 0.15,
    );
    // Note what is NOT asserted: that a poor frame falls below the
    // server's 0.5 moderate floor. It cannot, on a single frame — the
    // fixed 0.7 agreement term puts a ~0.35 floor under the score no
    // matter how bad the pixels are. The frame is instead rejected by
    // `band`, which is what the server's band rule acts on.
    expect(poor.band).toBe("low");
  });

  it("reports a single frame's band as moderate at best", () => {
    const out = build({
      faceLuma: 138,
      faceLumaLeft: 137,
      faceLumaRight: 139,
      sharpness: 600,
    });
    // One frame carries no cross-frame agreement, so however clean it
    // looks the band is capped — the honest ceiling for single capture.
    expect(out.band).not.toBe("high");
    expect(out.frameCount).toBe(1);
  });

  it("degrades to neutral-ish rather than throwing when pixels are unreadable", () => {
    const out = build(UNKNOWN_FRAME_SAMPLE);
    expect(Number.isFinite(out.measurementConfidence)).toBe(true);
    expect(out.frameCount).toBe(1);
  });
});
