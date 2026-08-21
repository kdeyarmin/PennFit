import { describe, expect, it } from "vitest";

import {
  COACH_SPEECH_MIN_GAP_MS,
  COACH_SPEECH_REPEAT_GAP_MS,
  createCaptureFeedback,
  shouldSpeakCoachLine,
} from "./capture-feedback";

describe("shouldSpeakCoachLine", () => {
  it("speaks the very first line immediately", () => {
    expect(shouldSpeakCoachLine(null, "Turn a little further…", 0)).toBe(true);
  });

  it("never speaks an empty line", () => {
    expect(shouldSpeakCoachLine(null, "", 0)).toBe(false);
  });

  it("holds a NEW line inside the minimum gap — no per-tick chatter", () => {
    const last = { text: "Hold it right there…", atMs: 1_000 };
    expect(
      shouldSpeakCoachLine(
        last,
        "Turn a little further…",
        1_000 + COACH_SPEECH_MIN_GAP_MS - 1,
      ),
    ).toBe(false);
    expect(
      shouldSpeakCoachLine(
        last,
        "Turn a little further…",
        1_000 + COACH_SPEECH_MIN_GAP_MS,
      ),
    ).toBe(true);
  });

  it("repeats the SAME line only after the longer gap", () => {
    const last = { text: "Turn a little further…", atMs: 5_000 };
    // Past the minimum gap but same text — still held.
    expect(
      shouldSpeakCoachLine(
        last,
        "Turn a little further…",
        5_000 + COACH_SPEECH_MIN_GAP_MS + 1,
      ),
    ).toBe(false);
    // Past the repeat gap — the patient mid-struggle gets a reminder.
    expect(
      shouldSpeakCoachLine(
        last,
        "Turn a little further…",
        5_000 + COACH_SPEECH_REPEAT_GAP_MS,
      ),
    ).toBe(true);
  });
});

describe("createCaptureFeedback", () => {
  // These run in the plain node environment: no window, no AudioContext,
  // no speechSynthesis, no navigator.vibrate. The contract under test is
  // that every channel silently no-ops — feedback must never be able to
  // break the capture flow it decorates.
  it("constructs and runs every channel without any browser API", () => {
    const feedback = createCaptureFeedback();
    expect(feedback.enabled).toBe(true); // eyes-free default is ON
    expect(() => feedback.frameCaptured()).not.toThrow();
    expect(() => feedback.allDone()).not.toThrow();
    expect(() => feedback.speak("Look straight at the camera.")).not.toThrow();
    expect(() =>
      feedback.speak("Now turn your head.", { interrupt: true }),
    ).not.toThrow();
  });

  it("tracks the enabled flag in memory when storage is unavailable", () => {
    const feedback = createCaptureFeedback();
    feedback.setEnabled(false);
    expect(feedback.enabled).toBe(false);
    expect(() => feedback.frameCaptured()).not.toThrow();
    feedback.setEnabled(true);
    expect(feedback.enabled).toBe(true);
  });
});
