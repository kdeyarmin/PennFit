/**
 * Scan quality assessment — pure, no React, no MediaPipe imports.
 *
 * Today the capture step has three coarse checks: is there a face, is the
 * iris big enough, and are the resulting millimetres plausible. Everything
 * else — bad light, a turned head, a hand across the chin, motion blur,
 * hair over the eyebrows — produces a confident-looking measurement from a
 * bad frame, which is the worst failure mode available to a fitting
 * system.
 *
 * This module turns a set of landmarks + a luma sample into per-check
 * scores in [0, 1], and turns a run of accepted frames into a single
 * measurement confidence. It takes plain numbers so it can be unit-tested
 * without a camera or a WASM runtime.
 *
 * ON THE WORD "3D": this is multi-ANGLE capture, not 3D reconstruction.
 * Turning the head slightly gives cross-frame agreement — evidence that a
 * measurement is stable — and a coarse foreshortening cross-check. It does
 * not produce a depth map or a mesh, and nothing here or in the UI should
 * imply that it does. Approved vocabulary: "multi-angle capture",
 * "cross-checked measurements", "facial measurement", "measurement
 * confidence".
 */

import { ASSUMED_HFOV_DEG, IRIS_DIAMETER_MM } from "./face-measurements";

export type QualityCheck =
  | "lighting"
  | "distance"
  | "pose"
  | "occlusion"
  | "motion"
  | "framing";

export type CapturePose = "front" | "turn_left" | "turn_right";

export interface Point2D {
  x: number;
  y: number;
}

/** The minimum landmark set the quality checks need. */
export interface LandmarkSample {
  /** Normalised 0..1 landmark positions, indexed as MediaPipe emits them. */
  landmarks: Point2D[];
  /** Iris width in pixels; the existing calibration basis. */
  irisWidthPx: number;
  /** Frame dimensions in pixels. */
  frameWidth: number;
  frameHeight: number;
  /** Mean luma (0..255) over the face bounding box. */
  faceLuma: number;
  /** Mean luma of the left and right halves of the face box. */
  faceLumaLeft: number;
  faceLumaRight: number;
  /** Variance of Laplacian over a downscaled face crop; higher is sharper. */
  sharpness: number;
  /**
   * Head pose in degrees. Supplied from the facial transformation matrix
   * when MediaPipe provides one, otherwise derived geometrically by
   * `estimatePoseFromLandmarks` below.
   */
  yawDeg: number;
  pitchDeg: number;
  rollDeg: number;
}

export interface QualityResult {
  scores: Record<QualityCheck, number>;
  /** Checks currently failing, worst first. Drives the on-screen coach.
   *  Never empty while `acceptable` is false — see `assessFrameQuality`. */
  failing: QualityCheck[];
  /** Whether this frame is good enough to measure from. */
  acceptable: boolean;
  overall: number;
  /** Which way the patient needs to move when `distance` is the problem.
   *  `"farther"` when they are nearer than the window's minimum,
   *  `"closer"` otherwise — INCLUDING when the shortfall is the camera's
   *  resolution rather than their position, since coming closer is what
   *  fixes an under-resolved iris too. Null when `distance` is passing,
   *  or when no range estimate could be derived at all (no frame
   *  dimensions, no iris) and so there is nothing to advise. */
  distanceHint?: "closer" | "farther" | null;
  /** Estimated camera-to-eye distance in mm, or null when it could not
   *  be derived (no frame dimensions, no iris). Diagnostic only. */
  estimatedDistanceMm?: number | null;
}

/**
 * How fast the nose-between-cheeks asymmetry grows with true head yaw:
 * asymmetry ≈ gain · tan(yaw). Derived from the canonical face model —
 * the nose tip (landmark 1, z ≈ +75 mm) sits ~99 mm in front of the
 * cheek outline points 234/454 (z ≈ −24 mm) whose half-span is ~77 mm,
 * giving 99.1 / 76.6 ≈ 1.293 under orthographic projection.
 */
export const YAW_ASYMMETRY_TAN_GAIN = 1.293;

// MediaPipe FaceMesh landmark indices used by the checks.
const NOSE_TIP = 1;
const LEFT_CHEEK = 234;
const RIGHT_CHEEK = 454;
const FOREHEAD = 10;
const CHIN = 152;
const LEFT_EYE_OUTER = 33;
const RIGHT_EYE_OUTER = 263;
const NOSE_BRIDGE = 168;

/**
 * Camera-to-eye distance window, in millimetres — "about arm's length".
 *
 * This check used to be a raw pixels-per-millimetre window
 * (`PX_PER_MM_BOUNDS`, 1.5–3.8), and that was unsound: px/mm is a
 * function of the CAPTURE RESOLUTION as much as of the patient's
 * distance, so the window only described arm's length on the one stream
 * size it was tuned against. `getUserMedia` asks for 1280×720 with
 * `ideal`, which is a preference, not a guarantee — a device that cannot
 * serve it returns whatever it has, and the check then mis-read distance
 * in BOTH directions:
 *
 *   * at a 640-long-axis stream a patient at a correct 40 cm scored
 *     0.51 — under the 0.6 acceptance floor — so the guided capture
 *     never auto-captured (it coached "hold it at arm's length" until
 *     the struggle timer offered a way out) and the burst path showed
 *     its "taken a little far away" retake hint on every single scan;
 *   * at a 1920-long-axis stream a patient at 25–30 cm scored 0.00–0.13,
 *     rejected as "too far" when they were in fact too CLOSE; past
 *     2560 every distance failed.
 *
 * Distance in millimetres is the quantity the check was always trying to
 * express, and it is recoverable from the frame itself: the iris
 * subtends a known 11.7 mm, so its pixel width against the focal length
 * implied by the sensor's long axis gives the range. That is the same
 * estimate `face-measurements.ts` already runs for its depth-plane
 * correction, so the two now agree by construction rather than by luck.
 *
 * WHY THE BOUNDS ARE WIDER THAN THE RANGE WE ACTUALLY WANT. The estimate
 * is only as good as the field of view it assumes, and that is a
 * population constant, not a measurement: `face-measurements.ts` puts
 * real front cameras at 60–80° against its assumed 68°. The estimate
 * therefore scales by tan(θ_true/2)/tan(34°) — ×0.77 at 55°, ×1.36 at
 * 85° — so a patient at a perfectly good 550 mm on a wide 80° camera
 * reads 684 mm. Bounds drawn tightly around the range we want would
 * reject them for owning the wrong phone.
 *
 * So the window is deliberately drawn at the range we want, 250–630 mm,
 * WIDENED by that worst-case factor on each edge (250 × 0.77, 630 ×
 * 1.36). Inside 55–85° no patient genuinely at arm's length is ever
 * refused by this term. What it still catches is gross error — a phone
 * held at 10 cm, or a metre away — which is all an FOV-blind estimate
 * can honestly claim to resolve.
 *
 * The precision comes from the OTHER term instead. Iris pixel width
 * (below) needs no FOV assumption at all: it is measured, not inferred,
 * and "too far to measure" and "iris too small to calibrate from" are
 * the same physical fact. So the far end is policed by pixels and the
 * near end — the one pixels cannot speak to, since a close iris only
 * grows — by this necessarily approximate range.
 */
