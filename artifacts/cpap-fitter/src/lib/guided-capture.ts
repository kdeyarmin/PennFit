/**
 * Guided multi-angle capture — the pose state machine. Pure, no React,
 * no MediaPipe, no timers of its own (the caller supplies `nowMs`), so
 * every transition is unit-testable without a camera.
 *
 * The flow it drives (behind `fitter.multiframe_capture`):
 *
 *   front → front → turn_left → turn_right
 *
 * The front pose is captured TWICE, deliberately: measurement samples
 * come from near-frontal frames only (turned frames are excluded — see
 * MEASUREMENT_YAW_LIMIT_DEG in scan-quality.ts), and the aggregate caps
 * its confidence band at "moderate" whenever any measurement rests on a
 * single sample. One front frame would therefore lock every guided
 * fitting out of the high band; two give each measurement genuine
 * repeated evidence.
 *
 * At each pose the live loop feeds one `QualityResult` per assessed
 * preview frame. A pose auto-captures only after `STEADY_FRAMES_REQUIRED`
 * consecutive acceptable assessments — a single lucky frame between two
 * blurry ones is not a steady subject. Anything unacceptable resets the
 * streak and surfaces the worst failing check's coach line.
 *
 * Patients who cannot satisfy a pose are never trapped:
 *   * after `POSE_STRUGGLE_MS` at one pose, the caller is told
 *     `struggling: true` and should offer "take photo anyway" (manual
 *     capture of the current frame, honestly scored by its own quality)
 *     and — for the turn poses — "skip this angle".
 *   * the FRONT pose can never be skipped: it is the calibration frame
 *     the whole measurement pipeline keys on, and a fitting with only
 *     turn frames would have nothing to anchor the iris scale to.
 *
 * Fewer frames is an honest degradation, not a failure: `aggregateFrames`
 * scores cross-frame agreement from whatever it gets, and a single-frame
 * run lands exactly where the single-frame capture path always has.
 */

import { coachMessage, POSE_PROMPT } from "./scan-quality";
import type { CapturePose, QualityResult } from "./scan-quality";

export const GUIDED_POSES: readonly CapturePose[] = [
  "front",
  "front",
  "turn_left",
  "turn_right",
];

/** Consecutive acceptable assessments before a pose auto-captures. */
export const STEADY_FRAMES_REQUIRED = 3;

/** Time at one pose, without a capture, before the escape hatches show. */
export const POSE_STRUGGLE_MS = 12_000;

export interface GuidedCaptureState {
  /** Index into GUIDED_POSES; equal to its length once done. */
  poseIndex: number;
  /** Consecutive acceptable assessments at the current pose. */
  steadyCount: number;
  /** Poses captured so far, in order. */
  captured: CapturePose[];
  /** When the current pose began (caller-supplied clock). */
  poseStartedAtMs: number;
  done: boolean;
}

export type GuidedAction =
  /** Capture the current preview frame at this pose NOW, then call
   *  `advancePose`. */
  | { kind: "capture"; pose: CapturePose }
  /** Quality is acceptable but not yet steady — keep holding. */
  | { kind: "hold"; message: string; struggling: boolean }
  /** Something is failing — surface the coach line for the worst check. */
  | { kind: "coach"; message: string; struggling: boolean };

export function initialGuidedState(nowMs: number): GuidedCaptureState {
  return {
    poseIndex: 0,
    steadyCount: 0,
    captured: [],
    poseStartedAtMs: nowMs,
    done: false,
  };
}

export function currentPose(state: GuidedCaptureState): CapturePose {
  return GUIDED_POSES[Math.min(state.poseIndex, GUIDED_POSES.length - 1)]!;
}

/** The prompt for the pose the patient should be holding right now. */
export function posePrompt(state: GuidedCaptureState): string {
  return POSE_PROMPT[currentPose(state)];
}

/** Only the turn poses may be skipped — see the module header. */
export function canSkipPose(state: GuidedCaptureState): boolean {
  return !state.done && currentPose(state) !== "front";
}

export function guidedProgress(state: GuidedCaptureState): {
  captured: number;
  total: number;
} {
  return { captured: state.captured.length, total: GUIDED_POSES.length };
}

function struggling(state: GuidedCaptureState, nowMs: number): boolean {
  return nowMs - state.poseStartedAtMs >= POSE_STRUGGLE_MS;
}

/**
 * Feed one assessed preview frame into the machine.
 *
 * Pass `null` for `quality` when face detection found no face at all —
 * that is a framing failure, not an absence of information.
 */
export function guidedTick(
  state: GuidedCaptureState,
  quality: QualityResult | null,
  nowMs: number,
): { state: GuidedCaptureState; action: GuidedAction } {
  if (state.done) {
    return {
      state,
      action: { kind: "hold", message: "All set.", struggling: false },
    };
  }
  const pose = currentPose(state);

  if (!quality) {
    const next = { ...state, steadyCount: 0 };
    return {
      state: next,
      action: {
        kind: "coach",
        message: "Fit your whole face in the frame — forehead to chin.",
        struggling: struggling(next, nowMs),
      },
    };
  }

  if (!quality.acceptable) {
    const next = { ...state, steadyCount: 0 };
    // At a turn pose, a failing pose check means "not turned enough (or
    // too far)" — but the generic coach line for `pose` says "look
    // straight at the camera", the exact opposite of the instruction.
    // Re-issue the pose prompt instead.
    const message =
      quality.failing[0] === "pose" && pose !== "front"
        ? POSE_PROMPT[pose]
        : coachMessage(quality, pose);
    return {
      state: next,
      action: {
        kind: "coach",
        message,
        struggling: struggling(next, nowMs),
      },
    };
  }

  const steadyCount = state.steadyCount + 1;
  if (steadyCount >= STEADY_FRAMES_REQUIRED) {
    return {
      state: { ...state, steadyCount },
      action: { kind: "capture", pose },
    };
  }
  return {
    state: { ...state, steadyCount },
    action: {
      kind: "hold",
      message: "Hold it right there…",
      struggling: struggling(state, nowMs),
    },
  };
}

/** Record a capture (auto or manual) at the current pose and move on. */
export function advancePose(
  state: GuidedCaptureState,
  nowMs: number,
): GuidedCaptureState {
  if (state.done) return state;
  const captured = [...state.captured, currentPose(state)];
  const poseIndex = state.poseIndex + 1;
  return {
    poseIndex,
    steadyCount: 0,
    captured,
    poseStartedAtMs: nowMs,
    done: poseIndex >= GUIDED_POSES.length,
  };
}

/** Skip the current (turn) pose without capturing. No-op on `front`. */
export function skipPose(
  state: GuidedCaptureState,
  nowMs: number,
): GuidedCaptureState {
  if (state.done || !canSkipPose(state)) return state;
  const poseIndex = state.poseIndex + 1;
  return {
    ...state,
    poseIndex,
    steadyCount: 0,
    poseStartedAtMs: nowMs,
    done: poseIndex >= GUIDED_POSES.length,
  };
}
