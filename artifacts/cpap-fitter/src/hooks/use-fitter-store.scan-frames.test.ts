// @vitest-environment jsdom

/**
 * A refresh between /measure and submitting the assessment is ordinary
 * patient behaviour, and it goes through `readStoredScanSignals`. If the
 * per-frame diagnostics do not survive that trip, `measurement_frames`
 * lands as null for exactly the sessions where someone reloaded — a
 * silent, biased hole in the record the collection exists to fill.
 *
 * The other half is that bad frames must not take the aggregate with
 * them: `frames` is diagnostic-only, so losing it can never be allowed
 * to cost a patient the measurement-confidence signal that decides their
 * band.
 */

import React from "react";
import { beforeEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";

import { FitterProvider, useFitterStore } from "./use-fitter-store";
import type { ScanSignalsPayload } from "../lib/scan-signals";

const SCAN_SIGNALS_STORAGE_KEY = "fitter_scan_signals";

const sampleFrame = {
  pose: "front" as const,
  source: "burst" as const,
  yawDeg: 2.4,
  pitchDeg: -6.1,
  acceptable: true,
  contributed: true,
  values: { noseWidth: 31.2, noseToChin: 78.4 },
  quality: { lighting: 0.9, distance: 0.82, pose: 0.77 },
};

const sampleSignals: ScanSignalsPayload = {
  frameCount: 1,
  quality: {
    lighting: 0.9,
    distance: 0.82,
    pose: 0.77,
    occlusion: 1,
    motion: 0.95,
    framing: 0.88,
  },
  agreement: { noseWidth: 0.9 },
  measurementConfidence: 0.81,
  band: "high",
  frames: [sampleFrame],
};

function StoreProbe() {
  const store = useFitterStore();
  return React.createElement(
    "output",
    { "data-testid": "scan" },
    JSON.stringify(store.scanSignals),
  );
}

function renderStore() {
  render(
    React.createElement(FitterProvider, null, React.createElement(StoreProbe)),
  );
}

function visibleSignals(): ScanSignalsPayload | null {
  return JSON.parse(screen.getByTestId("scan").textContent ?? "null");
}

function store(signals: unknown) {
  sessionStorage.setItem(SCAN_SIGNALS_STORAGE_KEY, JSON.stringify(signals));
}

beforeEach(() => {
  cleanup();
  sessionStorage.clear();
});

describe("use-fitter-store scan frame persistence", () => {
  it("restores per-frame diagnostics across a reload", () => {
    store(sampleSignals);

    renderStore();

    expect(visibleSignals()?.frames).toEqual([sampleFrame]);
  });

  it("keeps a frame that carries no source", () => {
    const { source: _source, ...noSource } = sampleFrame;
    store({ ...sampleSignals, frames: [noSource] });

    renderStore();

    const frames = visibleSignals()?.frames;
    expect(frames).toHaveLength(1);
    expect(frames?.[0]).not.toHaveProperty("source");
  });

  it("still restores signals saved before frames existed", () => {
    const { frames: _frames, ...legacy } = sampleSignals;
    store(legacy);

    const restored = (renderStore(), visibleSignals());
    expect(restored?.measurementConfidence).toBe(0.81);
    expect(restored).not.toHaveProperty("frames");
  });

  // An unknown key is STRIPPED, not a reason to drop the frame — the
  // restore rebuilds key by key exactly as the aggregate above does, so
  // the stray key cannot reach the server's `.strict()` schema either
  // way. Worth pinning with an image payload specifically: a blob that
  // somehow reached storage must never be forwarded, and the rebuild is
  // what guarantees that.
  it("strips an unknown key rather than losing the frame", () => {
    store({
      ...sampleSignals,
      frames: [{ ...sampleFrame, capturedImage: "data:image/png;base64,xx" }],
    });

    renderStore();

    const frames = visibleSignals()?.frames;
    expect(frames).toEqual([sampleFrame]);
    expect(JSON.stringify(frames)).not.toMatch(/data:|base64/i);
  });

  it.each([
    ["an out-of-range pitch", { ...sampleFrame, pitchDeg: 140 }],
    ["an out-of-range measurement", { ...sampleFrame, values: { x: 5 } }],
    ["a non-unit quality score", { ...sampleFrame, quality: { pose: 4 } }],
    ["a missing boolean", { ...sampleFrame, contributed: undefined }],
    ["an unknown pose", { ...sampleFrame, pose: "sideways" }],
  ])("drops frames with %s but keeps the aggregate", (_label, bad) => {
    store({ ...sampleSignals, frames: [bad] });

    renderStore();

    // The band and confidence still decide the patient's result; only
    // the diagnostic is lost.
    const restored = visibleSignals();
    expect(restored?.band).toBe("high");
    expect(restored?.measurementConfidence).toBe(0.81);
    expect(restored).not.toHaveProperty("frames");
  });

  it("drops a frame array longer than the route accepts", () => {
    store({ ...sampleSignals, frames: Array(11).fill(sampleFrame) });

    renderStore();

    expect(visibleSignals()).not.toHaveProperty("frames");
  });

  it("drops frames that are not an array at all", () => {
    store({ ...sampleSignals, frames: { pose: "front" } });

    renderStore();

    expect(visibleSignals()).not.toHaveProperty("frames");
  });
});