export const CAPTURE_DISTANCE_MM_BOUNDS = { min: 190, max: 860 } as const;

/**
 * Iris width, in pixels, at which the millimetre scale is resolved well
 * enough to score clean.
 *
 * Distance alone no longer says whether a frame is MEASURABLE: a
 * low-resolution stream puts a patient at a perfectly good 45 cm behind
 * an iris only ~14 px across, and every millimetre in the fitting is
 * that iris divided into a span — so the scale error is whatever the
 * landmark error is relative to those few pixels.
 *
 * Scored as a linear ramp to zero rather than a cliff, so an
 * under-resolved capture still measures and simply says so through the
 * confidence band. The ramp is set so the 0.6 acceptance floor lands at
 * 11.7 px — exactly where `extractMeasurementValues` throws
 * `iris_too_small` — which keeps the two gates from disagreeing about
 * whether a frame can be measured at all.
 */
export const IRIS_RESOLUTION_TARGET_PX = 19.5;

export const LUMA_BOUNDS = { min: 60, max: 210 } as const;
export const MAX_LUMA_SIDE_DELTA = 35;
export const SHARPNESS_FLOOR = 45;
export const MAX_MOTION_FRACTION = 0.008;

/**
 * Per-pose head-angle tolerances, in degrees.
 *
 * The TURN poses are deliberately looser than front on every axis.
 * Turned frames never contribute measurement samples (see
 * MEASUREMENT_YAW_LIMIT_DEG) — they are capture/consistency evidence —
 * so precision there buys nothing, while a tight window costs real
 * patients real minutes: people naturally cock their head (roll) and dip
 * their chin (pitch) as they turn, and they are doing it blind, eyes off
 * the screen. FRONT keeps the strict window: those are the frames every
 * millimetre actually comes from.
 */
export const POSE_TARGETS: Record<
  CapturePose,
  { yaw: number; yawTolerance: number; maxPitch: number; maxRoll: number }
> = {
  front: { yaw: 0, yawTolerance: 8, maxPitch: 8, maxRoll: 6 },
  turn_left: { yaw: -20, yawTolerance: 12, maxPitch: 12, maxRoll: 10 },
  turn_right: { yaw: 20, yawTolerance: 12, maxPitch: 12, maxRoll: 10 },
};

/**
 * Grace band on the pitch score, in degrees.
 *
 * The landmark fallback derives pitch from the eye-to-nose-tip /
 * eye-to-chin proportion, and that proportion varies ~±0.04 across real
 * faces — about ±5° of apparent "pitch" that is anatomy, not head
 * position. Penalising inside that band would mark ordinarily-shaped
 * faces down on every capture, so deviations under the grace are scored
 * clean and the gate engages only beyond it (a genuinely tilted head at
 * 15–20° still fails exactly as before).
 */
export const PITCH_GRACE_DEG = 6;

function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.min(1, Math.max(0, n));
}

/**
 * Estimated camera-to-eye distance in millimetres, from the iris's
 * angular size.
 *
 * Identical physics to `face-measurements.ts`'s depth-correction
 * estimate, including the LONG-axis focal anchor — pixels are square, so
 * focal length in pixels is axis-independent, and anchoring the
 * population FOV constant to `frameWidth` alone would under-estimate the
 * focal (and so the distance) by ~44% on the portrait captures phones
 * actually produce.
 *
 * Returns null when the inputs cannot support an estimate, so callers
 * degrade to "we don't know" rather than to a confident wrong number.
 */
export function estimateCameraDistanceMm(
  irisWidthPx: number,
  frameWidth: number,
  frameHeight: number,
): number | null {
  const longAxis = Math.max(frameWidth, frameHeight);
  if (
    !Number.isFinite(irisWidthPx) ||
    irisWidthPx <= 0 ||
    !Number.isFinite(longAxis) ||
    longAxis <= 0
  ) {
    return null;
  }
  const focalPx =
    longAxis / (2 * Math.tan((ASSUMED_HFOV_DEG / 2) * (Math.PI / 180)));
  const mm = (focalPx * IRIS_DIAMETER_MM) / irisWidthPx;
  return Number.isFinite(mm) ? mm : null;
}

/** Score a value inside [min, max], falling off outside it. */
function windowScore(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return 0;
  if (value >= min && value <= max) {
    const centre = (min + max) / 2;
    const half = (max - min) / 2;
    // Slight preference for the middle so the coach can nudge toward it.
    return 0.85 + 0.15 * (1 - Math.abs(value - centre) / half);
  }
  const overshoot = value < min ? min - value : value - max;
  const span = Math.max(1e-6, (max - min) * 0.5);
  return clamp01(1 - overshoot / span) * 0.7;
}

/**
 * The largest disagreement between the matrix pitch and the geometric
 * one that still reads as the same head.
 *
 * The geometric estimator is confounded by anatomy — a long chin or a
 * high nose shifts its ratio by ~±5° with the head perfectly level,
 * which is why PITCH_GRACE_DEG exists — so the two will never agree
 * exactly. But a runtime whose matrix convention differs from the one
 * assumed below (a transposed read, an inverted axis) disagrees by
 * roughly TWICE the angle: ~20° at a real 10° nod. 12° sits cleanly
 * between the two, so a wrong convention degrades to today's behaviour
 * instead of silently correcting spans the wrong way.
 */
export const MATRIX_GEO_PITCH_AGREEMENT_DEG = 12;

/** MediaPipe's 4x4 facial transformation matrix, as it arrives. */
export interface FacialTransformationMatrixLike {
  rows: number;
  columns: number;
  data: number[] | Float32Array;
}

/**
 * Head pose from MediaPipe's own transformation matrix.
 *
 * Far better than inferring pitch from landmark ratios, because it is a
 * rigid-body solve rather than a proxy: it does not care that this
 * patient's chin is long. Returns null for anything malformed — the
 * caller then keeps the geometric estimate rather than trusting a
 * partially-read matrix.
 *
 * Column-major, matching the convention tasks-vision emits (the same
 * layout THREE.js consumes directly), so element (i, j) is data[j*4+i].
 * Tait-Bryan extraction in the same yaw/pitch/roll convention the
 * geometric estimator reports, so every consumer downstream is
 * unaffected by which one produced the numbers.
 */
export function poseFromFacialTransformationMatrix(
  matrix: FacialTransformationMatrixLike | null | undefined,
): { yawDeg: number; pitchDeg: number; rollDeg: number } | null {
  if (!matrix) return null;
  const { rows, columns, data } = matrix;
  if (rows !== 4 || columns !== 4 || !data || data.length !== 16) return null;
  const m = (i: number, j: number) => Number(data[j * 4 + i]);
  const r00 = m(0, 0);
  const r10 = m(1, 0);
  const r20 = m(2, 0);
  const r21 = m(2, 1);
  const r22 = m(2, 2);
  if (![r00, r10, r20, r21, r22].every((n) => Number.isFinite(n))) return null;
  const deg = (rad: number) => (rad * 180) / Math.PI;
  return {
    yawDeg: deg(Math.atan2(-r20, Math.hypot(r00, r10))),
    pitchDeg: deg(Math.atan2(r21, r22)),
    rollDeg: deg(Math.atan2(r10, r00)),
  };
}

