import { describe, expect, test } from "vitest";
import { getCaptureBlockers, isCaptureReady } from "./capture-readiness";

describe("capture-readiness", () => {
  test("marks camera blocker false until permission + video are both ready", () => {
    expect(
      getCaptureBlockers(null, false, {
        noGlasses: true,
        evenLight: true,
        facingCamera: true,
      }).cameraReady,
    ).toBe(false);
    expect(
      getCaptureBlockers(true, false, {
        noGlasses: true,
        evenLight: true,
        facingCamera: true,
      }).cameraReady,
    ).toBe(false);
    expect(
      getCaptureBlockers(true, true, {
        noGlasses: true,
        evenLight: true,
        facingCamera: true,
      }).cameraReady,
    ).toBe(true);
  });

  test("isCaptureReady requires every blocker to be true", () => {
    expect(
      isCaptureReady({
        cameraReady: true,
        noGlasses: true,
        evenLight: true,
        facingCamera: true,
      }),
    ).toBe(true);
    expect(
      isCaptureReady({
        cameraReady: true,
        noGlasses: false,
        evenLight: true,
        facingCamera: true,
      }),
    ).toBe(false);
  });
});
