/**
 * Ground-truth accuracy verification for the scan's measurement math.
 *
 * Real faces can't run in CI, but the arithmetic can be verified exactly:
 * take a face of KNOWN millimetre geometry (MediaPipe's own canonical
 * face model — the metric reference mesh the landmark indices are
 * defined against), project it through a pinhole camera at realistic
 * capture distances and fields of view, synthesize the iris landmarks at
 * their true 11.7 mm, feed the projected landmark set through the REAL
 * `extractMeasurementValues`, and compare what comes back against the
 * canonical face's true frontal spans.
 *
 * This pins three things:
 *   1. The landmark pairs measure what they claim to measure (the
 *      canonical distances sit inside anthropometric windows).
 *   2. The perspective depth-plane correction works: with it, every
 *      span stays within a few percent of truth across the coached
 *      distance range and across realistic front-camera FOVs — where
 *      the uncorrected face width was off by 10–17% (landmarks 234/454
 *      sit ~59 mm behind the iris calibration plane).
 *   3. Landmark sets WITHOUT z (older runtimes, the e2e stubs) degrade
 *      to the uncorrected arithmetic instead of breaking.
 *
 * Fixture: 13 vertices of MediaPipe's canonical_face_model.obj
 * (google-ai-edge/mediapipe, Apache-2.0), centimetres → millimetres.
 * Coordinate frame: +y up, +z toward the camera, origin mid-head.
 */

import { describe, expect, it } from "vitest";

import {
  ASSUMED_HFOV_DEG,
  ExtractionError,
  extractMeasurementValues,
  IRIS_DIAMETER_MM,
  type MeasureLandmark,
} from "./face-measurements";
import { PLAUSIBILITY_BOUNDS } from "./measure-flow";

/** Canonical face model vertices (mm). Index = MediaPipe landmark id. */
const CANONICAL: Record<number, [number, number, number]> = {
  4: [0, -4.63, 75.87], // nose tip
  6: [0, 24.73, 57.89], // nose bridge
  33: [-44.46, 26.64, 31.73], // left eye outer corner
  61: [-24.56, -43.43, 42.84], // left mouth corner
  129: [-17.86, -9.78, 48.5], // left alar
  133: [-18.56, 25.85, 37.58], // left eye inner corner
  152: [0, -94.03, 42.64], // chin (menton)
  234: [-76.64, 6.73, -24.36], // left face side
  263: [44.46, 26.64, 31.73], // right eye outer corner
  291: [24.56, -43.43, 42.84], // right mouth corner
  358: [17.86, -9.78, 48.5], // right alar
  362: [18.56, 25.85, 37.58], // right eye inner corner
  454: [76.64, 6.73, -24.36], // right face side
};

const WIDTH = 1280;
const HEIGHT = 720;

/** Mean z of the eye corners — the calibration (iris) depth plane. */
const EYE_PLANE_Z =
  (CANONICAL[33]![2] +
    CANONICAL[133]![2] +
    CANONICAL[362]![2] +
    CANONICAL[263]![2]) /
  4;

/** True frontal (x/y-plane) spans of the canonical face, mm. */
function frontalSpan(a: number, b: number): number {
  const [ax, ay] = CANONICAL[a]!;
  const [bx, by] = CANONICAL[b]!;
  return Math.hypot(ax - bx, ay - by);
}
const TRUTH = {
  noseWidth: frontalSpan(129, 358),
  noseHeight: frontalSpan(6, 4),
  noseToChin: frontalSpan(4, 152),
  mouthWidth: frontalSpan(61, 291),
  faceWidthAtCheekbones: frontalSpan(234, 454),
};

interface ProjectOptions {
  /** Camera distance to the eye plane, mm. */
  D: number;
  /** TRUE horizontal field of view of the simulated camera, degrees. */
  fovDeg: number;
  /** Strip the z channel, simulating a runtime that emits none. */
  dropZ?: boolean;
}

/**
 * Pinhole-project a set of 3D millimetre points into normalized
 * landmarks, with a MediaPipe-style z channel: relative depth on the
 * same scale as x (weak perspective about the point-set mean), negative
 * toward the camera.
 */
function project(
  points: Array<{ index: number; x: number; y: number; z: number }>,
  { D, fovDeg, dropZ = false }: ProjectOptions,
): MeasureLandmark[] {
  const f = WIDTH / 2 / Math.tan(((fovDeg / 2) * Math.PI) / 180);
  const camZ = (p: { z: number }) => D + EYE_PLANE_Z - p.z;
  const meanCamZ = points.reduce((sum, p) => sum + camZ(p), 0) / points.length;
  // 478-length array so the iris indices land where the runtime puts
  // them; untouched slots hold a benign centre point.
  const out: MeasureLandmark[] = Array.from({ length: 478 }, () => ({
    x: 0.5,
    y: 0.5,
    ...(dropZ ? {} : { z: 0 }),
  }));
  for (const p of points) {
    const cz = camZ(p);
    out[p.index] = {
      x: (p.x * f) / cz / WIDTH + 0.5,
      y: (-p.y * f) / cz / HEIGHT + 0.5,
      ...(dropZ ? {} : { z: ((cz - meanCamZ) * f) / meanCamZ / WIDTH }),
    };
  }
  return out;
}

