// @vitest-environment jsdom
//
// Behavioural cover for the live capture coach.
//
// Two properties matter most, and neither is about the coaching itself:
//
//   * it must degrade to nothing. The one-tap page worked before this
//     hook existed and has to keep working on a device where the model
//     will not load or the runtime throws — silently, with no error
//     shown to a patient who is not having a problem.
//   * it must not chatter. At 5.5 assessments a second two failing
//     checks can trade places every tick, and a message that strobes is
//     worse than no message.

import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act } from "@testing-library/react";

import {
  useLiveFrameCoach,
  STEADY_FRAMES_REQUIRED,
  NO_ASSESSMENT_GRACE_MS,
  type LandmarkerLike,
} from "./use-live-frame-coach";
import { COACH_COPY } from "@/lib/scan-quality";

/** A face at a plausible scale, straight on — the "good frame" case. */
function frontFaceLandmarks(): Array<{ x: number; y: number }> {
  const pts = Array.from({ length: 478 }, () => ({ x: 0.5, y: 0.5 }));
  const set = (i: number, x: number, y: number) => {
    pts[i] = { x, y };
  };
  set(1, 0.5, 0.542);
  set(234, 0.35, 0.5);
  set(454, 0.65, 0.5);
  set(10, 0.5, 0.24);
  set(152, 0.5, 0.78);
  set(33, 0.41, 0.45);
  set(263, 0.59, 0.45);
  set(168, 0.5, 0.45);
  // Irises: ~28 px across on a 1080-wide frame — mid-window for the
  // distance check, comfortably resolved.
  set(469, 0.487, 0.45);
  set(471, 0.513, 0.45);
  set(474, 0.587, 0.45);
  set(476, 0.613, 0.45);
  return pts;
}

function videoRef(): React.RefObject<HTMLVideoElement | null> {
  const el = document.createElement("video");
  Object.defineProperty(el, "videoWidth", { value: 1080, configurable: true });
  Object.defineProperty(el, "videoHeight", { value: 1440, configurable: true });
  return { current: el };
}

/** A landmarker that always sees the same face. */
function fakeLandmarker(
  landmarks = frontFaceLandmarks(),
): LandmarkerLike & { close: ReturnType<typeof vi.fn> } {
  return {
    detectForVideo: () => ({ faceLandmarks: [landmarks] }),
    close: vi.fn(),
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  // jsdom canvases have no 2D context; the hook's sampleFrame fallback
  // handles that, and the checks under test do not depend on pixels.
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

async function flush() {
  await act(async () => {
    await Promise.resolve();
  });
}

describe("useLiveFrameCoach — degradation", () => {
  it("reports unavailable when the model will not load", async () => {
    const { result } = renderHook(() =>
      useLiveFrameCoach(videoRef(), {
        enabled: true,
        loadLandmarker: () => Promise.reject(new Error("no wasm")),
      }),
    );

    await flush();
    expect(result.current.status).toBe("unavailable");
    expect(result.current.message).toBeNull();
    expect(result.current.ready).toBe(false);
  });

  it("gives up rather than throwing forever when every tick fails", async () => {
    const landmarker: LandmarkerLike & { close: ReturnType<typeof vi.fn> } = {
      detectForVideo: () => {
        throw new Error("runtime gone");
      },
      close: vi.fn(),
    };
    const { result } = renderHook(() =>
      useLiveFrameCoach(videoRef(), {
        enabled: true,
        loadLandmarker: () => Promise.resolve(landmarker),
      }),
    );
    await flush();
    expect(result.current.status).toBe("active");

    await act(async () => {
      vi.advanceTimersByTime(180 * 30);
    });
    expect(result.current.status).toBe("unavailable");
    // And it hands the native memory back at that moment rather than
    // holding it until the patient leaves the page. The devices that
    // reach this path are the constrained ones, so an idle WASM/GPU
    // landmarker is worst exactly here.
    expect(landmarker.close).toHaveBeenCalled();
  });

  it("releases the landmarker when no assessment is ever possible", async () => {
    // The other give-up path: nothing throws, but the video never
    // produces a frame worth assessing, so the grace period expires.
    const landmarker = fakeLandmarker();
    const emptyVideo = {
      current: document.createElement("video"),
    } as React.RefObject<HTMLVideoElement | null>;
    const { result } = renderHook(() =>
      useLiveFrameCoach(emptyVideo, {
        enabled: true,
        loadLandmarker: () => Promise.resolve(landmarker),
      }),
    );
    await flush();

    await act(async () => {
      vi.advanceTimersByTime(NO_ASSESSMENT_GRACE_MS + 180 * 2);
    });
    expect(result.current.status).toBe("unavailable");
    expect(landmarker.close).toHaveBeenCalled();
  });

  it("closes the landmarker on unmount — it holds native memory", async () => {
    const landmarker = fakeLandmarker();
    const { unmount } = renderHook(() =>
      useLiveFrameCoach(videoRef(), {
        enabled: true,
        loadLandmarker: () => Promise.resolve(landmarker),
      }),
    );
    await flush();
    unmount();
    expect(landmarker.close).toHaveBeenCalled();
  });
});

describe("useLiveFrameCoach — coaching", () => {
  it("reaches steady only after a run of acceptable frames", async () => {
    const { result } = renderHook(() =>
      useLiveFrameCoach(videoRef(), {
        enabled: true,
        loadLandmarker: () => Promise.resolve(fakeLandmarker()),
      }),
    );
    await flush();

    // One good frame is not a steady hand.
    await act(async () => {
      vi.advanceTimersByTime(180);
    });
    expect(result.current.steady).toBe(false);

    await act(async () => {
      vi.advanceTimersByTime(180 * STEADY_FRAMES_REQUIRED);
    });
    expect(result.current.ready).toBe(true);
    expect(result.current.steady).toBe(true);
  });

  it("names the framing problem when no face is in view", async () => {
    const empty: LandmarkerLike = {
      detectForVideo: () => ({ faceLandmarks: [] }),
    };
    const { result } = renderHook(() =>
      useLiveFrameCoach(videoRef(), {
        enabled: true,
        loadLandmarker: () => Promise.resolve(empty),
      }),
    );
    await flush();
    await act(async () => {
      vi.advanceTimersByTime(180 * 2);
    });

    expect(result.current.ready).toBe(false);
    expect(result.current.message).toBe(COACH_COPY.framing);
  });

  it("does not tick while disabled — a capture in flight is not coached", async () => {
    const detect = vi.fn(() => ({ faceLandmarks: [frontFaceLandmarks()] }));
    const { result } = renderHook(() =>
      useLiveFrameCoach(videoRef(), {
        enabled: false,
        loadLandmarker: () => Promise.resolve({ detectForVideo: detect }),
      }),
    );
    await flush();
    await act(async () => {
      vi.advanceTimersByTime(180 * 5);
    });

    expect(detect).not.toHaveBeenCalled();
    expect(result.current.steady).toBe(false);
  });
});
