// pose-diagnostics.ts — decide, from real frames on a real device,
// whether MediaPipe's facial transformation matrix means what this code
// assumes it means.
//
// THE OPEN QUESTION
// -----------------
// `poseFromFacialTransformationMatrix` reads the matrix column-major and
// extracts Tait-Bryan angles in the yaw/pitch/roll convention the
// geometric estimator reports. Both of those are assumptions. The
// tasks-vision docs do not state the handedness, and a WASM build can
// change it. So:
//
//   * If the matrix is TRANSPOSED, pitch and yaw swap roles.
//   * If a sign convention is flipped, chin-up reads as chin-down.
//
// The second is the dangerous one. `noseToChinPitchFactor` is
// deliberately ASYMMETRIC in the sign of pitch — chin-down shortens the
// nose-to-chin span and chin-up lengthens it — so a sign flip does not
// merely add noise: it drives the depth correction in exactly the wrong
// direction, roughly doubling the error it was written to remove. That
// is worse than the geometric estimator it replaces.
//
// `resolveFramePose` already refuses a matrix that disagrees with the
// geometric estimate, so a reversed convention degrades to today's
// behaviour rather than corrupting a measurement. What it CANNOT do is
// tell anyone the convention is reversed — it looks identical to a
// runtime that simply does not emit a matrix. This module is how a
// person finds out.
//
// HOW
// ---
// A guided sequence: hold still, chin up, chin down, turn left, turn
// right, roll left, roll right. Each step declares the sign the matrix
// SHOULD produce. Collect frames, compare, and report one of three
// verdicts per axis — agreed, reversed, or inconclusive. Inconclusive is
// a real answer and must not be rounded to either of the others: a
// patient who did not move far enough proves nothing.
//
// PURE. No camera, no DOM, no network, no clock. It consumes frames and
// returns a verdict, which is what makes every case below testable
// without a device — and what makes the device session, when it happens,
// only have to supply frames.
//
// PHI / IMAGES
// ------------
// This module never sees an image. It takes ANGLES. Nothing here can
// retain, transmit or log a facial photograph, because nothing here is
// ever given one.

/** The movements a validation session walks through, in order. */
export const POSE_VALIDATION_STEPS = [
  "level",
  "chin_up",
  "chin_down",
  "turn_left",
  "turn_right",
  "roll_left",
  "roll_right",
] as const;

export type PoseValidationStep = (typeof POSE_VALIDATION_STEPS)[number];

export type PoseAxis = "pitch" | "yaw" | "roll";

export interface PoseStepSpec {
  step: PoseValidationStep;
  /** What the person is asked to do. */
  instruction: string;
  /** Which axis this step exercises. `null` for the level baseline. */
  axis: PoseAxis | null;
  /**
   * The sign the MATRIX should report for `axis` while holding this
   * pose, under the convention this codebase assumes.
   *
   * `0` for the level step, which asserts nothing about direction — it
   * establishes the resting offset every other step is measured against.
   */
  expectedSign: -1 | 0 | 1;
  /** Below this the movement is too small to conclude anything from. */
  minMagnitudeDeg: number;
}

/**
 * The sequence, and the expected sign of each movement.
 *
 * The signs follow the convention `poseFromFacialTransformationMatrix`
 * extracts: pitch from `atan2(r21, r22)`, yaw from
 * `atan2(-r20, hypot(r00, r10))`, roll from `atan2(r10, r00)`, in a
 * right-handed frame with +x to the subject's left in image space.
 *
 * `minMagnitudeDeg` is 8 for pitch and yaw and 6 for roll — comfortably
 * past the geometric estimator's own anatomy confound (PITCH_GRACE_DEG
 * is 6) and small enough that an ordinary person can hit it without
 * straining. Below it, a step is INCONCLUSIVE rather than passing.
 */
