import { describe, expect, test } from "vitest";
import type { FacialMeasurements } from "@workspace/api-client-react/storefront";
import {
  canStayOnMeasure,
  FAIL_HINTS,
  failureHints,
  findImplausibleMeasurement,
  SCAN_ESCALATE_AFTER,
} from "./measure-flow";
import { COACH_COPY, DISTANCE_COACH_COPY } from "./scan-quality";

// The canonical face — MediaPipe's metric reference mesh, as
// `extractMeasurementValues` measures it (derived in
// face-measurements.accuracy.test.ts). The previous numbers were
// hand-picked from textbook norms and put `noseHeight` at 48.7 mm, which
// is the nasion→subnasale span; the scanner reports bridge→tip, ~29 mm
// on this same face.
const realisticMeasurements: FacialMeasurements = {
  noseWidth: 35.7,
  noseHeight: 29.4,
  noseToChin: 89.4,
  mouthWidth: 49.1,
  faceWidthAtCheekbones: 153.3,
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

  test("accepts a typical pediatric-face measurement set", () => {
    // The client window is the UNION of the server's adult and pediatric
    // windows: this page doesn't know the population (the chart does,
    // server-side), and an adult-only gate made the server's pediatric
    // path unreachable from the scanner.
    expect(
      findImplausibleMeasurement({
        noseWidth: 18,
        noseHeight: 28,
        noseToChin: 38,
        mouthWidth: 28,
        faceWidthAtCheekbones: 105,
        calibrationMethod: "iris",
      }),
    ).toBeNull();
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

describe("failureHints", () => {
  const frame = (
    scores: Partial<Record<string, number>>,
    distanceHint: "closer" | "farther" | null = null,
  ) => ({
    quality: {
      scores: {
        lighting: 0.9,
        distance: 0.9,
        pose: 0.9,
        occlusion: 0.9,
        motion: 0.9,
        framing: 1,
        ...scores,
      },
      distanceHint,
    },
  });

  test("falls back to the static bullets when nothing was scored", () => {
    const { bullets } = failureHints("no_face", null, 0);
    expect(bullets).toEqual(FAIL_HINTS.no_face);
  });

  test("leads with the failing check's own coach line", () => {
    // The whole point: this capture was measured as too dark, and the
    // codebase already owns the sentence that says so.
    const { bullets } = failureHints(
      "implausible_measurements",
      [frame({ lighting: 0.2 })],
      0,
    );
    expect(bullets[0]).toBe(COACH_COPY.lighting);
    // …and the static advice still follows it.
    expect(bullets).toEqual(
      expect.arrayContaining(FAIL_HINTS.implausible_measurements),
    );
  });

  test("says which way to move when the frames agree on a direction", () => {
    const { bullets } = failureHints(
      "iris_too_small",
      [frame({ distance: 0.3 }, "closer"), frame({ distance: 0.35 }, "closer")],
      0,
    );
    expect(bullets[0]).toBe(DISTANCE_COACH_COPY.closer);
  });

  test("keeps the generic distance line when the frames disagree", () => {
    const { bullets } = failureHints(
      "iris_too_small",
      [frame({ distance: 0.3 }, "closer"), frame({ distance: 0.3 }, "farther")],
      0,
    );
    expect(bullets[0]).toBe(COACH_COPY.distance);
  });

  test("invents no coaching when every check passed", () => {
    // A poster or a screen fails extraction with healthy quality scores.
    // Telling that patient their lighting was poor sends them to fix
    // something that was fine.
    const { bullets } = failureHints(
      "implausible_measurements",
      [frame({})],
      0,
    );
    expect(bullets).toEqual(FAIL_HINTS.implausible_measurements);
  });

  test("averages across frames so one bad frame doesn't pick the advice", () => {
    const { bullets } = failureHints(
      "no_face",
      [frame({ motion: 0.1 }), frame({}), frame({}), frame({}), frame({})],
      0,
    );
    // Mean motion is ~0.74 — above the failing bar, so no coach line.
    expect(bullets).toEqual(FAIL_HINTS.no_face);
  });

  test("escalates on the second failure, not the first", () => {
    expect(failureHints("no_face", null, 1).escalate).toBe(false);
    expect(failureHints("no_face", null, SCAN_ESCALATE_AFTER).escalate).toBe(
      true,
    );
  });

  test("never tells a patient to switch to the front camera", () => {
    // `facingMode: "user"` is hard-coded on both capture pages and there
    // is no camera picker, so that advice sent people hunting for a
    // control that does not exist.
    const all = Object.values(FAIL_HINTS).flat().join(" ");
    expect(all).not.toMatch(/rear camera|selfie camera/i);
  });

  test("tells the eyes-unreadable case about glasses and glare", () => {
    // Its most common physical cause, and the reason it is no longer
    // filed under `no_face` — whose advice is about framing.
    expect(FAIL_HINTS.eyes_unreadable.join(" ")).toMatch(/glasses/i);
  });
});
