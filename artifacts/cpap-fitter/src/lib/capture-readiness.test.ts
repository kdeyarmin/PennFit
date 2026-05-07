import { describe, expect, test } from "vitest";
import { getCaptureBlockers, isCaptureReady } from "./capture-readiness";

describe("capture-readiness", () => {
  test("marks camera blocker false until permission + video are both ready", () => {
    expect(getCaptureBlockers(null, false).cameraReady).toBe(false);
    expect(getCaptureBlockers(true, false).cameraReady).toBe(false);
    expect(getCaptureBlockers(false, true).cameraReady).toBe(false);
    expect(getCaptureBlockers(true, true).cameraReady).toBe(true);
  });

  test("isCaptureReady requires the camera blocker to be true", () => {
    expect(isCaptureReady({ cameraReady: true })).toBe(true);
    expect(isCaptureReady({ cameraReady: false })).toBe(false);
  });
});