export const POSE_STEP_SPECS: readonly PoseStepSpec[] = [
  {
    step: "level",
    instruction:
      "Look straight at the camera and hold still. This is the baseline; do not tilt or turn.",
    axis: null,
    expectedSign: 0,
    minMagnitudeDeg: 0,
  },
  {
    step: "chin_up",
    instruction: "Slowly raise your chin, as if looking at the ceiling.",
    axis: "pitch",
    expectedSign: 1,
    minMagnitudeDeg: 8,
  },
  {
    step: "chin_down",
    instruction: "Slowly lower your chin toward your chest.",
    axis: "pitch",
    expectedSign: -1,
    minMagnitudeDeg: 8,
  },
  {
    step: "turn_left",
    instruction: "Turn your head to YOUR left, keeping your chin level.",
    axis: "yaw",
    expectedSign: 1,
    minMagnitudeDeg: 8,
  },
  {
    step: "turn_right",
    instruction: "Turn your head to YOUR right, keeping your chin level.",
    axis: "yaw",
    expectedSign: -1,
    minMagnitudeDeg: 8,
  },
  {
    step: "roll_left",
    instruction: "Tip your head so your left ear moves toward your shoulder.",
    axis: "roll",
    expectedSign: 1,
    minMagnitudeDeg: 6,
  },
  {
    step: "roll_right",
    instruction: "Tip your head so your right ear moves toward your shoulder.",
    axis: "roll",
    expectedSign: -1,
    minMagnitudeDeg: 6,
  },
];

/**
 * One frame's worth of DERIVED diagnostics.
 *
 * Everything here is a number computed from landmarks. There is no image
 * field and there must never be one.
 */
export interface PoseDiagnosticFrame {
  /** Milliseconds since the session started. */
  atMs: number;
  step: PoseValidationStep;
  /** Straight from the transformation matrix, before any gating. */
  matrix: { yawDeg: number; pitchDeg: number; rollDeg: number } | null;
  /** The landmark-geometry fallback, always computed. */
  geometric: { yawDeg: number; pitchDeg: number; rollDeg: number };
  /** Which one `resolveFramePose` actually returned. */
  poseSource: "matrix" | "geometric";
  /** The frame quality score, so a bad frame can be discounted. */
  qualityScore: number;
  /** Nose-to-chin as measured, before pose correction. */
  noseToChinRawMm?: number | null;
  /** Nose-to-chin after the depth-aware correction, when it ran. */
  noseToChinCorrectedMm?: number | null;
}

export type AxisVerdict =
  /** The matrix agrees with the assumed convention. */
  | "agreed"
  /** The matrix is consistently the OPPOSITE sign. */
  | "reversed"
  /** Not enough usable movement to say. NOT a pass and NOT a failure. */
  | "inconclusive"
  /** The matrix disagreed with itself between the two directions. */
  | "inconsistent"
  /** No matrix was emitted at all on this device. */
  | "no_matrix";

export interface StepOutcome {
  step: PoseValidationStep;
  axis: PoseAxis | null;
  framesSeen: number;
  framesWithMatrix: number;
  /** Median matrix angle on this step's axis, baseline-corrected. */
  medianMatrixDeg: number | null;
  /** Median geometric angle on the same axis, baseline-corrected. */
  medianGeometricDeg: number | null;
  /** Did the person actually move far enough? */
  movedEnough: boolean;
  /** Did the matrix's sign match what the step expects? */
  signMatched: boolean | null;
}

export interface PoseValidationReport {
  /** Opaque per-session identifier. Not tied to a patient. */
  sessionId: string;
  startedAt: string;
  steps: StepOutcome[];
  verdicts: Record<PoseAxis, AxisVerdict>;
  /** True when ANY axis came back `reversed` or `inconsistent`. */
  conventionSuspect: boolean;
  /** True when every axis came back `agreed`. */
  conventionConfirmed: boolean;
  /** How often the matrix survived `resolveFramePose`'s own gates. */
  matrixAcceptanceRate: number;
  findings: string[];
  device: DeviceDescriptor;
}

/**
 * Non-identifying description of what the session ran on.
 *
 * A user agent string is not PHI, but it is fingerprintable, so the
 * caller is expected to pass the coarse fields it already displays
 * rather than the raw string.
 */