/** The canonical measurement points plus synthetic iris landmarks: a
 * true-to-life 11.7 mm horizontal iris at each eye centre, on the eye
 * plane. */
function canonicalScene(): Array<{
  index: number;
  x: number;
  y: number;
  z: number;
}> {
  const pts = Object.entries(CANONICAL).map(([index, [x, y, z]]) => ({
    index: Number(index),
    x,
    y,
    z,
  }));
  const eyeCentre = (inner: number, outer: number) => ({
    x: (CANONICAL[inner]![0] + CANONICAL[outer]![0]) / 2,
    y: (CANONICAL[inner]![1] + CANONICAL[outer]![1]) / 2,
    z: EYE_PLANE_Z,
  });
  const left = eyeCentre(133, 33);
  const right = eyeCentre(362, 263);
  const r = IRIS_DIAMETER_MM / 2;
  pts.push(
    { index: 469, x: left.x - r, y: left.y, z: left.z },
    { index: 471, x: left.x + r, y: left.y, z: left.z },
    { index: 474, x: right.x - r, y: right.y, z: right.z },
    { index: 476, x: right.x + r, y: right.y, z: right.z },
  );
  return pts;
}

function measureAt(opts: ProjectOptions) {
  const landmarks = project(canonicalScene(), opts);
  return extractMeasurementValues(landmarks, {
    width: WIDTH,
    height: HEIGHT,
  });
}

function errPct(measured: number, truth: number): number {
  return ((measured - truth) / truth) * 100;
}

describe("landmark semantics on the canonical face", () => {
  it("each pair spans an anthropometrically plausible distance", () => {
    // The canonical model is an average adult face; if an index were
    // wrong (a cheek instead of an alar, an eyelid instead of a mouth
    // corner) the distance would fall far outside these windows.
    expect(TRUTH.noseWidth).toBeGreaterThan(28);
    expect(TRUTH.noseWidth).toBeLessThan(42); // alar width, adult mean ~32-35
    expect(TRUTH.noseHeight).toBeGreaterThan(24);
    expect(TRUTH.noseHeight).toBeLessThan(40); // bridge → tip
    expect(TRUTH.noseToChin).toBeGreaterThan(75);
    expect(TRUTH.noseToChin).toBeLessThan(105); // tip → menton
    expect(TRUTH.mouthWidth).toBeGreaterThan(42);
    expect(TRUTH.mouthWidth).toBeLessThan(60); // mouth corners, mean ~50
    expect(TRUTH.faceWidthAtCheekbones).toBeGreaterThan(135);
    expect(TRUTH.faceWidthAtCheekbones).toBeLessThan(170); // head silhouette width
  });

  it("the face-side landmarks sit far behind the iris plane — the bias the depth correction exists for", () => {
    const faceSideDepth = (CANONICAL[234]![2] + CANONICAL[454]![2]) / 2;
    expect(EYE_PLANE_Z - faceSideDepth).toBeGreaterThan(45); // ~59 mm
  });
});

describe("end-to-end accuracy through extractMeasurementValues", () => {
  const KEYS = Object.keys(TRUTH) as Array<keyof typeof TRUTH>;

  it("stays within tolerance across the coached distance range at the assumed FOV", () => {
    for (const D of [280, 400, 550]) {
      const { values, depthCorrected } = measureAt({
        D,
        fovDeg: ASSUMED_HFOV_DEG,
      });
      expect(depthCorrected).toBe(true);
      for (const key of KEYS) {
        expect(
          Math.abs(errPct(values[key], TRUTH[key])),
          `${key} at D=${D}`,
        ).toBeLessThanOrEqual(3.5);
      }
    }
  });

  it("stays bounded when the real camera FOV differs from the assumption", () => {
    // Front cameras run ~60–80°; test past both edges. The FOV error
    // only scales the CORRECTION, so residuals stay small.
    for (const fovDeg of [55, 85]) {
      for (const D of [280, 400, 550]) {
        const { values } = measureAt({ D, fovDeg });
        for (const key of KEYS) {
          expect(
            Math.abs(errPct(values[key], TRUTH[key])),
            `${key} at D=${D} FOV=${fovDeg}`,
          ).toBeLessThanOrEqual(7);
        }
      }
    }
  });

  it("documents the uncorrected face-width bias the correction removes", () => {
    for (const D of [280, 400, 550]) {
      const corrected = measureAt({ D, fovDeg: ASSUMED_HFOV_DEG });
      const raw = measureAt({ D, fovDeg: ASSUMED_HFOV_DEG, dropZ: true });
      const rawErr = errPct(
        raw.values.faceWidthAtCheekbones,
        TRUTH.faceWidthAtCheekbones,
      );
      const correctedErr = errPct(
        corrected.values.faceWidthAtCheekbones,
        TRUTH.faceWidthAtCheekbones,
      );
      // Without z the span under-reads by ~9–17% depending on distance…
      expect(rawErr, `raw bias at D=${D}`).toBeLessThanOrEqual(-8);
      // …and the correction beats it by a wide margin at every distance.
      expect(Math.abs(correctedErr)).toBeLessThan(Math.abs(rawErr) / 2);
    }
  });

  it("degrades to the uncorrected arithmetic when landmarks carry no z", () => {
    const { values, depthCorrected } = measureAt({
      D: 400,
      fovDeg: ASSUMED_HFOV_DEG,
      dropZ: true,
    });
    expect(depthCorrected).toBe(false);
    // Still sane numbers — the pre-correction behaviour, not a crash.
    expect(values.noseWidth).toBeGreaterThan(20);
    expect(values.faceWidthAtCheekbones).toBeGreaterThan(100);
  });

  it("noseToChin is measured raw — the single-plane model must not touch it", () => {
    // Its endpoints sit ~33 mm apart in depth; the midpoint model
    // over-corrects it while its raw frontal error is already ≲2%.
    const withZ = measureAt({ D: 400, fovDeg: ASSUMED_HFOV_DEG });
    const withoutZ = measureAt({
      D: 400,
      fovDeg: ASSUMED_HFOV_DEG,
      dropZ: true,
    });
    expect(withZ.values.noseToChin).toBeCloseTo(withoutZ.values.noseToChin, 1);
  });
});

