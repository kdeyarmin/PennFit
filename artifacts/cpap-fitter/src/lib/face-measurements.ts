/**
 * Landmark set → millimetre facial measurements. Pure — no React, no
 * MediaPipe imports, no DOM — so the arithmetic that every mask
 * recommendation stands on can be unit-tested against synthetic
 * ground-truth projections (see face-measurements.accuracy.test.ts).
 *
 * Shared by the single-frame path, the one-tap burst, and every angle of
 * the guided multi-frame path, so the paths can never drift on the
 * landmark math.
 *
 * CALIBRATION. MediaPipe landmarks are normalized [0, 1]. The millimetre
 * scale comes from the iris diameter, which is remarkably consistent
 * across adults at ~11.7 mm horizontally (Forrester JV et al, "The Eye:
 * Basic Sciences in Practice", 4th ed). Both irises are used when
 * available: calibrating off a single eye lets a squint, glasses glare,
 * or a stray hair silently rescale every millimetre value; the mean of
 * two independent reads halves that error.
 *
 * PERSPECTIVE DEPTH-PLANE CORRECTION. The iris calibration fixes the
 * mm-per-pixel scale AT THE EYE PLANE. A feature closer to the camera
 * projects larger than that scale says, and a feature behind the eye
 * plane projects smaller — by (D + δ)/D, where D is the camera-to-eye
 * distance and δ the feature's depth offset. This matters most for
 * `faceWidthAtCheekbones`: landmarks 234/454 sit ~55–60 mm BEHIND the
 * eye plane (MediaPipe canonical face model), so at an arm's-length
 * 40 cm the span under-reads by ~13% — roughly 20 mm of headgear sizing
 * — and the error changes with distance (−16% at 28 cm, −9% at 55 cm).
 * The correction here rescales each span from its own depth plane back
 * to the eye plane using:
 *
 *   * δ from MediaPipe's own per-landmark z (relative depth, scaled like
 *     x — so z·imageWidth/pxPerMm ≈ millimetres), referenced to the mean
 *     iris z; and
 *   * D estimated from the iris pixel size under an assumed front-camera
 *     field of view (68° horizontal — typical selfie cameras run
 *     ~60–80°). The FOV assumption only scales the CORRECTION, not the
 *     measurement: verified against pinhole projections of the canonical
 *     model, a true FOV anywhere in 55–85° leaves every corrected span
 *     within ±7% where the uncorrected face width was off by 10–17%,
 *     and within ±2.5% when the FOV is near the assumption.
 *
 * `noseToChin` is deliberately NOT corrected: its endpoints sit ~33 mm
 * apart in depth (nose tip vs chin), the single-plane model over-corrects
 * it, and its uncorrected frontal error is already the smallest of the
 * five (≲2%) because the endpoint effects largely cancel.
 *
 * The correction is defensive by construction: it needs finite z on the
 * involved landmarks and a sane iris read, is clamped to [0.85, 1.25],
 * and any landmark set without z (older runtimes, test stubs) degrades
 * to the uncorrected value — never a throw, never NaN.
 */

/** MediaPipe normalized landmark — x/y in [0..1], z optional (relative
 * depth, x-scaled, negative toward the camera). */
export interface MeasureLandmark {
  x: number;
  y: number;
  z?: number;
}

export type ExtractionFailReason =
  | "no_face"
  // The face was found; the IRISES were not readable enough to
  // calibrate from. Split out from `no_face` because the advice is
  // different and the most common cause is specific: glare off glasses,
  // a heavy lash line, a squint against a bright screen. Telling that
  // patient to "center your face in the oval" — the no_face advice —
  // sends them to fix something that was never wrong.
  | "eyes_unreadable"
  | "iris_too_small"
  | "implausible_measurements"
  | "image_decode"
  | "image_decode_timeout"
  | "model_load_timeout"
  | "unknown";

export class ExtractionError extends Error {
  reason: ExtractionFailReason;
  constructor(reason: ExtractionFailReason, message: string) {
    super(message);
    this.reason = reason;
  }
}

/** Horizontal visible iris diameter, mm (adult mean; see header). */
export const IRIS_DIAMETER_MM = 11.7;