export interface DeviceDescriptor {
  /** e.g. "iOS 18.4", "Android 15", "macOS 15.3". */
  platform: string;
  /** e.g. "Safari 18", "Chrome 134". */
  browser: string;
  /** Rendering backend the MediaPipe task reported, when known. */
  delegate?: "GPU" | "CPU" | "unknown";
  /** Capture resolution, which changes the geometric estimator's error. */
  frameWidth?: number;
  frameHeight?: number;
}

/** Median of a numeric list. Empty list yields null. */
function median(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[mid - 1] + sorted[mid]) / 2
    : sorted[mid];
}

function axisValue(
  angles: { yawDeg: number; pitchDeg: number; rollDeg: number },
  axis: PoseAxis,
): number {
  return axis === "pitch"
    ? angles.pitchDeg
    : axis === "yaw"
      ? angles.yawDeg
      : angles.rollDeg;
}

/**
 * A frame worth drawing a conclusion from.
 *
 * A blurry, badly-lit or half-out-of-frame capture produces landmark
 * noise, and a sign read off noise is not evidence of anything. 0.5 is
 * the same bar the fitter uses to call a frame usable at all.
 */
const MIN_USABLE_QUALITY = 0.5;

/**
 * Summarize one step.
 *
 * Angles are BASELINE-CORRECTED against the level step, because a person
 * holding a phone rests their head a few degrees off zero and the whole
 * question here is about direction, not absolute value.
 *
 * @param spec - What this step asks for.
 * @param frames - Frames captured during it.
 * @param baseline - Median angles from the level step, per axis.
 * @returns What the step showed.
 */
export function summarizeStep(
  spec: PoseStepSpec,
  frames: readonly PoseDiagnosticFrame[],
  baseline: Partial<Record<PoseAxis, number>> = {},
): StepOutcome {
  const usable = frames.filter((f) => f.qualityScore >= MIN_USABLE_QUALITY);
  const withMatrix = usable.filter((f) => f.matrix !== null);

  if (!spec.axis) {
    return {
      step: spec.step,
      axis: null,
      framesSeen: usable.length,
      framesWithMatrix: withMatrix.length,
      medianMatrixDeg: null,
      medianGeometricDeg: null,
      movedEnough: true,
      signMatched: null,
    };
  }

  const offset = baseline[spec.axis] ?? 0;
  const matrixValues = withMatrix.map(
    (f) =>
      axisValue(f.matrix as NonNullable<typeof f.matrix>, spec.axis!) - offset,
  );
  const geoValues = usable.map(
    (f) => axisValue(f.geometric, spec.axis!) - offset,
  );

  const medianMatrixDeg = median(matrixValues);
  const medianGeometricDeg = median(geoValues);

  // "Moved enough" is decided by the GEOMETRIC estimate, deliberately.
  // The matrix is the thing under test; using it to decide whether the
  // test ran would let a broken matrix declare every step inconclusive
  // and quietly pass.
  const movedEnough =
    medianGeometricDeg !== null &&
    Math.abs(medianGeometricDeg) >= spec.minMagnitudeDeg;

  const signMatched =
    medianMatrixDeg === null || !movedEnough
      ? null
      : Math.sign(medianMatrixDeg) === spec.expectedSign;

  return {
    step: spec.step,
    axis: spec.axis,
    framesSeen: usable.length,
    framesWithMatrix: withMatrix.length,
    medianMatrixDeg,
    medianGeometricDeg,
    movedEnough,
    signMatched,
  };
}

/**
 * Decide one axis from its two opposing steps.
 *
 * Requiring BOTH directions is the point. One direction agreeing proves
 * very little — a matrix stuck at zero, or one reporting magnitude
 * without sign, would pass a single-direction check.
 */
function verdictForAxis(
  positive: StepOutcome | undefined,
  negative: StepOutcome | undefined,
): AxisVerdict {
  if (!positive || !negative) return "inconclusive";
  if (positive.framesWithMatrix === 0 && negative.framesWithMatrix === 0) {
    return "no_matrix";
  }
  if (!positive.movedEnough || !negative.movedEnough) return "inconclusive";
  if (positive.signMatched === null || negative.signMatched === null) {
    return "inconclusive";
  }
  if (positive.signMatched && negative.signMatched) return "agreed";
  if (!positive.signMatched && !negative.signMatched) return "reversed";
  // One direction right and the other wrong is neither. It usually means
  // the matrix is not tracking that axis at all — which must not be
  // reported as a clean reversal somebody could "fix" with a minus sign.
  return "inconsistent";
}

