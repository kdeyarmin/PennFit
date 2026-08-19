import { describe, expect, test } from "vitest";
import { getCaptureBlockers, isCaptureReady } from "./capture-readiness";

describe("capture-readiness", () => {
  test("marks camera blocker false until permission + video are both ready", () => {
    expect(getCaptureBlockers(null, false, true).cameraReady).toBe(false);
    expect(getCaptureBlockers(true, false, true).cameraReady).toBe(false);
    expect(getCaptureBlockers(false, true, true).cameraReady).toBe(false);
    expect(getCaptureBlockers(true, true, true).cameraReady).toBe(true);
  });

  test("carries the vision-runtime state as its own blocker", () => {
    expect(getCaptureBlockers(true, true, false).runtimeReady).toBe(false);
    expect(getCaptureBlockers(true, true, true).runtimeReady).toBe(true);
  });

  test("isCaptureReady requires BOTH the camera and the runtime", () => {
    expect(isCaptureReady({ cameraReady: true, runtimeReady: true })).toBe(
      true,
    );
    expect(isCaptureReady({ cameraReady: false, runtimeReady: true })).toBe(
      false,
    );
    // The runtime half used to be a vestigial optional field that nothing
    // populated or read — a caller trusting it would have declared a
    // capture "ready" with no landmarker to measure it.
    expect(isCaptureReady({ cameraReady: true, runtimeReady: false })).toBe(
      false,
    );
  });
});