/**
 * The head pose to score and correct this frame with.
 *
 * Prefers the matrix, but only once it has agreed with the geometric
 * estimate about what it is looking at. The runtime's exact convention
 * is not something this codebase can verify from here, and a silently
 * transposed or sign-flipped matrix would be worse than the estimator it
 * replaces: the geometric pitch is merely noisy, while a wrong-signed
 * one would drive the depth correction in exactly the wrong direction.
 *
 * Two gates, both failing toward today's behaviour:
 *
 *   * YAW SIGN. At a meaningful turn the two must at least agree which
 *     way the head is facing. The turn steps are direction-locked off
 *     this sign, so a disagreement would break the coaching as well as
 *     the measurement.
 *   * PITCH AGREEMENT. See MATRIX_GEO_PITCH_AGREEMENT_DEG.
 *
 * `poseSource` rides on the result so the record can say which produced
 * a given frame's angles, and so the depth-aware pitch correction can
 * refuse to run on the estimate it does not trust.
 */
export function resolveFramePose(
  matrix: FacialTransformationMatrixLike | null | undefined,
  landmarks: Point2D[],
  frame?: { width: number; height: number },
): {
  yawDeg: number;
  pitchDeg: number;
  rollDeg: number;
  poseSource: "matrix" | "geometric";
} {
  const geometric = estimatePoseFromLandmarks(landmarks, frame);
  const fromMatrix = poseFromFacialTransformationMatrix(matrix);
  if (!fromMatrix) return { ...geometric, poseSource: "geometric" };

  const meaningfulYaw = Math.abs(geometric.yawDeg) > 8;
  const signsDisagree = fromMatrix.yawDeg * geometric.yawDeg < 0;
  if (meaningfulYaw && signsDisagree) {
    return { ...geometric, poseSource: "geometric" };
  }
  if (
    Math.abs(fromMatrix.pitchDeg - geometric.pitchDeg) >
    MATRIX_GEO_PITCH_AGREEMENT_DEG
  ) {
    return { ...geometric, poseSource: "geometric" };
  }
  return { ...fromMatrix, poseSource: "matrix" };
}

/**
 * Derive head pose from landmark geometry.
 *
 * A fallback for runtimes where the facial transformation matrix is not
 * available. Deliberately crude — it only needs to be good enough to tell
 * "facing the camera" from "turned 20 degrees", which is exactly what the
 * gates test.
 *
 * `frame` (the capture's pixel dimensions) matters for ROLL and only for
 * roll. Landmarks are normalised per axis, so x is divided by the frame
 * width and y by its height — a ratio of two x's (yaw) or two y's
 * (pitch) cancels that out, but roll is an `atan2` that MIXES the axes
 * and does not. Without the frame it reads `atan(aspect · tan θ)`: on a
 * 16:9 landscape stream a true 6° head tilt reports 10.6°, and a true
 * 10° tilt reports 17.4° — past the point where the pose score collapses
 * to zero and the frame is silently refused. On the portrait captures
 * phones actually produce the error runs the other way and the gate goes
 * slack, passing tilts it was written to catch. Optional so callers
 * without dimensions keep the old behaviour rather than breaking; every
 * in-app caller passes it.
 */
export function estimatePoseFromLandmarks(
  landmarks: Point2D[],
  frame?: { width: number; height: number },
): {
  yawDeg: number;
  pitchDeg: number;
  rollDeg: number;
} {
  const nose = landmarks[NOSE_TIP];
  const left = landmarks[LEFT_CHEEK];
  const right = landmarks[RIGHT_CHEEK];
  const eyeL = landmarks[LEFT_EYE_OUTER];
  const eyeR = landmarks[RIGHT_EYE_OUTER];
  const chin = landmarks[CHIN];
  const bridge = landmarks[NOSE_BRIDGE];
  if (!nose || !left || !right || !eyeL || !eyeR || !chin || !bridge) {
    return { yawDeg: 0, pitchDeg: 0, rollDeg: 0 };
  }

  // Yaw: the nose sits mid-way between the cheeks head-on, and drifts
  // toward one as the head turns — because the nose tip rides far in
  // FRONT of the cheek outline. On the canonical face model that depth
  // lever is ~99 mm against a ~77 mm cheek half-span, so the projected
  // asymmetry grows as ≈ YAW_ASYMMETRY_TAN_GAIN · tan(yaw); inverting
  // that maps the estimate back to (approximately) true degrees.
  //
  // The previous `asymmetry * 90` linearization over-reported true yaw
  // ~2–2.7x (a true 10° turn read as ~27° at arm's length — verified
  // against pinhole projections of the canonical model, see the
  // calibration test in face-measurements.accuracy.test.ts). Every
  // consumer is written in true-degree physics, so the mis-scale
  // mis-aimed all of them at once: poseCorrect's cos() over-corrected
  // vertical spans from turned frames by up to ~12%,
  // MEASUREMENT_YAW_LIMIT_DEG=10 actually cut at ~3.7° true, and the
  // "20°" turn targets accepted only ~4–13° true turns while telling a
  // patient at a genuine 20° "too far — come back". Perspective at close
  // range still inflates the inverted estimate somewhat (~+30% at
  // 40 cm) — the conservative direction for every gate that excludes
  // high-yaw frames from measuring.
  const dLeft = Math.abs(nose.x - left.x);
  const dRight = Math.abs(right.x - nose.x);
  const asymmetry = (dRight - dLeft) / Math.max(1e-6, dRight + dLeft);
  const yawDeg =
    (Math.atan(asymmetry / YAW_ASYMMETRY_TAN_GAIN) * 180) / Math.PI;

  // Roll: the tilt of the eye line, measured in PIXEL space so the
  // frame's aspect ratio cannot masquerade as head tilt (see the note on
  // `frame` above). Falls back to normalised units — i.e. an assumed
  // square frame — when no dimensions are supplied.
  const pxW = frame && frame.width > 0 ? frame.width : 1;
  const pxH = frame && frame.height > 0 ? frame.height : 1;
  const rollDeg =
    (Math.atan2((eyeR.y - eyeL.y) * pxH, (eyeR.x - eyeL.x) * pxW) * 180) /
    Math.PI;

  // Pitch: how the eye-line-to-NOSE-TIP span compares with
  // eye-line-to-chin. The nose tip projects up toward the eye line as the
  // head tilts, so the ratio moves with pitch; ~0.28 is a neutral head.
  //
  // This previously measured eye-line-to-BRIDGE — landmark 168 sits at
  // eye level, so `upper` was ~0.02 and the formula read every level face
  // as ~-30° of pitch, zeroing the pitch score on all real captures and
  // putting the high-confidence scan floor permanently out of reach.
  const eyeMidY = (eyeL.y + eyeR.y) / 2;
  const upper = Math.abs(nose.y - eyeMidY);
  const lower = Math.abs(chin.y - eyeMidY);
  const ratio = lower > 1e-6 ? upper / lower : 0;
  // ~0.28 is a neutral head; scale the deviation into degrees.
  const pitchDeg = (ratio - 0.28) * 140;

  return { yawDeg, pitchDeg, rollDeg };
}