/**
 * Turn a completed session into a verdict.
 *
 * @param input - Session identity, device, and every frame collected.
 * @returns A report safe to display, export, and attach to a ticket.
 */
export function buildPoseValidationReport(input: {
  sessionId: string;
  startedAt: string;
  device: DeviceDescriptor;
  frames: readonly PoseDiagnosticFrame[];
}): PoseValidationReport {
  const byStep = new Map<PoseValidationStep, PoseDiagnosticFrame[]>();
  for (const frame of input.frames) {
    byStep.set(frame.step, [...(byStep.get(frame.step) ?? []), frame]);
  }

  // Resting offset from the level step, per axis. Measured on the
  // GEOMETRIC estimate as well as the matrix so each is corrected
  // against its own resting value — the geometric pitch estimator reads
  // several degrees positive on a level head by construction, and
  // subtracting the matrix's offset from it would import that error.
  const levelFrames = (byStep.get("level") ?? []).filter(
    (f) => f.qualityScore >= MIN_USABLE_QUALITY,
  );
  const matrixBaseline: Partial<Record<PoseAxis, number>> = {};
  const geoBaseline: Partial<Record<PoseAxis, number>> = {};
  for (const axis of ["pitch", "yaw", "roll"] as const) {
    matrixBaseline[axis] =
      median(
        levelFrames
          .filter((f) => f.matrix !== null)
          .map((f) =>
            axisValue(f.matrix as NonNullable<typeof f.matrix>, axis),
          ),
      ) ?? 0;
    geoBaseline[axis] =
      median(levelFrames.map((f) => axisValue(f.geometric, axis))) ?? 0;
  }

  const steps = POSE_STEP_SPECS.map((spec) => {
    const frames = byStep.get(spec.step) ?? [];
    // Each estimate is corrected against its OWN baseline.
    const outcome = summarizeStep(spec, frames, matrixBaseline);
    if (spec.axis) {
      const geoOnly = summarizeStep(
        { ...spec, minMagnitudeDeg: spec.minMagnitudeDeg },
        frames,
        geoBaseline,
      );
      outcome.medianGeometricDeg = geoOnly.medianGeometricDeg;
      outcome.movedEnough = geoOnly.movedEnough;
      outcome.signMatched =
        outcome.medianMatrixDeg === null || !outcome.movedEnough
          ? null
          : Math.sign(outcome.medianMatrixDeg) === spec.expectedSign;
    }
    return outcome;
  });

  const byName = new Map(steps.map((s) => [s.step, s]));
  const verdicts: Record<PoseAxis, AxisVerdict> = {
    pitch: verdictForAxis(byName.get("chin_up"), byName.get("chin_down")),
    yaw: verdictForAxis(byName.get("turn_left"), byName.get("turn_right")),
    roll: verdictForAxis(byName.get("roll_left"), byName.get("roll_right")),
  };

  const usableFrames = input.frames.filter(
    (f) => f.qualityScore >= MIN_USABLE_QUALITY,
  );
  const matrixAcceptanceRate =
    usableFrames.length === 0
      ? 0
      : usableFrames.filter((f) => f.poseSource === "matrix").length /
        usableFrames.length;

  const findings = buildFindings(verdicts, steps, matrixAcceptanceRate);

  return {
    sessionId: input.sessionId,
    startedAt: input.startedAt,
    steps,
    verdicts,
    conventionSuspect: Object.values(verdicts).some(
      (v) => v === "reversed" || v === "inconsistent",
    ),
    conventionConfirmed: Object.values(verdicts).every((v) => v === "agreed"),
    matrixAcceptanceRate,
    findings,
    device: input.device,
  };
}