/**
 * Assumed horizontal field of view for the depth-correction distance
 * estimate. Front cameras typically run 60–80°; the tests bound the
 * residual error across 55–85°.
 */
export const ASSUMED_HFOV_DEG = 68;

/** Clamp on the per-span depth correction — a mis-estimated depth must
 * never move a measurement by more than this. */
export const DEPTH_CORRECTION_CLAMP = { min: 0.85, max: 1.25 } as const;

/** Depth offsets larger than this are treated as unreliable z data and
 * left uncorrected (the whole face spans ~±70 mm of the eye plane). */
export const MAX_CREDIBLE_DEPTH_OFFSET_MM = 120;

/**
 * Landmarks (normalized coordinates):
 *   Nose tip 4 · nose bridge 6 · nostrils 129/358 · mouth corners 61/291
 *   · chin 152 · cheekbones 234/454 · left iris 469/471 · right 474/476.
 */
const MEASUREMENT_LANDMARKS = {
  noseWidth: [129, 358],
  noseHeight: [6, 4],
  noseToChin: [4, 152],
  mouthWidth: [61, 291],
  // CONVENTION NOTE — "faceWidthAtCheekbones" measures the frontal
  // face-silhouette width at landmarks 234/454 (the mesh's lateral
  // outline points, roughly zygomatic-arch height, pre-auricular). On
  // the canonical model this spans ~153 mm — wider than textbook
  // caliper bizygomatic breadth. Any `face_width_min/max_mm` sizing
  // band a tenant authors must be calibrated against THIS convention
  // (silhouette width as this pipeline reports it), not against
  // caliper-measured bizygomatic norms. The 0486 catalog seed ships no
  // face-width bands, so nothing gates on this field until a tenant
  // adds bands — and they should derive them from observed fitter
  // readings, not population tables.
  faceWidthAtCheekbones: [234, 454],
} as const;

export type MeasurementKey = keyof typeof MEASUREMENT_LANDMARKS;

/** Spans whose endpoints share (approximately) one depth plane, where
 * the single-plane correction is verified to help. See header for why
 * `noseToChin` is excluded. */
const DEPTH_CORRECTED_KEYS: ReadonlySet<MeasurementKey> = new Set([
  "noseWidth",
  "noseHeight",
  "mouthWidth",
  "faceWidthAtCheekbones",
]);

const IRIS_INDICES = [469, 471, 474, 476] as const;

export interface ExtractedMeasurements {
  values: {
    noseWidth: number;
    noseHeight: number;
    noseToChin: number;
    mouthWidth: number;
    faceWidthAtCheekbones: number;
  };
  irisPix: number;
  /** Whether the perspective depth-plane correction was applied (it
   * degrades to false when the landmark set carries no usable z). */
  depthCorrected: boolean;
}

/**
 * Landmark set → millimetre values, iris-calibrated and depth-corrected.
 * Throws `ExtractionError` (no_face / iris_too_small) when the frame
 * cannot be measured.
 */