export interface QualityInput extends LandmarkSample {
  pose: CapturePose;
  /**
   * Landmark centroid of the previous frames, for the motion check.
   * Undefined on the first frame, which scores motion as unknown-but-ok
   * rather than penalising the very first look.
   */
  previousCentroids?: Point2D[];
}

/** The centroid of a landmark set, in normalised units. */
export function centroidOf(landmarks: Point2D[]): Point2D {
  if (landmarks.length === 0) return { x: 0, y: 0 };
  let x = 0;
  let y = 0;
  for (const p of landmarks) {
    x += p.x;
    y += p.y;
  }
  return { x: x / landmarks.length, y: y / landmarks.length };
}

export function assessFrameQuality(input: QualityInput): QualityResult {
  const scores: Record<QualityCheck, number> = {
    lighting: 0,
    distance: 0,
    pose: 0,
    occlusion: 0,
    motion: 1,
    framing: 0,
  };

  // ── Lighting: overall exposure gated by left/right balance.
  //
  //    Multiplicative, not a weighted average, and that matters: harsh
  //    side light produces a textbook mean luma while blowing out one
  //    cheek, so an averaged score would pass the exact frame that warps
  //    one half of every horizontal measurement. Balance can halve the
  //    score no matter how good the exposure reads. ──
  const exposure = windowScore(
    input.faceLuma,
    LUMA_BOUNDS.min,
    LUMA_BOUNDS.max,
  );
  const sideDelta = Math.abs(input.faceLumaLeft - input.faceLumaRight);
  // At a TURN pose the balance gate is doubled, not because side light
  // stops mattering, but because turning the head MANUFACTURES imbalance
  // from perfectly even light: the far cheek rotates into its own shadow
  // and the near cheek toward the source. Holding turned frames to the
  // frontal balance bar made the turn steps nearly uncapturable in
  // ordinary rooms — and the measurement risk the strict gate guards
  // against (one warped half of a horizontal span) does not apply to
  // frames that contribute no measurement samples (see
  // MEASUREMENT_YAW_LIMIT_DEG). The leniency is therefore keyed to the
  // ACTUAL yaw, not the nominal pose: a frame still inside the
  // near-frontal measurement window WOULD contribute samples, so it is
  // held to the frontal bar even at a turn step — the relaxed gate and
  // the measurement set can never overlap.
  const turnedPastFrontal =
    input.pose !== "front" &&
    Math.abs(input.yawDeg) > MEASUREMENT_YAW_LIMIT_DEG;
  const sideAllowance = turnedPastFrontal
    ? MAX_LUMA_SIDE_DELTA * 2
    : MAX_LUMA_SIDE_DELTA;
  const balance = clamp01(1 - sideDelta / (sideAllowance * 2));
  scores.lighting = clamp01(exposure * (0.5 + 0.5 * balance));

  // ── Distance, via the iris reference already used for calibration.
  //
  //    Two independent things have to be true, and they are scored
  //    separately because they call for different instructions: the
  //    patient has to be at a workable RANGE (physical millimetres, not
  //    pixels — see CAPTURE_DISTANCE_MM_BOUNDS), and the iris has to
  //    land on enough PIXELS for the millimetre scale to mean anything
  //    (see IRIS_RESOLUTION_TARGET_PX). A 640-wide stream satisfies the
  //    first at arm's length and fails the second; a 4K stream at 15 cm
  //    does the reverse. The worse of the two is the score, because
  //    either one alone spoils the measurement. ──
  const estimatedDistanceMm = estimateCameraDistanceMm(
    input.irisWidthPx,
    input.frameWidth,
    input.frameHeight,
  );
  const rangeScore =
    estimatedDistanceMm === null
      ? 0
      : windowScore(
          estimatedDistanceMm,
          CAPTURE_DISTANCE_MM_BOUNDS.min,
          CAPTURE_DISTANCE_MM_BOUNDS.max,
        );
  const resolutionScore = clamp01(
    input.irisWidthPx / IRIS_RESOLUTION_TARGET_PX,
  );
  scores.distance = Math.min(rangeScore, resolutionScore);

  // Which way to move, keyed to WHICH TERM failed — not to the range
  // alone.
  //
  // An under-resolved iris is only ever fixed by coming closer, and on a
  // low-resolution stream it can fail while the estimated range is
  // already at or inside the near bound: at 320×240 and ~249 mm the iris
  // is ~11 px, under the calibration cliff, yet the range reads "too
  // close". Deciding on range alone told that patient to move BACK,
  // which shrinks the iris further and walks them into
  // `iris_too_small` — the one instruction guaranteed to make it worse.
  // So resolution is checked first and wins.
  let distanceHint: "closer" | "farther" | null = null;
  if (scores.distance < 0.6) {
    if (resolutionScore < 0.6) {
      distanceHint = "closer";
    } else if (
      estimatedDistanceMm !== null &&
      estimatedDistanceMm < CAPTURE_DISTANCE_MM_BOUNDS.min
    ) {
      distanceHint = "farther";
    } else if (estimatedDistanceMm !== null) {
      distanceHint = "closer";
    }
  }

  // ── Head position against this pose's target. ──
  const target = POSE_TARGETS[input.pose];
  const yawError = Math.abs(input.yawDeg - target.yaw);
  let yawScore = clamp01(1 - yawError / (target.yawTolerance * 2));
  // Hard minimum turn: a "turn" frame must actually be past the
  // near-frontal measurement window. Without this floor, good pitch/roll
  // could lift the composite pose score over the acceptance bar at ~1° of
  // real yaw — auto-capturing a straight-on frame as a completed turn
  // angle, which defeats the cross-angle evidence the step exists to
  // collect. Capped low enough that the composite cannot clear 0.6, so
  // the coach keeps saying "turn a little further" instead.
  if (input.pose !== "front" && !turnedPastFrontal) {
    yawScore = Math.min(yawScore, 0.1);
  }
  const pitchScore = clamp01(
    1 -
      Math.max(0, Math.abs(input.pitchDeg) - PITCH_GRACE_DEG) /
        (target.maxPitch * 2),
  );
  const rollScore = clamp01(1 - Math.abs(input.rollDeg) / (target.maxRoll * 2));
  scores.pose = clamp01(yawScore * 0.5 + pitchScore * 0.25 + rollScore * 0.25);

  // ── Occlusion + blur. A hand across the chin and a smeared frame both
  //    show up as missing structure, so they share a score. ──
  const required = [
    FOREHEAD,
    CHIN,
    LEFT_CHEEK,
    RIGHT_CHEEK,
    NOSE_TIP,
    NOSE_BRIDGE,
  ];
  const present = required.filter((i) => {
    const p = input.landmarks[i];
    return p && Number.isFinite(p.x) && Number.isFinite(p.y);
  }).length;
  const structure = present / required.length;
  const sharpnessScore = clamp01(input.sharpness / (SHARPNESS_FLOOR * 2));
  // Multiplicative for the same reason as lighting: every landmark being
  // present says nothing useful about a frame smeared by motion blur, and
  // averaging the two lets a sharp-looking structure score carry a
  // hopelessly soft image over the line.
  scores.occlusion = clamp01(structure * (0.4 + 0.6 * sharpnessScore));

  // ── Motion: how far the face has drifted across recent frames. ──
  if (input.previousCentroids && input.previousCentroids.length > 0) {
    const here = centroidOf(input.landmarks);
    const worst = input.previousCentroids.reduce((max, prev) => {
      const d = Math.hypot(here.x - prev.x, here.y - prev.y);
      return Math.max(max, d);
    }, 0);
    scores.motion = clamp01(1 - worst / (MAX_MOTION_FRACTION * 3));
  }

  // ── Framing: is the whole face actually inside the frame, with margin?
  //    An incomplete capture is a hard gate — we cannot measure what is
  //    off-screen, and a clipped chin silently shortens nose-to-chin. ──
  const margin = 0.03;
  const inFrame = required.every((i) => {
    const p = input.landmarks[i];
    if (!p) return false;
    return p.x > margin && p.x < 1 - margin && p.y > margin && p.y < 1 - margin;
  });
  scores.framing = inFrame ? 1 : 0;

  const failing = (Object.keys(scores) as QualityCheck[])
    .filter((k) => scores[k] < 0.6)
    .sort((a, b) => scores[a] - scores[b]);

  const weighted =
    scores.lighting * 0.2 +
    scores.distance * 0.2 +
    scores.pose * 0.25 +
    scores.occlusion * 0.15 +
    scores.motion * 0.1 +
    scores.framing * 0.1;

  // Penalise the WEAKEST check rather than reporting a clean average.
  // Quality here is a chain: a frame that is beautifully lit, perfectly
  // framed, and hopelessly out of focus is not a 0.8-quality frame, and
  // downstream confidence must not treat it as one.
  const weakest = Math.min(...Object.values(scores));
  const overall = clamp01(weighted * (0.5 + 0.5 * weakest));

  // Framing is non-negotiable; the rest must clear a floor together.
  const acceptable =
    scores.framing === 1 && failing.length === 0 && overall >= 0.6;

  // A refused frame must always name something the patient can act on.
  //
  // `failing` lists the checks under their own 0.6 floor, but acceptance
  // ALSO requires the composite to clear 0.6 — and the composite is
  // dragged down by the weakest check whether or not that check is
  // itself failing. Several checks sitting just above the floor (every
  // score at 0.62 is enough) therefore produce a refused frame with an
  // EMPTY failing list, and `coachMessage` answers an empty list with
  // "Hold it right there…". The patient then holds a frame that will
  // never be taken, perfectly still, being told they are doing it right,
  // until the struggle timer eventually offers a way out.
  //
  // So when the composite is what refused the frame, surface the weakest
  // check as the thing to improve. It is the honest answer — the weakest
  // check IS what the composite penalised — and it keeps the invariant
  // every consumer already assumes: not acceptable ⇒ something to say.
  if (!acceptable && failing.length === 0) {
    const weakestCheck = (Object.keys(scores) as QualityCheck[]).reduce(
      (worst, k) => (scores[k] < scores[worst] ? k : worst),
    );
    failing.push(weakestCheck);
  }

  return {
    scores,
    failing,
    acceptable,
    overall,
    distanceHint,
    estimatedDistanceMm,
  };
}

