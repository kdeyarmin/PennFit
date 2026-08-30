/**
 * Build the `scan` payload the clinical assessment expects.
 *
 * Why this exists: `scan-quality.ts` (the pure checks) and the API's
 * `scanSchema` both shipped, but nothing ever joined them — `results.tsx`
 * posted an assessment with no `scan`, so the route substituted its
 * `NEUTRAL_SCAN` (measurementConfidence 0.7) on EVERY fitting. Two
 * consequences: blur and lighting were never actually measured, and 0.7
 * sits below the 0.75 `highScan` floor, so no fitting could ever reach
 * high confidence no matter how good the frame was.
 *
 * This module is that join. It takes what `measure.tsx` already has — the
 * decoded frame, the landmarks, the iris calibration, and the millimetre
 * measurements — and produces the scalar signal set.
 *
 * Single-frame honesty: `aggregateFrames` scores a lone frame's
 * cross-frame agreement at 0.7 ("we only looked once") and caps its band
 * at moderate. That is deliberate and stays true here — one frame can now
 * clear the high-confidence scan floor only when its own quality is
 * genuinely excellent, and a poor frame correctly falls below the moderate
 * floor, which is the behaviour the marketing copy describes.
 *
 * PHI: every field is a scalar in [0, 1] plus a frame count and a band
 * label. Nothing image-derived beyond those numbers is produced here, and
 * the API independently rejects encoded media on the way in.
 */

import {
  aggregateFrames,
  assessFrameQuality,
  estimatePoseFromLandmarks,
  MEASUREMENT_YAW_LIMIT_DEG,
  type AggregateResult,
  type CapturePose,
  type FrameMeasurement,
  type Point2D,
} from "./scan-quality";
import { sampleFrame } from "./frame-sampling";
import type { ScanSignalsRequest } from "./fit-assess-api";

/**
 * The wire shape, owned by the API client so there is exactly one
 * definition of what the route accepts.
 */
export type ScanSignalsPayload = ScanSignalsRequest;

/** The measurement keys the API's `agreement` object accepts. */
const AGREEMENT_KEYS = [
  "noseWidth",
  "noseHeight",
  "noseToChin",
  "mouthWidth",
  "faceWidthAtCheekbones",
] as const;

export interface BuildScanSignalsInput {
  image: CanvasImageSource & { width: number; height: number };
  landmarks: readonly Point2D[];
  irisWidthPx: number;
  /** The millimetre measurements this frame produced. */
  values: Record<string, number>;
  pose?: CapturePose;
}

/** Clamp into [0, 1] and round, so the payload always satisfies the schema. */
function unit(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.round(Math.min(1, Math.max(0, n)) * 1000) / 1000;
}

/**
 * Clamp a head angle into the [-90, 90] the route accepts, for the same
 * reason `unit` clamps the scores: a payload the schema rejects costs
 * the patient the whole assessment, not just the field.
 *
 * `estimatePoseFromLandmarks` derives pitch as `(ratio - 0.28) * 140`
 * from a landmark ratio with no upper bound, so a strongly chin-up
 * capture — where the chin swings toward eye level and shrinks the
 * denominator — can report well past 90. Sending that verbatim would
 * 400 the assessment and dead-end a patient whose scan should simply
 * have come back low-confidence with a retake prompt.
 *
 * A clamp rather than a drop: past 90 the estimator has saturated, not
 * measured, and the boundary value says exactly that while keeping the
 * frame's other diagnostics. No real head reaches ±90 in a capture that
 * passes its quality gates, so a genuine reading is never confused with
 * a clamped one.
 */
function degrees(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.round(Math.min(90, Math.max(-90, n)) * 10) / 10;
}

/**
 * Assess one captured frame and fold it into the wire shape.
 *
 * Never throws: a fitting must not fail because a quality probe did.
 */
