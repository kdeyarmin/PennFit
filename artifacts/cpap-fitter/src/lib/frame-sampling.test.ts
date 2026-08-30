// @vitest-environment jsdom
//
// The one module in the scan pipeline that touches pixels.
//
// Everything downstream of it — the lighting check, the sharpness
// check, the coach lines, the confidence band — is a pure function of
// the four numbers this module returns, and every one of those numbers
// is a statistic over a crop nobody can inspect afterwards. So a defect
// here is invisible: a face box off by a factor of two, or a left/right
// split computed on the wrong axis, does not throw and does not look
// wrong. It quietly tells a patient to fix lighting that was fine.
//
// Two properties carry the weight:
//
//   * it must never throw. A patient mid-fitting cannot lose their
//     recommendation because a quality probe could not read a canvas —
//     an unreadable frame degrades to NEUTRAL (score mid-range, "we
//     don't know"), never to a good or a bad scan.
//   * it must return scalars and nothing else. This is the boundary the
//     repo's "camera images never leave the browser" rule is enforced
//     at; a crop or a data URL added to the return type would flow
//     straight into the payload the fitter transmits.

import { afterEach, describe, expect, it, vi } from "vitest";

import { sampleFrame, UNKNOWN_FRAME_SAMPLE } from "./frame-sampling";
import type { Point2D } from "./scan-quality";

type Rgb = readonly [number, number, number];

/** A synthetic frame: a colour for any source pixel. */
interface FakeImage {
  width: number;
  height: number;
  pixels: (x: number, y: number) => Rgb;
}

function fakeImage(
  width: number,
  height: number,
  pixels: (x: number, y: number) => Rgb,
): FakeImage {
  return { width, height, pixels };
}

interface DrawnCrop {
  img: FakeImage;
  sx: number;
  sy: number;
  sw: number;
  sh: number;
  dw: number;
  dh: number;
}

/**
 * Stand in for a 2D context, because jsdom has none.
 *
 * It is a real resampler rather than a canned buffer: `drawImage`
 * records the crop rectangle the module asked for and `getImageData`
 * renders it by sampling the source. That is what makes the face-box
 * arithmetic testable at all — if `sampleFrame` cropped the wrong
 * region, a canned buffer would happily return the expected numbers.
 */
function installCanvas(
  mode: "ok" | "no-context" | "throws-on-read" = "ok",
): void {
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(
    function (this: HTMLCanvasElement) {
      if (mode === "no-context") return null;
      let drawn: DrawnCrop | null = null;
      const ctx = {
        drawImage(
          img: FakeImage,
          sx: number,
          sy: number,
          sw: number,
          sh: number,
          _dx: number,
          _dy: number,
          dw: number,
          dh: number,
        ) {
          drawn = { img, sx, sy, sw, sh, dw, dh };
        },
        getImageData(_x: number, _y: number, w: number, h: number) {
          if (mode === "throws-on-read") {
            throw new Error("tainted canvas");
          }
          const data = new Uint8ClampedArray(w * h * 4);
          const crop = drawn as DrawnCrop | null;
          for (let y = 0; y < h; y++) {
            for (let x = 0; x < w; x++) {
              const rgb: Rgb = crop
                ? crop.img.pixels(
                    Math.floor(crop.sx + ((x + 0.5) / crop.dw) * crop.sw),
                    Math.floor(crop.sy + ((y + 0.5) / crop.dh) * crop.sh),
                  )
                : [0, 0, 0];
              const p = (y * w + x) * 4;
              data[p] = rgb[0];
              data[p + 1] = rgb[1];
              data[p + 2] = rgb[2];
              data[p + 3] = 255;
            }
          }
          return { data, width: w, height: h };
        },
      };
      return ctx as unknown as CanvasRenderingContext2D;
    } as never,
  );
}

/** Landmarks bounding a box of exactly `size` source pixels at (x, y). */
function boxLandmarks(
  x: number,
  y: number,
  size: number,
  frame: number,
): Point2D[] {
  return [
    { x: x / frame, y: y / frame },
    { x: (x + size) / frame, y: (y + size) / frame },
  ];
}

const FRAME = 400;
/** 96 px is `sampleFrame`'s own TARGET, so the crop resamples 1:1. */
const BOX = 96;
const GREY: Rgb = [100, 100, 100];

afterEach(() => {
  vi.restoreAllMocks();
});