/** Short, specific, actionable. Shown one at a time in the live coach. */
export const COACH_COPY: Record<QualityCheck, string> = {
  lighting:
    "Find more even light — face a window or a lamp, not away from one.",
  distance: "Hold the phone about an arm's length from your face.",
  pose: "Look straight at the camera and keep your head level.",
  occlusion: "Move anything covering your face out of the way and hold steady.",
  motion: "Hold still for a moment.",
  framing: "Fit your whole face in the frame — forehead to chin.",
};

export const POSE_PROMPT: Record<CapturePose, string> = {
  front: "Look straight at the camera.",
  turn_left: "Now turn your head slightly to your left.",
  turn_right: "And now slightly to your right.",
};

/**
 * Directional coaching for a failing DISTANCE check.
 *
 * "Hold the phone about an arm's length from your face" is the same
 * sentence whether the patient is 15 cm away or 80 cm away, so it leaves
 * them guessing which way to move — and a patient mid-scan is watching
 * their own face, not reading carefully. Now that the check knows the
 * estimated range (see CAPTURE_DISTANCE_MM_BOUNDS) it can just say.
 */
export const DISTANCE_COACH_COPY = {
  closer: "A little closer — bring the phone toward you.",
  farther: "A little further back — hold the phone away from you.",
} as const;

export function coachMessage(result: QualityResult, pose: CapturePose): string {
  if (result.failing.length === 0) return "Hold it right there…";
  const worst = result.failing[0]!;
  if (worst === "distance" && result.distanceHint) {
    return DISTANCE_COACH_COPY[result.distanceHint];
  }
  return COACH_COPY[worst] ?? POSE_PROMPT[pose];
}

/**
 * Directional coaching for a failing TURN pose.
 *
 * Re-issuing "turn your head slightly" at a patient who IS turned — just
 * too far, or not far enough — tells them nothing, and they cannot study
 * the screen to work it out because their eyes are off it. This turns
 * the live yaw into the one instruction that actually helps: further,
 * back a bit, or (when the remaining step is locked to one direction and
 * they turned the other way) the other way entirely.
 *
 * Magnitude-based on purpose: each turn step accepts either physical
 * direction, so |yaw| against the target is the honest comparison and it
 * sidesteps the estimator's sign convention. The one place sign matters —
 * the direction-locked wrong-way case — compares against the SAME
 * convention `assessFrameQuality` scores with, so the two always agree.
 *
 * Returns null when yaw is inside the window (some other check is the
 * problem — let its coach line through) or on the front pose.
 */
export function turnCoachNudge(
  yawDeg: number,
  pose: CapturePose,
  directionLocked: boolean,
): string | null {
  if (pose === "front") return null;
  const target = POSE_TARGETS[pose];
  if (directionLocked && yawDeg * target.yaw < 0 && Math.abs(yawDeg) > 4) {
    return "The other way — turn toward your other shoulder.";
  }
  const magnitude = Math.abs(yawDeg);
  const targetMagnitude = Math.abs(target.yaw);
  // Under-turned covers BOTH the tolerance window's low edge and the
  // hard minimum-turn floor (a frame inside the near-frontal measurement
  // window never counts as a turn — see assessFrameQuality), so the
  // coach keeps asking for more turn everywhere the gate would refuse.
  if (
    magnitude <= MEASUREMENT_YAW_LIMIT_DEG ||
    magnitude < targetMagnitude - target.yawTolerance
  ) {
    return "Turn a little further…";
  }
  if (magnitude > targetMagnitude + target.yawTolerance) {
    return "Too far — come back toward the camera a touch.";
  }
  return null;
}