export function buildScanSignals(
  input: BuildScanSignalsInput,
): ScanSignalsPayload {
  const pose: CapturePose = input.pose ?? "front";
  const sample = sampleFrame(input.image, input.landmarks);
  const angles = estimatePoseFromLandmarks(input.landmarks as Point2D[], {
    width: input.image.width,
    height: input.image.height,
  });

  const quality = assessFrameQuality({
    pose,
    landmarks: input.landmarks as Point2D[],
    irisWidthPx: input.irisWidthPx,
    frameWidth: input.image.width,
    frameHeight: input.image.height,
    faceLuma: sample.faceLuma,
    faceLumaLeft: sample.faceLumaLeft,
    faceLumaRight: sample.faceLumaRight,
    sharpness: sample.sharpness,
    yawDeg: angles.yawDeg,
    pitchDeg: angles.pitchDeg,
    rollDeg: angles.rollDeg,
  });

  const frame: FrameMeasurement = {
    pose,
    quality,
    values: input.values,
    yawDeg: angles.yawDeg,
    pitchDeg: angles.pitchDeg,
  };
  const aggregate = aggregateFrames([frame]);

  return payloadFromAggregate(aggregate, [frame]);
}

/**
 * Project the per-frame numbers onto the wire shape.
 *
 * Scalars only — head angles, the millimetre values that frame
 * produced, and its own quality subscores. Nothing image-derived beyond
 * those numbers exists at this point to send.
 *
 * `contributed` mirrors `aggregateFrames`'s own near-frontal rule, so a
 * reader can tell which frames the reported measurements actually rest
 * on without re-deriving the yaw limit.
 */
export function framesFromMeasurements(
  frames: readonly FrameMeasurement[],
): ScanSignalsPayload["frames"] {
  const anyNearFrontal = frames.some(
    (f) => Math.abs(f.yawDeg) <= MEASUREMENT_YAW_LIMIT_DEG,
  );
  const round = (n: number) =>
    Number.isFinite(n) ? Math.round(n * 10) / 10 : 0;
  return frames.slice(0, 10).map((f) => ({
    pose: f.pose,
    ...(f.source ? { source: f.source } : {}),
    yawDeg: degrees(f.yawDeg),
    pitchDeg: degrees(f.pitchDeg),
    acceptable: f.quality.acceptable,
    // Matches the all-turned fallback: when nothing is near-frontal,
    // every frame contributes.
    contributed:
      !anyNearFrontal || Math.abs(f.yawDeg) <= MEASUREMENT_YAW_LIMIT_DEG,
    // Finite, not merely `typeof number`: `NaN` and `Infinity` are both
    // numbers, and rounding either would record 0.0 mm — a reading no
    // face produces, indistinguishable from a real measurement, in the
    // one record meant to explain where measurements come from. The key
    // is optional on the wire, so an unmeasurable dimension is simply
    // absent, which is what it is.
    values: Object.fromEntries(
      AGREEMENT_KEYS.filter((k) => Number.isFinite(f.values[k])).map((k) => [
        k,
        round(f.values[k]!),
      ]),
    ),
    quality: {
      lighting: unit(f.quality.scores.lighting),
      distance: unit(f.quality.scores.distance),
      pose: unit(f.quality.scores.pose),
      occlusion: unit(f.quality.scores.occlusion),
      motion: unit(f.quality.scores.motion),
      framing: unit(f.quality.scores.framing),
    },
  }));
}

/**
 * Fold an `aggregateFrames` result into the wire shape.
 *
 * Shared by the single-frame path above and the guided multi-angle path
 * in /measure (which aggregates several frames itself and only needs the
 * projection). Clamps every scalar into [0, 1] and keeps only the keys
 * the route's `.strict()` schema knows about — an unexpected key would
 * 400 the whole assessment.
 *
 * `frames` is optional: pass the per-frame set to have it projected
 * alongside the aggregate (see `framesFromMeasurements`), omit it and
 * the payload is exactly what it was before.
 */
export function payloadFromAggregate(
  aggregate: AggregateResult,
  frames?: readonly FrameMeasurement[],
): ScanSignalsPayload {
  const agreement: ScanSignalsPayload["agreement"] = {};
  for (const key of AGREEMENT_KEYS) {
    const v = aggregate.agreement[key];
    if (typeof v === "number") agreement[key] = unit(v);
  }

  return {
    frameCount: Math.min(10, Math.max(1, aggregate.frameCount)),
    quality: {
      lighting: unit(aggregate.quality.lighting),
      distance: unit(aggregate.quality.distance),
      pose: unit(aggregate.quality.pose),
      occlusion: unit(aggregate.quality.occlusion),
      motion: unit(aggregate.quality.motion),
      framing: unit(aggregate.quality.framing),
    },
    agreement,
    measurementConfidence: unit(aggregate.measurementConfidence),
    band: aggregate.band,
    ...(frames && frames.length > 0
      ? { frames: framesFromMeasurements(frames) }
      : {}),
  };
}