/** Findings, phrased as what they mean and what to do. */
function buildFindings(
  verdicts: Record<PoseAxis, AxisVerdict>,
  steps: readonly StepOutcome[],
  acceptanceRate: number,
): string[] {
  const findings: string[] = [];

  for (const axis of ["pitch", "yaw", "roll"] as const) {
    const verdict = verdicts[axis];
    if (verdict === "reversed") {
      findings.push(
        `${axis.toUpperCase()} IS REVERSED on this device. The matrix reports the ` +
          "opposite sign to the convention the code assumes. " +
          (axis === "pitch"
            ? "This is the dangerous one: the nose-to-chin depth correction is asymmetric in the sign of pitch, so a reversed sign drives it the wrong way and roughly doubles the error it exists to remove. resolveFramePose's agreement gate should be refusing these frames — check matrixAcceptanceRate below."
            : "Direction-locked coaching would tell the patient to turn the wrong way."),
      );
    } else if (verdict === "inconsistent") {
      findings.push(
        `${axis.toUpperCase()} DISAGREED WITH ITSELF between the two directions. ` +
          "That usually means the matrix is not tracking this axis at all — do " +
          "not 'fix' it by flipping a sign.",
      );
    } else if (verdict === "no_matrix") {
      findings.push(
        `No transformation matrix was emitted for ${axis} on this device. The ` +
          "geometric estimator is carrying the fitting, which is the designed " +
          "fallback — the fitter still works, less precisely.",
      );
    } else if (verdict === "inconclusive") {
      const stepNames = steps
        .filter((s) => s.axis === axis && !s.movedEnough)
        .map((s) => s.step)
        .join(", ");
      findings.push(
        `${axis.toUpperCase()} is INCONCLUSIVE — the head did not move far enough ` +
          `on ${stepNames || "one or both directions"}. This is not a pass. ` +
          "Re-run the sequence with a fuller movement.",
      );
    }
  }

  if (acceptanceRate === 0) {
    findings.push(
      "resolveFramePose accepted the matrix on ZERO frames. Either no matrix was " +
        "emitted, or its agreement gates rejected every one — which is the " +
        "designed behaviour when the convention does not match, and is why a " +
        "reversed matrix degrades to the geometric estimate rather than " +
        "corrupting a measurement.",
    );
  } else if (acceptanceRate < 0.5) {
    findings.push(
      `resolveFramePose accepted the matrix on only ${Math.round(acceptanceRate * 100)}% ` +
        "of usable frames. The gates are firing often; the convention may be " +
        "partially wrong even where the sign check passed.",
    );
  }

  if (findings.length === 0) {
    findings.push(
      "Every axis agreed with the assumed convention, on this device and " +
        "browser only. This result does not generalise — record it against " +
        "this row of the device matrix and run the others.",
    );
  }

  return findings;
}

/**
 * Render a report as CSV for a validation ticket.
 *
 * Carries angles, verdicts and device metadata. There is no image field
 * because no image ever reaches this module.
 *
 * @param report - A completed validation report.
 * @returns CSV text with a header row.
 */
export function buildPoseValidationCsv(report: PoseValidationReport): string {
  const escape = (v: string) =>
    /[",\n\r]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
  const lines = [
    "session_id,device_platform,device_browser,delegate,step,axis,frames,frames_with_matrix,median_matrix_deg,median_geometric_deg,moved_enough,sign_matched",
  ];
  for (const step of report.steps) {
    lines.push(
      [
        escape(report.sessionId),
        escape(report.device.platform),
        escape(report.device.browser),
        escape(report.device.delegate ?? "unknown"),
        step.step,
        step.axis ?? "",
        String(step.framesSeen),
        String(step.framesWithMatrix),
        step.medianMatrixDeg === null ? "" : step.medianMatrixDeg.toFixed(2),
        step.medianGeometricDeg === null
          ? ""
          : step.medianGeometricDeg.toFixed(2),
        step.movedEnough ? "yes" : "no",
        step.signMatched === null ? "" : step.signMatched ? "yes" : "no",
      ].join(","),
    );
  }
  return `${lines.join("\r\n")}\r\n`;
}