// ── Multi-frame aggregation ──────────────────────────────────────────

export interface FrameMeasurement {
  pose: CapturePose;
  quality: QualityResult;
  values: Record<string, number>;
  yawDeg: number;
  pitchDeg: number;
  /**
   * How this frame was captured — which decides what its agreement with
   * its siblings is EVIDENCE OF. See BURST_AGREEMENT_CEILING.
   *
   * Optional, and absent means "independent": a caller that does not say
   * keeps the pre-existing scoring rather than being silently discounted.
   */
  source?: "burst" | "guided";
  /**
   * Diagnostics, carried for the clinical record and read by nothing in
   * the scoring below. They exist because pose alone cannot explain a
   * span that reads short: too far away, an iris across too few pixels,
   * and a depth correction that never ran are all equally consistent
   * with it. See the fit-assess frames schema.
   */
  irisPx?: number;
  depthCorrected?: boolean;
  /** Matrix-derived head pose, or the geometric fallback. */
  poseSource?: "matrix" | "geometric";
}

export interface AggregateResult {
  measurements: Record<string, number>;
  agreement: Record<string, number>;
  quality: Record<QualityCheck, number>;
  measurementConfidence: number;
  band: "high" | "moderate" | "low";
  frameCount: number;
}

export const CONFIDENCE_BANDS = { high: 0.75, moderate: 0.5 } as const;

/**
 * The most cross-frame agreement a same-posture burst may claim.
 *
 * Placed deliberately between the two values that bracket it: a single
 * frame's fixed 0.7 ("we only looked once") and the ~1.0 that genuinely
 * consistent readings score. A burst has earned the gap — it ruled out
 * detector jitter and let a blurred frame be discarded — and cannot have
 * earned more, because every frame in it shares the same systematic
 * error. See the note in `aggregateFrames`.
 */
export const BURST_AGREEMENT_CEILING = 0.85;

/**
 * The most agreement a set of same-posture frames may claim when they
 * were not a single shutter burst.
 *
 * Between the burst ceiling and full independence, because that is
 * where the evidence sits: the guided flow's two front captures are
 * separated by a fresh steady-streak — ~540 ms of held position, a
 * blink and a hand-shake apart — so they rule out more than five frames
 * fired over 560 ms do. They still share the session's systematics: the
 * same light, the same distance, the same anatomy, the same hair across
 * the same cheek.
 */
export const SAME_POSTURE_AGREEMENT_CEILING = 0.9;

const HORIZONTAL_KEYS = new Set([
  "noseWidth",
  "mouthWidth",
  "faceWidthAtCheekbones",
]);

/**
 * Yaw beyond which a frame stops contributing MEASUREMENT samples to
 * the aggregate (it still contributes quality evidence). Two verified
 * reasons, one per axis:
 *
 *   * VERTICAL spans (noseHeight, noseToChin): the nose's own depth
 *     swings through the image plane, distorting tip-referenced heights
 *     by ~+10–18% at 20° of yaw — outside the small-angle cos model
 *     entirely (pinhole projections of the canonical face model).
 *   * HORIZONTAL spans: whether the calibration self-corrects under yaw
 *     depends on GAZE. The iris foreshortens with the head only when
 *     the eyes turn with it; a patient watching the on-screen coach
 *     counter-rotates their eyes, the iris stays camera-facing, and the
 *     width then reads ~cos(yaw) low with no way to tell the two cases
 *     apart from landmarks alone. Inside this limit the ambiguity is
 *     ≤ ~1.5% either way; at the 20° turn poses it is ~6%.
 *
 * Frames inside the limit are "front enough" to measure from. When NO
 * frame qualifies, the aggregate falls back to every frame — a fully
 * turned set still measures rather than failing.
 */
export const MEASUREMENT_YAW_LIMIT_DEG = 10;

/**
 * `noseToChin`'s depth component over its frontal length, from the
 * canonical face: the chin sits ~33 mm behind the nose tip against an
 * ~89 mm frontal span. This is the orthographic limit of the pitch
 * factor below; the fit against projected faces recovers it to within
 * 4% without being given it.
 */
const NOSE_TO_CHIN_DEPTH_RATIO = 33.23 / 89.4;

/**
 * The perspective half of the pitch factor, in millimetres, fitted
 * against pinhole projections at 280 / 400 / 550 mm. It decays as 1/D
 * because that is what perspective does — at arm's length it roughly
 * doubles the depth term, and by a metre it is a third of it.
 */
const PITCH_PERSPECTIVE_GAIN_MM = 158;

/** Used when a frame could not estimate its own camera distance. */
const NOMINAL_CAPTURE_DISTANCE_MM = 400;

/**
 * Past this the correction stops being a correction.
 *
 * The pose gate refuses frames well inside it (PITCH_GRACE_DEG plus the
 * pose target's own tolerance), so a pitch beyond 15 degrees reaching
 * here means something else is wrong — and the model would be claiming
 * a ~20% adjustment on the strength of an angle it should not trust.
 */
const PITCH_DEPTH_CORRECTION_MAX_DEG = 15;

/**
 * Correct a span for head rotation.
 *
 * The naive model — divide a horizontal span by cos(yaw) — is wrong,
 * because the iris that CALIBRATES the millimetre scale is itself a
 * circle and foreshortens by the same cos(yaw) as any horizontal span at
 * its depth. The two cancel in `span_px / pxPerMm`, so under yaw:
 *
 *   * horizontal spans are already self-corrected — dividing them by
 *     cos(yaw) again was a systematic over-correction (~+6% per frame at
 *     the 20° guided turn poses, verified against pinhole projections of
 *     the canonical face model);
 *   * VERTICAL spans are the ones inflated — their pixel span is yaw-
 *     stable while the shrunken iris drags pxPerMm down — so they are
 *     multiplied by cos(yaw) to undo the calibration shift.
 *
 * Under pitch the roles flip: the iris's horizontal diameter is pitch-
 * stable, so horizontal spans need nothing, while vertical spans
 * genuinely foreshorten and are divided by cos(pitch).
 *
 * Clamped at 30 degrees: past that the small-angle assumption stops
 * holding and the correction would amplify error rather than remove it.
 */
export function poseCorrect(
  key: string,
  value: number,
  yawDeg: number,
  pitchDeg: number,
  opts?: {
    /**
     * Use the depth-aware model for `noseToChin`. Only ever true for a
     * MATRIX-backed pitch — see the note on the constants below.
     */
    depthAwarePitch?: boolean;
    /** Camera distance for this frame, for the perspective term. */
    estimatedDistanceMm?: number | null;
  },
): number {
  if (HORIZONTAL_KEYS.has(key)) return value;
  const yawFactor = Math.cos((Math.min(30, Math.abs(yawDeg)) * Math.PI) / 180);
  if (opts?.depthAwarePitch && key === "noseToChin") {
    return (
      (value * yawFactor) /
      noseToChinPitchFactor(pitchDeg, opts.estimatedDistanceMm)
    );
  }
  const pitchFactor = Math.cos(
    (Math.min(30, Math.abs(pitchDeg)) * Math.PI) / 180,
  );
  return (value * yawFactor) / (pitchFactor > 0.1 ? pitchFactor : 1);
}

