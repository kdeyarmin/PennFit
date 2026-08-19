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
  /** Checks currently failing, worst first. Drives the on-screen coach. */
  failing: QualityCheck[];
  /** Whether this frame is good enough to measure from. */
  acceptable: boolean;
  overall: number;
}

// MediaPipe FaceMesh landmark indices used by the checks.
const NOSE_TIP = 1;
const LEFT_CHEEK = 234;
const RIGHT_CHEEK = 454;
const FOREHEAD = 10;
const CHIN = 152;
const LEFT_EYE_OUTER = 33;
const RIGHT_EYE_OUTER = 263;
const NOSE_BRIDGE = 168;

/** mm-per-pixel window: roughly arm's length on a phone front camera. */
export const PX_PER_MM_BOUNDS = { min: 1.5, max: 3.8 } as const;
export const LUMA_BOUNDS = { min: 60, max: 210 } as const;
export const MAX_LUMA_SIDE_DELTA = 35;
export const SHARPNESS_FLOOR = 45;
export const MAX_MOTION_FRACTION = 0.008;

/** Per-pose head-angle tolerances, in degrees. */
export const POSE_TARGETS: Record<
  CapturePose,
  { yaw: number; yawTolerance: number; maxPitch: number; maxRoll: number }
> = {
  front: { yaw: 0, yawTolerance: 8, maxPitch: 8, maxRoll: 6 },
  turn_left: { yaw: -20, yawTolerance: 10, maxPitch: 10, maxRoll: 8 },
  turn_right: { yaw: 20, yawTolerance: 10, maxPitch: 10, maxRoll: 8 },
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
 * Derive head pose from landmark geometry.
 *
 * A fallback for runtimes where the facial transformation matrix is not
 * available. Deliberately crude — it only needs to be good enough to tell
 * "facing the camera" from "turned 20 degrees", which is exactly what the
 * gates test.
 */
export function estimatePoseFromLandmarks(landmarks: Point2D[]): {
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
  // toward one as the head turns.
  const dLeft = Math.abs(nose.x - left.x);
  const dRight = Math.abs(right.x - nose.x);
  const asymmetry = (dRight - dLeft) / Math.max(1e-6, dRight + dLeft);
  const yawDeg = asymmetry * 90;

  // Roll: the tilt of the eye line.
  const rollDeg =
    (Math.atan2(eyeR.y - eyeL.y, eyeR.x - eyeL.x) * 180) / Math.PI;

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
  const balance = clamp01(1 - sideDelta / (MAX_LUMA_SIDE_DELTA * 2));
  scores.lighting = clamp01(exposure * (0.5 + 0.5 * balance));

  // ── Distance, via the iris reference already used for calibration. ──
  const pxPerMm = input.irisWidthPx / 11.7;
  scores.distance = windowScore(
    pxPerMm,
    PX_PER_MM_BOUNDS.min,
    PX_PER_MM_BOUNDS.max,
  );

  // ── Head position against this pose's target. ──
  const target = POSE_TARGETS[input.pose];
  const yawError = Math.abs(input.yawDeg - target.yaw);
  const yawScore = clamp01(1 - yawError / (target.yawTolerance * 2));
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

  return {
    scores,
    failing,
    // Framing is non-negotiable; the rest must clear a floor together.
    acceptable: scores.framing === 1 && failing.length === 0 && overall >= 0.6,
    overall,
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

export function coachMessage(result: QualityResult, pose: CapturePose): string {
  if (result.failing.length === 0) return "Hold it right there…";
  return COACH_COPY[result.failing[0]!] ?? POSE_PROMPT[pose];
}

// ── Multi-frame aggregation ──────────────────────────────────────────

export interface FrameMeasurement {
  pose: CapturePose;
  quality: QualityResult;
  values: Record<string, number>;
  yawDeg: number;
  pitchDeg: number;
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

const HORIZONTAL_KEYS = new Set([
  "noseWidth",
  "mouthWidth",
  "faceWidthAtCheekbones",
]);

/**
 * Correct a span for head rotation.
 *
 * A horizontal span foreshortens by cos(yaw) as the head turns, and a
 * vertical one by cos(pitch). Clamped at 30 degrees: past that the small-
 * angle assumption stops holding and the correction would amplify error
 * rather than remove it.
 */
export function poseCorrect(
  key: string,
  value: number,
  yawDeg: number,
  pitchDeg: number,
): number {
  const angle = HORIZONTAL_KEYS.has(key) ? yawDeg : pitchDeg;
  const clamped = Math.min(30, Math.abs(angle));
  const factor = Math.cos((clamped * Math.PI) / 180);
  return factor > 0.1 ? value / factor : value;
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

  for (const key of keys) {
    const corrected = frames
      .map((f) =>
        poseCorrect(key, f.values[key] ?? Number.NaN, f.yawDeg, f.pitchDeg),
      )
      .filter((v) => Number.isFinite(v));
    if (corrected.length === 0) continue;
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

  const measurementConfidence = clamp01(
    meanQuality * 0.45 +
      meanAgreement * 0.45 +
      Math.min(1, frames.length / 3) * 0.1,
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
  //   * One frame carries no cross-frame agreement at all, so however
  //     clean it looks we have not actually verified the measurement is
  //     stable. Cap at moderate.
  //   * If any contributing frame failed its own quality gates, the
  //     aggregate is `low`, not merely "not high" — three consistent
  //     readings off three equally bad frames are consistently wrong, and
  //     a frame the quality checks judged unusable must not be reported
  //     as a moderate one.
  //
  // That second cap has to be a floor rather than a score adjustment,
  // because the score cannot express it: a single frame's agreement term
  // is fixed at 0.7, which puts a ~0.35 floor under `measurementConfidence`
  // however bad the pixels were. Without the cap, a too-dark, too-soft
  // frame still lands around 0.55 and reads as "moderate".
  const anyUnacceptable = frames.some((f) => !f.quality.acceptable);
  if (anyUnacceptable) {
    band = "low";
  } else if (band === "high" && frames.length < 2) {
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