export function extractMeasurementValues(
  landmarks: MeasureLandmark[],
  img: { width: number; height: number },
): ExtractedMeasurements {
  const dist = (p1: MeasureLandmark, p2: MeasureLandmark) => {
    const dx = (p1.x - p2.x) * img.width;
    const dy = (p1.y - p2.y) * img.height;
    return Math.sqrt(dx * dx + dy * dy);
  };

  // Runtime guard, not just a type: a model bundle emitting the 468-point
  // (iris-less) mesh would make landmarks[469] undefined and crash `dist`
  // with an unhelpful "unknown" error.
  if (!landmarks[469] || !landmarks[471]) {
    throw new ExtractionError(
      "eyes_unreadable",
      "We couldn't locate your eyes precisely enough to calibrate. Please retake the photo.",
    );
  }

  const irisLeftPix = dist(landmarks[469], landmarks[471]);
  const irisRightPix =
    landmarks[474] && landmarks[476] ? dist(landmarks[474], landmarks[476]) : 0;
  const irisPix =
    irisLeftPix > 0 && irisRightPix > 0
      ? (irisLeftPix + irisRightPix) / 2
      : Math.max(irisLeftPix, irisRightPix);
  const pxPerMm = irisPix / IRIS_DIAMETER_MM;

  // pxPerMm < 1 means the iris was less than ~12 pixels across, which is
  // too small for the millimeter math to be trustworthy.
  if (pxPerMm < 1) {
    throw new ExtractionError(
      "iris_too_small",
      "Your face is too far from the camera for accurate measurement. Please move closer and try again.",
    );
  }

  // ── Depth-correction inputs (all optional — see header). ──
  const irisZ = meanFiniteZ(landmarks, IRIS_INDICES);
  // Estimated camera→eye distance from the iris angular size under the
  // assumed FOV: f_px = longAxis / (2·tan(hfov/2)); D = f_px·11.7 / irisPix.
  //
  // The LONG axis, deliberately: focal length in pixels is
  // axis-independent (square pixels), so anchoring the population FOV
  // constant to the sensor's long axis gives the SAME focal estimate
  // whether the frame arrives landscape or portrait. Anchoring it to
  // `img.width` — whichever axis that happened to be — under-estimated
  // the focal (and thus the distance) by ~44% on portrait captures, the
  // posture phones actually use, dragging nose height ~-8% and pushing
  // clamp-limited face width ~+9% (verified against pinhole projections;
  // see the portrait fixture in face-measurements.accuracy.test.ts).
  const focalPx =
    Math.max(img.width, img.height) /
    (2 * Math.tan((ASSUMED_HFOV_DEG / 2) * (Math.PI / 180)));
  const estimatedDistanceMm = (focalPx * IRIS_DIAMETER_MM) / irisPix;

  let depthCorrected = false;
  const spanMm = (key: MeasurementKey): number => {
    const [a, b] = MEASUREMENT_LANDMARKS[key];
    const pa = landmarks[a];
    const pb = landmarks[b];
    if (!pa || !pb) {
      throw new ExtractionError(
        "no_face",
        "No face detected in the image. Please try the capture again.",
      );
    }
    let mm = dist(pa, pb) / pxPerMm;
    if (
      DEPTH_CORRECTED_KEYS.has(key) &&
      irisZ !== null &&
      typeof pa.z === "number" &&
      Number.isFinite(pa.z) &&
      typeof pb.z === "number" &&
      Number.isFinite(pb.z)
    ) {
      // z is normalized on the same scale as x, so z·width is "pixels at
      // the face's depth" and dividing by pxPerMm yields millimetres.
      // Negative z = toward the camera, so a feature in front of the eye
      // plane has δ < 0 and shrinks toward truth; one behind it grows.
      const deltaMm = (((pa.z + pb.z) / 2 - irisZ) * img.width) / pxPerMm;
      if (Math.abs(deltaMm) <= MAX_CREDIBLE_DEPTH_OFFSET_MM) {
        const factor = Math.min(
          DEPTH_CORRECTION_CLAMP.max,
          Math.max(
            DEPTH_CORRECTION_CLAMP.min,
            (estimatedDistanceMm + deltaMm) / estimatedDistanceMm,
          ),
        );
        if (Number.isFinite(factor)) {
          mm *= factor;
          depthCorrected = true;
        }
      }
    }
    return Math.round(mm * 10) / 10;
  };

  return {
    values: {
      // Nose alar (nostril span) — outer alar landmarks. This is the
      // nasal-pillow base width (drives small/medium/large pillow fit).
      noseWidth: spanMm("noseWidth"),
      noseHeight: spanMm("noseHeight"),
      noseToChin: spanMm("noseToChin"),
      mouthWidth: spanMm("mouthWidth"),
      // Face width at cheekbones drives headgear strap sizing.
      faceWidthAtCheekbones: spanMm("faceWidthAtCheekbones"),
    },
    irisPix,
    depthCorrected,
  };
}

function meanFiniteZ(
  landmarks: MeasureLandmark[],
  indices: readonly number[],
): number | null {
  let sum = 0;
  let n = 0;
  for (const i of indices) {
    const z = landmarks[i]?.z;
    if (typeof z === "number" && Number.isFinite(z)) {
      sum += z;
      n += 1;
    }
  }
  return n === indices.length ? sum / n : null;
}