describe("failure modes", () => {
  it("throws no_face when the iris landmarks are missing", () => {
    const landmarks = project(
      canonicalScene().filter((p) => p.index !== 469),
      { D: 400, fovDeg: ASSUMED_HFOV_DEG },
    );
    // Restore the filtered slot to undefined (project fills a default).
    delete (landmarks as Partial<MeasureLandmark>[])[469];
    let reason: string | null = null;
    try {
      extractMeasurementValues(landmarks, { width: WIDTH, height: HEIGHT });
    } catch (err) {
      reason = err instanceof ExtractionError ? err.reason : "wrong-type";
    }
    expect(reason).toBe("no_face");
  });

  it("throws iris_too_small when the face is too far to calibrate", () => {
    // 4 m away → the iris projects under 12 px.
    let reason: string | null = null;
    try {
      measureAt({ D: 4000, fovDeg: ASSUMED_HFOV_DEG });
    } catch (err) {
      reason = err instanceof ExtractionError ? err.reason : "wrong-type";
    }
    expect(reason).toBe("iris_too_small");
  });
});

describe("the /measure plausibility gate admits this face", () => {
  /**
   * The client's window is the one copy of the table that cannot import
   * the server's (different workspace, browser bundle), so it is pinned
   * here instead — to the same canonical face, by the same rule the
   * server's windows are held to in resupply-api's
   * `lib/fitting/plausibility-windows.test.ts`:
   *
   *   ±18% of population spread (SD ≈ 6% of the mean, ±3 SD) plus the 7%
   *   worst-case pipeline error the tests above bound.
   *
   * A window that merely CONTAINS the average adult is not enough. The
   * server's adult ceiling for `noseToChin` was 90 mm against a
   * canonical 89.4 — an ordinary face, measured correctly, was 0.6 mm
   * from being told it was out of range.
   */
  const REQUIRED_MARGIN = 0.18 + 0.07;

  it("clears the canonical average adult by ≥25% on every bound", () => {
    for (const key of Object.keys(TRUTH) as Array<keyof typeof TRUTH>) {
      const truth = TRUTH[key];
      const [min, max] = PLAUSIBILITY_BOUNDS[key];
      expect(
        (truth - min) / truth,
        `${key} floor ${min}`,
      ).toBeGreaterThanOrEqual(REQUIRED_MARGIN);
      expect(
        (max - truth) / truth,
        `${key} ceiling ${max}`,
      ).toBeGreaterThanOrEqual(REQUIRED_MARGIN);
    }
  });

  it("admits what the extractor actually returns, across the coached range", () => {
    // The end-to-end guarantee: nothing the measurement path can produce
    // from a well-captured average face may be rejected by the gate in
    // front of it.
    for (const fovDeg of [55, ASSUMED_HFOV_DEG, 85]) {
      for (const D of [280, 400, 550]) {
        const { values } = measureAt({ D, fovDeg });
        for (const key of Object.keys(TRUTH) as Array<keyof typeof TRUTH>) {
          const [min, max] = PLAUSIBILITY_BOUNDS[key];
          expect(values[key], `${key} at D=${D} FOV=${fovDeg}`).toBeGreaterThan(
            min,
          );
          expect(values[key], `${key} at D=${D} FOV=${fovDeg}`).toBeLessThan(
            max,
          );
        }
      }
    }
  });
});