/**
 * How much of `noseToChin` survives projection at a given head pitch.
 *
 * The span runs ~33 mm through the face's DEPTH as well as ~89 mm down
 * its front, so pitching the head does not merely foreshorten it — it
 * swings the chin toward or away from the camera. That makes the
 * projection ASYMMETRIC in the sign of the pitch, which the plain
 * `cos(pitch)` model cannot express at all: cosine is even, so it
 * lengthens the span for a chin-down capture, which is the direction
 * that actually shortens it.
 *
 * Measured against pinhole projections of the canonical face
 * (`face-measurements.accuracy.test.ts`), the ratio is
 *
 *     cos(t) - K(D)·sin(t)
 *
 * with K stable to ±0.01 across ±12 degrees at any fixed distance, and
 * varying with distance exactly as perspective predicts:
 *
 *     K(D) = NOSE_TO_CHIN_DEPTH_RATIO + PITCH_PERSPECTIVE_GAIN_MM / D
 *
 * The constant term is the span's own depth-to-length ratio — the
 * orthographic limit, which the fit recovers to within 4% without being
 * told it — and the 1/D term is the perspective that doubles the effect
 * at arm's length. Fitted K: 0.94 at 280 mm, 0.77 at 400 mm, 0.66 at
 * 550 mm.
 *
 * WHY THIS IS MATRIX-ONLY. The geometric pitch estimator reads +5.4
 * degrees on the canonical face with the head perfectly LEVEL — the
 * anatomy confound PITCH_GRACE_DEG exists for. Feeding that into this
 * correction would "fix" a level capture by 5 degrees and introduce
 * ~7 mm of error where the raw reading was within 1.4 mm. The
 * transformation matrix is a rigid-body solve and carries no such
 * offset, and `resolveFramePose` only reports `matrix` once the two
 * agree about what they are looking at.
 */
function noseToChinPitchFactor(
  pitchDeg: number,
  estimatedDistanceMm?: number | null,
): number {
  const t =
    (Math.max(
      -PITCH_DEPTH_CORRECTION_MAX_DEG,
      Math.min(PITCH_DEPTH_CORRECTION_MAX_DEG, pitchDeg),
    ) *
      Math.PI) /
    180;
  // Nominal arm's length when the frame could not estimate its own
  // distance: the middle of the capture window, so the correction is
  // never scaled by a number that was never measured.
  const distance =
    typeof estimatedDistanceMm === "number" &&
    Number.isFinite(estimatedDistanceMm) &&
    estimatedDistanceMm > 0
      ? Math.min(900, Math.max(200, estimatedDistanceMm))
      : NOMINAL_CAPTURE_DISTANCE_MM;
  const k = NOSE_TO_CHIN_DEPTH_RATIO + PITCH_PERSPECTIVE_GAIN_MM / distance;
  const factor = Math.cos(t) - k * Math.sin(t);
  // A factor this far from 1 means the inputs are not describing a face
  // the model understands; correcting by it would amplify error rather
  // than remove it. Fall through to no pitch correction at all.
  return factor > 0.6 && factor < 1.5 ? factor : 1;
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[mid - 1]! + sorted[mid]!) / 2
    : sorted[mid]!;
}

/**
 * Fold accepted frames into one measurement set plus a confidence.
 *
 * The median rather than the mean, because one bad frame in three should
 * not drag the answer. Cross-frame agreement is the term that a single
 * frame simply cannot produce, and it is the whole reason multi-angle
 * capture is worth the extra ten seconds of the patient's time.
 */
