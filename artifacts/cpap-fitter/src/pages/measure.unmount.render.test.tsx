// @vitest-environment jsdom
//
// The scan-failure counter must only count failures a patient SAW.
//
// `/measure` deliberately has no effect-local cleanup — the analysis
// keeps running across the re-renders that clearing the captured image
// causes — so a patient who leaves mid-extraction (Back, or one of the
// escape hatches this PR added) leaves an in-flight async pipeline
// behind them. When that pipeline later rejects, the catch runs on an
// unmounted component.
//
// The error it would show is correctly suppressed. The COUNTER was not,
// and it is persisted in sessionStorage: a silent bump there makes the
// patient's next real failure the "second" one, so a single visible
// failure escalates straight to "ask us to call you" — offering a
// hand-off on a first try that may well have been recoverable with the
// coaching hint alone.

import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { render, cleanup, act } from "@testing-library/react";

const { store, loaderControl } = vi.hoisted(() => ({
  store: {
    capturedImage: "data:image/jpeg;base64,AAAA",
    capturedFrames: [
      {
        dataUrl: "data:image/jpeg;base64,AAAA",
        pose: "front" as const,
        source: "burst" as const,
      },
    ],
    measurements: null,
    scanSignals: null,
    setMeasurements: vi.fn(),
    setCapturedImage: vi.fn(),
    setCapturedFrames: vi.fn(),
    scanFailureCount: 0,
    bumpScanFailureCount: vi.fn(),
  },
  loaderControl: {
    reject: null as null | ((err: Error) => void),
  },
}));

vi.mock("wouter", () => ({
  useLocation: () => ["/measure", vi.fn()],
  Link: ({
    children,
    ...props
  }: {
    children: React.ReactNode;
    [key: string]: unknown;
  }) => <a {...props}>{children}</a>,
}));
vi.mock("@/hooks/use-fitter-store", () => ({
  useFitterStore: () => store,
}));
vi.mock("@/lib/track", () => ({ track: vi.fn() }));
vi.mock("@/hooks/use-document-title", () => ({
  useDocumentTitle: vi.fn(),
}));
vi.mock("@/lib/landmarker-loader", () => ({
  MODEL_LOAD_TIMEOUT_MS: 20_000,
  LandmarkerLoadTimeout: class extends Error {},
  // A promise the test settles by hand, so the unmount can be placed
  // precisely between "extraction started" and "extraction failed".
  loadFaceLandmarker: () =>
    new Promise((_resolve, reject) => {
      loaderControl.reject = reject;
    }),
}));

import { Measure } from "./measure";

beforeEach(() => {
  vi.useFakeTimers();
  store.bumpScanFailureCount.mockClear();
  loaderControl.reject = null;
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

/** Render, and let the 100 ms kick-off timer start the extraction. */
async function startExtraction() {
  const view = render(<Measure />);
  await act(async () => {
    vi.advanceTimersByTime(150);
  });
  expect(loaderControl.reject).not.toBeNull();
  return view;
}

describe("Measure — a failure nobody was there to see", () => {
  it("does not bank a scan failure when the patient already left", async () => {
    const { unmount } = await startExtraction();

    // The patient takes an escape hatch while the model is still
    // downloading; the model load then fails behind them.
    unmount();
    await act(async () => {
      loaderControl.reject!(new Error("model fetch failed"));
      await Promise.resolve();
    });

    expect(store.bumpScanFailureCount).not.toHaveBeenCalled();
  });

  it("still banks one when the patient is there to be told", async () => {
    // The positive control, without which the assertion above passes for
    // the wrong reason — a counter that never increments at all would
    // silently disable escalation entirely.
    await startExtraction();

    await act(async () => {
      loaderControl.reject!(new Error("model fetch failed"));
      await Promise.resolve();
    });

    expect(store.bumpScanFailureCount).toHaveBeenCalledTimes(1);
  });
});