describe("sampleFrame — degrading to neutral", () => {
  it("returns the neutral sample when the canvas has no 2D context", () => {
    installCanvas("no-context");
    const sample = sampleFrame(
      fakeImage(FRAME, FRAME, () => GREY) as never,
      boxLandmarks(100, 100, BOX, FRAME),
    );
    expect(sample).toEqual(UNKNOWN_FRAME_SAMPLE);
  });

  it("returns the neutral sample when reading pixels throws", () => {
    // A tainted canvas, or a browser that refuses getImageData for
    // fingerprinting reasons. Neither is a reason to fail a fitting.
    installCanvas("throws-on-read");
    const sample = sampleFrame(
      fakeImage(FRAME, FRAME, () => GREY) as never,
      boxLandmarks(100, 100, BOX, FRAME),
    );
    expect(sample).toEqual(UNKNOWN_FRAME_SAMPLE);
  });

  it("returns the neutral sample for no landmarks and for a degenerate box", () => {
    installCanvas();
    const img = fakeImage(FRAME, FRAME, () => GREY) as never;
    expect(sampleFrame(img, [])).toEqual(UNKNOWN_FRAME_SAMPLE);
    // A "face" four pixels across is a detection artefact, not a face;
    // its luma and sharpness would be noise dressed up as measurements.
    expect(sampleFrame(img, boxLandmarks(200, 200, 4, FRAME))).toEqual(
      UNKNOWN_FRAME_SAMPLE,
    );
  });

  it("ignores non-finite landmarks rather than poisoning the box", () => {
    // A partial detection must not collapse the bounding box — the
    // remaining points still describe where the face is. This pins the
    // contract rather than the mechanism: NaN also happens to lose
    // every `<` comparison, so the explicit skip in `faceBox` is belt
    // and braces. Both are cheaper than a fitting that fails because one
    // landmark came back unset.
    installCanvas();
    const landmarks: Point2D[] = [
      ...boxLandmarks(100, 100, BOX, FRAME),
      { x: Number.NaN, y: 0.5 },
    ];
    const sample = sampleFrame(
      fakeImage(FRAME, FRAME, () => GREY) as never,
      landmarks,
    );
    expect(sample.faceLuma).toBeCloseTo(100, 0);
  });

  it("returns four numbers and nothing else — the PHI boundary", () => {
    // If a crop, a data URL, or a landmark array is ever added to this
    // return type it flows straight into the transmitted payload.
    installCanvas();
    const sample = sampleFrame(
      fakeImage(FRAME, FRAME, () => GREY) as never,
      boxLandmarks(100, 100, BOX, FRAME),
    );
    expect(Object.keys(sample).sort()).toEqual([
      "faceLuma",
      "faceLumaLeft",
      "faceLumaRight",
      "sharpness",
    ]);
    for (const value of Object.values(sample)) {
      expect(typeof value).toBe("number");
      expect(Number.isFinite(value)).toBe(true);
    }
  });
});

describe("sampleFrame — luma", () => {
  it("reports the mean luma of the face box, in Rec. 601", () => {
    installCanvas();
    const sample = sampleFrame(
      fakeImage(FRAME, FRAME, () => [200, 100, 50] as Rgb) as never,
      boxLandmarks(100, 100, BOX, FRAME),
    );
    // 0.299*200 + 0.587*100 + 0.114*50 = 124.2
    expect(sample.faceLuma).toBeCloseTo(124.2, 1);
  });

  it("measures the FACE, not the frame around it", () => {
    // The whole point of the bounding box. A dark room with a well-lit
    // face must not read as underexposed — that is the coach line that
    // sends a patient to turn on a lamp they do not need.
    installCanvas();
    const brightFaceOnDarkFrame = fakeImage(FRAME, FRAME, (x, y) =>
      x >= 100 && x < 196 && y >= 100 && y < 196
        ? ([180, 180, 180] as Rgb)
        : ([10, 10, 10] as Rgb),
    );
    const sample = sampleFrame(
      brightFaceOnDarkFrame as never,
      boxLandmarks(100, 100, BOX, FRAME),
    );
    expect(sample.faceLuma).toBeCloseTo(180, 0);
  });

  it("splits left from right, which is what catches harsh side lighting", () => {
    // The mean alone passes a face lit hard from one side; the
    // imbalance is what warps one half of the measurement, so the two
    // halves are reported separately (see scan-quality's lighting gate).
    installCanvas();
    const sideLit = fakeImage(FRAME, FRAME, (x) =>
      x < 148 ? ([40, 40, 40] as Rgb) : ([200, 200, 200] as Rgb),
    );
    const sample = sampleFrame(
      sideLit as never,
      boxLandmarks(100, 100, BOX, FRAME),
    );
    expect(sample.faceLumaLeft).toBeCloseTo(40, 0);
    expect(sample.faceLumaRight).toBeCloseTo(200, 0);
    expect(sample.faceLuma).toBeCloseTo(120, 0);
  });
});

describe("sampleFrame — sharpness", () => {
  it("scores a flat crop as zero and a detailed one well above it", () => {
    installCanvas();
    const flat = sampleFrame(
      fakeImage(FRAME, FRAME, () => GREY) as never,
      boxLandmarks(100, 100, BOX, FRAME),
    );
    // No high-frequency energy anywhere: the second derivative is zero
    // at every pixel, so its variance is too. This is what a badly
    // out-of-focus frame converges toward.
    expect(flat.sharpness).toBe(0);

    const checkerboard = sampleFrame(
      fakeImage(FRAME, FRAME, (x, y) =>
        (x + y) % 2 === 0 ? ([0, 0, 0] as Rgb) : ([255, 255, 255] as Rgb),
      ) as never,
      boxLandmarks(100, 100, BOX, FRAME),
    );
    expect(checkerboard.sharpness).toBeGreaterThan(flat.sharpness);
    // Comfortably clear of the gate's "blurred" end, so the direction of
    // the measure is pinned and not merely its sign.
    expect(checkerboard.sharpness).toBeGreaterThan(1000);
  });

  it("ranks a soft edge below a hard one", () => {
    installCanvas();
    const sharpness = (step: number) =>
      sampleFrame(
        fakeImage(FRAME, FRAME, (x) => {
          const v = Math.max(0, Math.min(255, 128 + (x - 148) * step));
          return [v, v, v] as Rgb;
        }) as never,
        boxLandmarks(100, 100, BOX, FRAME),
      ).sharpness;
    // A gentle ramp is what a blurred edge looks like; a steep one is
    // what a focused edge looks like.
    expect(sharpness(4)).toBeLessThan(sharpness(255));
  });
});