export function aggregateFrames(frames: FrameMeasurement[]): AggregateResult {
  if (frames.length === 0) {
    return {
      measurements: {},
      agreement: {},
      quality: {
        lighting: 0,
        distance: 0,
        pose: 0,
        occlusion: 0,
        motion: 0,
        framing: 0,
      },
      measurementConfidence: 0,
      band: "low",
      frameCount: 0,
    };
  }

  const keys = Object.keys(frames[0]!.values);
  const measurements: Record<string, number> = {};
  const agreement: Record<string, number> = {};
  const sampleCounts: Record<string, number> = {};

  // Measurement samples come from near-frontal frames only (see
  // MEASUREMENT_YAW_LIMIT_DEG) — turned frames' heights are distorted
  // beyond the cos model, and their widths are gaze-ambiguous. Fall
  // back to every frame when none qualifies, so a fully-turned set
  // still measures rather than failing.
  const nearFrontal = frames.filter(
    (f) => Math.abs(f.yawDeg) <= MEASUREMENT_YAW_LIMIT_DEG,
  );
  // The all-turned fallback MEASURES rather than failing — but it
  // measures from frames this module's own analysis says cannot be
  // measured reliably (gaze-ambiguous widths ~6% either way, vertical
  // spans with residual error past the cos model), and both turn frames
  // carry the SAME systematic bias, so cross-frame agreement scores near
  // 1 and none of the ordinary caps fire. The band cap below keeps the
  // fallback honest: the values still come back, labelled `low`, which
  // routes the fitting to a fresh scan / human fit instead of shipping
  // a systematically biased set as a high-confidence recommendation.
  const fellBackToTurned = nearFrontal.length === 0;
  const usable = fellBackToTurned ? frames : nearFrontal;

  for (const key of keys) {
    const corrected = usable
      .map((f) =>
        poseCorrect(key, f.values[key] ?? Number.NaN, f.yawDeg, f.pitchDeg, {
          // Only a rigid-body pose earns the depth-aware model: the
          // geometric estimator reads +5.4 degrees on a level canonical
          // face, and correcting THAT would introduce ~7 mm of error
          // where the raw reading was within 1.4 mm.
          depthAwarePitch: f.poseSource === "matrix",
          estimatedDistanceMm: f.quality.estimatedDistanceMm,
        }),
      )
      .filter((v) => Number.isFinite(v));
    if (corrected.length === 0) continue;
    sampleCounts[key] = corrected.length;
    const med = median(corrected);
    measurements[key] = Math.round(med * 10) / 10;
    if (corrected.length === 1 || med === 0) {
      // A single frame yields no agreement evidence. Score it neutral-low
      // rather than perfect — "we only looked once" is not "we're sure".
      agreement[key] = corrected.length === 1 ? 0.7 : 1;
    } else {
      const spread = Math.max(...corrected) - Math.min(...corrected);
      agreement[key] = clamp01(1 - spread / Math.abs(med));
    }
  }

  const quality: Record<QualityCheck, number> = {
    lighting: 0,
    distance: 0,
    pose: 0,
    occlusion: 0,
    motion: 0,
    framing: 0,
  };
  for (const check of Object.keys(quality) as QualityCheck[]) {
    quality[check] =
      frames.reduce((sum, f) => sum + f.quality.scores[check], 0) /
      frames.length;
  }

  const meanQuality =
    frames.reduce((sum, f) => sum + f.quality.overall, 0) / frames.length;
  const agreementValues = Object.values(agreement);
  const meanAgreement =
    agreementValues.length > 0
      ? agreementValues.reduce((a, b) => a + b, 0) / agreementValues.length
      : 0.7;

  // ── What a burst's self-agreement is actually evidence OF. ──
  //
  // The default capture is one tap that fires five frames ~140 ms apart
  // at one posture (capture.tsx). Those frames share every SYSTEMATIC
  // error: the same distance, the same head angle, the same lighting,
  // the same hair across the same cheek. What varies between them is
  // landmark jitter — so their agreement measures DETECTOR STABILITY,
  // not measurement validity. Five consistent readings of a face held
  // 15 cm too close are five consistent wrong readings.
  //
  // Scored as ordinary agreement, that was worth ~0.99, and with the
  // full frame-count bonus on top a burst cleared the route's 0.75
  // high-confidence scan floor at a mean frame quality of just 0.45 —
  // mediocre pixels reaching "you can go ahead and order" on the
  // strength of agreeing with themselves. The capture cannot earn
  // cross-angle evidence, so it must not be paid for it.
  //
  // Two corrections, both scoped to a set that is ENTIRELY burst frames:
  //
  //   * agreement is capped. Repeated looks at one posture do rule out
  //     detector jitter and let a blurred frame be dropped, so a burst
  //     is worth more than a single glance (0.7) — but it cannot reach
  //     the confidence of evidence that survived the patient moving.
  //   * the frame-count bonus counts POSTURES, not frames. Five looks at
  //     one posture is one observation sampled five times.
  //
  // Net effect: a burst now needs genuinely good frames (mean quality
  // ≳ 0.74) to reach the high band, where it previously needed ≳ 0.45.
  // Nothing here touches the guided path, whose frames are tagged
  // `guided` — its two front captures are separated by a fresh
  // steady-streak (≥ ~540 ms of held position), which is weaker
  // independence than a re-pose but stronger than a shutter burst.
  const allBurst =
    usable.length > 0 && usable.every((f) => f.source === "burst");
  // The same argument one step out. A GUIDED run captures four frames,
  // but only the near-frontal ones contribute measurement samples — the
  // two turns contribute quality evidence and nothing else. Counting
  // them as independent looks paid the run for evidence it did not
  // produce, and the two front frames it did produce share a posture:
  // separated by a fresh steady-streak (~540 ms of held position), which
  // is more than a shutter burst earns and less than a genuine re-pose.
  //
  // Solving the confidence formula, that discount was worth ~1.6x: an
  // ideal guided run reached the high band at a mean frame quality of
  // ~0.47 where a burst needs ~0.74. It now needs ~0.62 — still credited
  // for the extra work, no longer paid twice for it.
  //
  // Scoped exactly like the burst rule: only a set where every frame
  // states its source is repriced, so an untagged or legacy caller keeps
  // the scoring it had rather than being silently discounted.
  const allTagged = frames.length > 0 && frames.every((f) => f.source);
  const contributors = usable;
  const samePosture =
    contributors.length > 1 &&
    new Set(contributors.map((f) => f.pose)).size === 1;
  const effectiveAgreement = allBurst
    ? Math.min(meanAgreement, BURST_AGREEMENT_CEILING)
    : allTagged && samePosture
      ? Math.min(meanAgreement, SAME_POSTURE_AGREEMENT_CEILING)
      : meanAgreement;
  // `frames.length`, not `usable.length`: the guided run captures four
  // frames of which only the two near-frontal ones contribute
  // measurement samples (MEASUREMENT_YAW_LIMIT_DEG), so keying off
  // `usable` quietly cut the guided path's bonus from 0.100 to 0.0667
  // and could tip a scan sitting on a threshold — a discount this change
  // was never meant to apply. Non-burst sets keep exactly the count they
  // had; only an all-burst set collapses to one look.
  const independentLooks = allBurst
    ? 1
    : allTagged
      ? contributors.length
      : frames.length;

  const measurementConfidence = clamp01(
    meanQuality * 0.45 +
      effectiveAgreement * 0.45 +
      Math.min(1, independentLooks / 3) * 0.1,
  );

  let band: AggregateResult["band"] =
    measurementConfidence >= CONFIDENCE_BANDS.high
      ? "high"
      : measurementConfidence >= CONFIDENCE_BANDS.moderate
        ? "moderate"
        : "low";

  // Hard caps, all saying the same thing: a number is only as good as the
  // evidence behind it.
  //
  //   * Every measurement must rest on at least TWO independent samples
  //     before the aggregate may claim `high`. A single look carries no
  //     cross-frame agreement — and this must be enforced PER KEY, not
  //     per frame count: a guided set whose turned frames were excluded
  //     from measuring (see MEASUREMENT_YAW_LIMIT_DEG) can have three
  //     frames yet only one sample behind every value, and the
  //     frame-count bonus plus width agreement must not smuggle that
  //     single look into a high-confidence fitting.
  //   * If any frame the MEASUREMENTS actually rest on failed its own
  //     quality gates, the aggregate is `low`, not merely "not high" —
  //     three consistent readings off three equally bad frames are
  //     consistently wrong, and a frame the quality checks judged
  //     unusable must not be reported as a moderate one. Scoped to
  //     `usable` (the measurement-contributing set) on purpose: a rough
  //     TURN frame — a patient who gave up and tapped "take it anyway"
  //     mid-struggle — contributed no measurement samples (see
  //     MEASUREMENT_YAW_LIMIT_DEG), so it must not floor two pristine
  //     front frames to `low` and torpedo the whole fitting.
  //
  //     Pipeline note: the live /measure path additionally DROPS frames
  //     that failed their gates before calling this function (keeping
  //     them all only when every frame failed — see measure.tsx), so in
  //     that flow an unacceptable frame normally never reaches this
  //     check at all. The scoping is this function's own contract — it
  //     keys the floor to the frames the numbers rest on, whatever the
  //     caller's filtering policy — and in the everything-failed
  //     fallback `usable` covers every frame, so the floor still fires
  //     in full.
  //
  // That second cap has to be a floor rather than a score adjustment,
  // because the score cannot express it: a single frame's agreement term
  // is fixed at 0.7, which puts a ~0.35 floor under `measurementConfidence`
  // however bad the pixels were. Without the cap, a too-dark, too-soft
  // frame still lands around 0.55 and reads as "moderate".
  const anyUnacceptable = usable.some((f) => !f.quality.acceptable);
  const anySingleSampled = keys.some((k) => (sampleCounts[k] ?? 0) < 2);
  if (anyUnacceptable || fellBackToTurned) {
    band = "low";
  } else if (band === "high" && anySingleSampled) {
    band = "moderate";
  }

  return {
    measurements,
    agreement,
    quality,
    measurementConfidence: Math.round(measurementConfidence * 1000) / 1000,
    band,
    frameCount: frames.length,
  };
}
