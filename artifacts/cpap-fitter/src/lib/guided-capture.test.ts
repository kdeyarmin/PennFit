import { describe, expect, it } from "vitest";

import {
  advancePose,
  canSkipPose,
  currentPose,
  GUIDED_POSES,
  guidedProgress,
  guidedTick,
  initialGuidedState,
  POSE_STRUGGLE_MS,
  skipPose,
  STEADY_FRAMES_REQUIRED,
} from "./guided-capture";
import type { QualityResult } from "./scan-quality";

function quality(acceptable: boolean, failing: QualityResult["failing"] = []) {
  return {
    scores: {
      lighting: acceptable ? 0.9 : 0.3,
      distance: 0.9,
      pose: 0.9,
      occlusion: 0.9,
      motion: 0.9,
      framing: 1,
    },
    failing: acceptable ? [] : failing.length > 0 ? failing : ["lighting"],
    acceptable,
    overall: acceptable ? 0.9 : 0.3,
  } satisfies QualityResult;
}

describe("guided capture state machine", () => {
  it("walks front twice, then the turns, in order", () => {
    // Two front captures are load-bearing: measurements sample only
    // near-frontal frames, and the aggregate caps any single-sampled
    // measurement below the high band — one front frame would lock
    // every guided fitting out of high confidence.
    let state = initialGuidedState(0);
    expect(currentPose(state)).toBe("front");
    state = advancePose(state, 0);
    expect(currentPose(state)).toBe("front");
    state = advancePose(state, 0);
    expect(currentPose(state)).toBe("turn_left");
    state = advancePose(state, 0);
    expect(currentPose(state)).toBe("turn_right");
    state = advancePose(state, 0);
    expect(state.done).toBe(true);
    expect(state.captured).toEqual(GUIDED_POSES);
  });

  it("captures only after the required consecutive acceptable frames", () => {
    let state = initialGuidedState(0);
    for (let i = 0; i < STEADY_FRAMES_REQUIRED - 1; i += 1) {
      const tick = guidedTick(state, quality(true), 100 * i);
      state = tick.state;
      expect(tick.action.kind).toBe("hold");
    }
    const final = guidedTick(state, quality(true), 1_000);
    expect(final.action).toEqual({ kind: "capture", pose: "front" });
  });

  it("resets the steady streak on an unacceptable frame", () => {
    let state = initialGuidedState(0);
    state = guidedTick(state, quality(true), 0).state;
    state = guidedTick(state, quality(true), 100).state;
    const bad = guidedTick(state, quality(false), 200);
    expect(bad.action.kind).toBe("coach");
    expect(bad.state.steadyCount).toBe(0);
    // The streak starts over — one good frame is not enough again.
    const next = guidedTick(bad.state, quality(true), 300);
    expect(next.action.kind).toBe("hold");
  });

  it("coaches the worst failing check by name", () => {
    const state = initialGuidedState(0);
    const tick = guidedTick(state, quality(false, ["lighting"]), 0);
    expect(tick.action.kind).toBe("coach");
    if (tick.action.kind === "coach") {
      expect(tick.action.message).toMatch(/light/i);
    }
  });

  it("re-issues the turn prompt (not 'look straight') for a pose failure mid-turn", () => {
    let state = initialGuidedState(0);
    state = advancePose(state, 0); // second front
    state = advancePose(state, 0); // now at turn_left
    const tick = guidedTick(state, quality(false, ["pose"]), 0);
    expect(tick.action.kind).toBe("coach");
    if (tick.action.kind === "coach") {
      expect(tick.action.message).toMatch(/turn your head/i);
      expect(tick.action.message).not.toMatch(/straight/i);
    }
  });

  it("treats a missing face as a framing coach, never a capture", () => {
    let state = initialGuidedState(0);
    state = guidedTick(state, quality(true), 0).state;
    state = guidedTick(state, quality(true), 100).state;
    const tick = guidedTick(state, null, 200);
    expect(tick.action.kind).toBe("coach");
    expect(tick.state.steadyCount).toBe(0);
  });

  it("flags struggling only after the struggle window", () => {
    const state = initialGuidedState(0);
    const early = guidedTick(state, quality(false), POSE_STRUGGLE_MS - 1);
    expect(early.action.kind).toBe("coach");
    if (early.action.kind === "coach") {
      expect(early.action.struggling).toBe(false);
    }
    const late = guidedTick(early.state, quality(false), POSE_STRUGGLE_MS + 1);
    if (late.action.kind === "coach") {
      expect(late.action.struggling).toBe(true);
    }
  });

  it("advancePose resets the struggle clock", () => {
    let state = initialGuidedState(0);
    state = advancePose(state, POSE_STRUGGLE_MS + 5_000);
    const tick = guidedTick(state, quality(false), POSE_STRUGGLE_MS + 6_000);
    if (tick.action.kind === "coach") {
      expect(tick.action.struggling).toBe(false);
    }
  });

  it("never allows skipping either front capture", () => {
    let state = initialGuidedState(0);
    expect(canSkipPose(state)).toBe(false);
    expect(skipPose(state, 0)).toBe(state);
    state = advancePose(state, 0); // at the second front
    expect(canSkipPose(state)).toBe(false);
    expect(skipPose(state, 0)).toBe(state);
  });

  it("allows skipping the turn poses and finishes with fewer frames", () => {
    let state = initialGuidedState(0);
    state = advancePose(state, 0); // front #1 captured
    state = advancePose(state, 0); // front #2 captured
    expect(canSkipPose(state)).toBe(true);
    state = skipPose(state, 0); // skip turn_left
    state = skipPose(state, 0); // skip turn_right
    expect(state.done).toBe(true);
    expect(state.captured).toEqual(["front", "front"]);
    expect(guidedProgress(state)).toEqual({ captured: 2, total: 4 });
  });

  it("is inert once done", () => {
    let state = initialGuidedState(0);
    state = advancePose(state, 0);
    state = advancePose(state, 0);
    state = skipPose(state, 0);
    state = skipPose(state, 0);
    expect(state.done).toBe(true);
    const tick = guidedTick(state, quality(true), 0);
    expect(tick.action.kind).toBe("hold");
    expect(advancePose(state, 0)).toBe(state);
    expect(skipPose(state, 0)).toBe(state);
  });
});
