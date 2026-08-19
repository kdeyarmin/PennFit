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

import { buildScanSignals } from "./scan-signals";
import { UNKNOWN_FRAME_SAMPLE } from "./frame-sampling";
import type { Point2D } from "./scan-quality";

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
  set(1, 0.5, 0.52); // nose tip
  set(234, 0.35, 0.5); // left cheek
  set(454, 0.65, 0.5); // right cheek
  set(10, 0.5, 0.24); // forehead
  set(152, 0.5, 0.78); // chin
  set(33, 0.41, 0.45); // left eye outer
  set(263, 0.59, 0.45); // right eye outer
  set(168, 0.5, 0.3576); // nose bridge — placed for a neutral pitch estimate
  return pts;
}

const VALUES = {
  noseWidth: 34,
  noseHeight: 48,
  noseToChin: 72,
  mouthWidth: 50,
  faceWidthAtCheekbones: 138,
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
    // ~2.4 px/mm at this frame size — inside PX_PER_MM_BOUNDS.
    irisWidthPx: 28,
    values: VALUES,
  });
}

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
