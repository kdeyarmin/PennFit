import { describe, expect, test } from "vitest";
import type { FacialMeasurements } from "@workspace/api-client-react/storefront";
import {
  canStayOnMeasure,
  findImplausibleMeasurement,
} from "./measure-flow";

const realisticMeasurements: FacialMeasurements = {
  noseWidth: 35.2,
  noseHeight: 48.7,
  noseToChin: 62.3,
  mouthWidth: 52.1,
  faceWidthAtCheekbones: 138.4,
  calibrationMethod: "iris",
};

describe("findImplausibleMeasurement", () => {
  test("accepts a typical adult-face measurement set", () => {
    expect(findImplausibleMeasurement(realisticMeasurements)).toBeNull();
  });

  test("flags a too-small noseWidth", () => {
    expect(
      findImplausibleMeasurement({ ...realisticMeasurements, noseWidth: 5 }),
    ).toBe("noseWidth");
  });

  test("flags a too-large faceWidthAtCheekbones", () => {
    expect(
      findImplausibleMeasurement({
        ...realisticMeasurements,
        faceWidthAtCheekbones: 500,
      }),
    ).toBe("faceWidthAtCheekbones");
  });

  test("flags NaN / Infinity (calibration math blew up)", () => {
    expect(
      findImplausibleMeasurement({
        ...realisticMeasurements,
        mouthWidth: Number.NaN,
      }),
    ).toBe("mouthWidth");
    expect(
      findImplausibleMeasurement({
        ...realisticMeasurements,
        noseToChin: Number.POSITIVE_INFINITY,
      }),
    ).toBe("noseToChin");
  });

  test("flags negative measurements", () => {
    expect(
      findImplausibleMeasurement({ ...realisticMeasurements, noseHeight: -10 }),
    ).toBe("noseHeight");
  });
});

describe("canStayOnMeasure (route-guard invariant)", () => {
  test("admits a freshly-captured user (image set, no measurements yet)", () => {
    expect(canStayOnMeasure("data:image/jpeg;base64,xxx", null)).toBe(true);
  });

  test("admits the post-extraction window (image cleared for privacy, measurements set)", () => {
    // This is the regression case from PR #124: privacy-clear of the
    // captured image must not bounce the user back to /capture between
    // setMeasurements() and the navigation to /questionnaire firing.
    expect(canStayOnMeasure(null, realisticMeasurements)).toBe(true);
  });

  test("admits the (rare) both-set state", () => {
    expect(
      canStayOnMeasure("data:image/jpeg;base64,xxx", realisticMeasurements),
    ).toBe(true);
  });

  test("rejects a cold-load with no captured image and no measurements", () => {
    // User pasted /measure into the URL bar — should be redirected to
    // /capture by the guard caller.
    expect(canStayOnMeasure(null, null)).toBe(false);
  });
});
