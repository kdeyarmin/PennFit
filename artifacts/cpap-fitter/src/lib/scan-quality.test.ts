// Scan quality gates and multi-frame aggregation.
//
// The behaviour worth protecting: a bad frame must not produce a
// confident measurement. Each gate gets a boundary test, and the
// aggregation gets the two properties that justify multi-angle capture at
// all — the median resists one bad frame, and cross-frame disagreement
// lowers confidence.

import { describe, expect, it } from "vitest";

import {
  aggregateFrames,
  assessFrameQuality,
  CAPTURE_DISTANCE_MM_BOUNDS,
  centroidOf,
  coachMessage,
  estimateCameraDistanceMm,
  estimatePoseFromLandmarks,
  poseCorrect,
  turnCoachNudge,
  type CapturePose,
  type FrameMeasurement,
  type Point2D,
  type QualityInput,
  type QualityResult,
} from "./scan-quality";
import { ASSUMED_HFOV_DEG, IRIS_DIAMETER_MM } from "./face-measurements";

/** A landmark array with every index the checks look at, centred and level. */
function goodLandmarks(): Point2D[] {
  const pts: Point2D[] = new Array(478)
    .fill(null)
    .map(() => ({ x: 0.5, y: 0.5 }));
  pts[1] = { x: 0.5, y: 0.55 }; // nose tip
  pts[10] = { x: 0.5, y: 0.15 }; // forehead
  pts[152] = { x: 0.5, y: 0.9 }; // chin
  pts[168] = { x: 0.5, y: 0.42 }; // nose bridge
  pts[234] = { x: 0.3, y: 0.55 }; // left cheek
  pts[454] = { x: 0.7, y: 0.55 }; // right cheek
  pts[33] = { x: 0.38, y: 0.4 }; // left eye outer
  pts[263] = { x: 0.62, y: 0.4 }; // right eye outer
  return pts;
}

function input(over: Partial<QualityInput> = {}): QualityInput {
  return {
    landmarks: goodLandmarks(),
    irisWidthPx: 30, // ~37 cm on this 1280x720 frame — inside the window
    frameWidth: 1280,
    frameHeight: 720,
    faceLuma: 135,
    faceLumaLeft: 133,
    faceLumaRight: 137,
    sharpness: 120,
    yawDeg: 0,
    pitchDeg: 0,
    rollDeg: 0,
    pose: "front" as CapturePose,
    ...over,
  };
}

describe("frame quality gates", () => {
  it("accepts a well-lit, level, in-frame capture", () => {
    const result = assessFrameQuality(input());
    expect(result.acceptable).toBe(true);
    expect(result.failing).toEqual([]);
    expect(result.overall).toBeGreaterThan(0.8);
  });

  it("rejects an underexposed frame and says why", () => {
    const result = assessFrameQuality(input({ faceLuma: 25 }));
    expect(result.acceptable).toBe(false);
    expect(result.failing).toContain("lighting");
    expect(coachMessage(result, "front")).toMatch(/light/i);
  });

  it("catches harsh side lighting that the mean alone would pass", () => {
    // Mean luma is a perfectly acceptable 135 here; the imbalance is the
    // problem, and it is exactly what warps one side of the measurement.
    const result = assessFrameQuality(
      input({ faceLuma: 135, faceLumaLeft: 60, faceLumaRight: 210 }),
    );
    expect(result.failing).toContain("lighting");
  });

  // 110 px (~10 cm on this frame), not the 70 px an earlier revision
  // used: the near bound carries the assumed-FOV tolerance
  // (CAPTURE_DISTANCE_MM_BOUNDS), so a 16 cm hold is inside what a
  // wide-lens camera could legitimately report and is no longer refused.
  it("rejects a face held too far away and too close", () => {
    expect(assessFrameQuality(input({ irisWidthPx: 10 })).failing).toContain(
      "distance",
    );
    expect(assessFrameQuality(input({ irisWidthPx: 110 })).failing).toContain(
      "distance",
    );
  });

  it("tells the patient WHICH WAY to move, not just that distance is wrong", () => {
    const tooFar = assessFrameQuality(input({ irisWidthPx: 10 }));
    expect(tooFar.distanceHint).toBe("closer");
    expect(coachMessage(tooFar, "front")).toMatch(/closer/i);

    const tooClose = assessFrameQuality(input({ irisWidthPx: 110 }));
    expect(tooClose.distanceHint).toBe("farther");
    expect(coachMessage(tooClose, "front")).toMatch(/further|back/i);

    // A frame at a good range carries no hint to give.
    expect(assessFrameQuality(input()).distanceHint).toBeNull();
  });

  // The check used to be a raw px/mm window, which is a function of the
  // CAPTURE RESOLUTION as much as of where the patient is standing.
  // `getUserMedia` only asks for 1280x720 with `ideal`, so any device
  // that serves something else had its distance mis-read — a patient at
  // a correct arm's length was rejected on a 640-wide stream, and one at
  // 25 cm was told they were too FAR on a 1920-wide one.
  describe("distance is judged in millimetres, not pixels", () => {
    /** Iris pixel width a real camera produces at this range. */
    const irisPxAt = (longAxis: number, distanceMm: number) => {
      const focalPx =
        longAxis / (2 * Math.tan((ASSUMED_HFOV_DEG / 2) * (Math.PI / 180)));
      return (focalPx * IRIS_DIAMETER_MM) / distanceMm;
    };

    const STREAMS: Array<[number, number]> = [
      [640, 480],
      [1280, 720],
      [1920, 1080],
      [1080, 1440], // portrait, the posture phones actually use
    ];

    it("accepts arm's length on every stream size a camera might serve", () => {
      for (const [w, h] of STREAMS) {
        const long = Math.max(w, h);
        // 640-long-axis streams resolve the iris to ~14 px at 40 cm and
        // ~11 px at 50 cm — under `extractMeasurementValues`'s own
        // `iris_too_small` cliff — so their usable range genuinely ends
        // sooner. Everything from 1280 up covers the whole span.
        const range = long <= 640 ? [300, 400] : [300, 400, 500];
        for (const distanceMm of range) {
          const result = assessFrameQuality(
            input({
              frameWidth: w,
              frameHeight: h,
              irisWidthPx: irisPxAt(long, distanceMm),
            }),
          );
          expect(
            result.failing,
            `${w}x${h} at ${distanceMm}mm should not fail on distance`,
          ).not.toContain("distance");
        }
      }
    });

    it("asks a low-resolution camera to come closer rather than stalling", () => {
      // 50 cm on a 640-wide stream leaves the iris ~11 px across, below
      // the extractor's calibration cliff. The frame must be refused —
      // but with the one instruction that actually fixes it, since the
      // patient cannot change their camera's resolution.
      const result = assessFrameQuality(
        input({
          frameWidth: 640,
          frameHeight: 480,
          irisWidthPx: irisPxAt(640, 500),
        }),
      );
      expect(result.failing).toContain("distance");
      expect(result.distanceHint).toBe("closer");
      expect(coachMessage(result, "front")).toMatch(/closer/i);
    });

    it("still refuses genuinely bad range on every stream size", () => {
      for (const [w, h] of STREAMS) {
        const long = Math.max(w, h);
        for (const distanceMm of [120, 950]) {
          const result = assessFrameQuality(
            input({
              frameWidth: w,
              frameHeight: h,
              irisWidthPx: irisPxAt(long, distanceMm),
            }),
          );
          expect(
            result.failing,
            `${w}x${h} at ${distanceMm}mm should fail on distance`,
          ).toContain("distance");
        }
      }
    });

    it("scores a 10 cm hold as TOO CLOSE on a high-resolution stream", () => {
      // The old px/mm window read this as "too far" — the exact opposite
      // instruction — because 1920 pixels put the iris well past its
      // upper bound.
      //
      // 10 cm, not 15: the range estimate assumes a 68° field of view it
      // cannot measure, so it resolves gross error and nothing finer
      // (see CAPTURE_DISTANCE_MM_BOUNDS). Asserting a 15 cm hold would
      // pin precision the estimate does not have on a real camera.
      const result = assessFrameQuality(
        input({
          frameWidth: 1920,
          frameHeight: 1080,
          irisWidthPx: irisPxAt(1920, 100),
        }),
      );
      expect(result.failing).toContain("distance");
      expect(result.distanceHint).toBe("farther");
    });

    it("does not refuse arm's length on a camera wider than the assumed FOV", () => {
      // The estimate scales by tan(θ_true/2)/tan(34°), so an 80° front
      // camera reads a genuine 550 mm as ~684 mm. Bounds drawn tightly
      // around the range we want would reject this patient for owning
      // the wrong phone — which is why they are widened by that factor.
      const focalPx80 = 1280 / (2 * Math.tan((80 / 2) * (Math.PI / 180)));
      const irisPx = (focalPx80 * IRIS_DIAMETER_MM) / 550;
      const result = assessFrameQuality(
        input({ frameWidth: 1280, frameHeight: 720, irisWidthPx: irisPx }),
      );
      expect(result.failing).not.toContain("distance");
    });

    it("says CLOSER when the iris is under-resolved, even inside the near bound", () => {
      // A 320x240 stream at ~249 mm leaves the iris ~11 px — under the
      // extractor's calibration cliff — while the range term reads "too
      // close". Keying the hint on range alone told this patient to move
      // BACK, which shrinks the iris further and walks them straight
      // into `iris_too_small`.
      const result = assessFrameQuality(
        input({
          frameWidth: 320,
          frameHeight: 240,
          irisWidthPx: irisPxAt(320, 249),
        }),
      );
      expect(result.failing).toContain("distance");
      expect(result.distanceHint).toBe("closer");
      expect(coachMessage(result, "front")).toMatch(/closer/i);
    });

    it("marks down an iris too few pixels across to calibrate from", () => {
      // Correct range, but a low-resolution sensor: the millimetre scale
      // is one short iris span, so every measurement inherits its noise.
      const result = assessFrameQuality(
        input({ frameWidth: 640, frameHeight: 480, irisWidthPx: 12 }),
      );
      expect(result.scores.distance).toBeLessThan(0.8);
      expect(
        result.distanceHint === null || result.distanceHint === "closer",
      ).toBe(true);
    });

    it("agrees with the extractor's own distance estimate", () => {
      // Same physics, same long-axis focal anchor — the two must not
      // drift, or the quality gate and the measurement disagree about
      // where the patient is.
      expect(
        estimateCameraDistanceMm(irisPxAt(1280, 400), 1280, 720),
      ).toBeCloseTo(400, 3);
      expect(
        estimateCameraDistanceMm(irisPxAt(1440, 400), 1080, 1440),
      ).toBeCloseTo(400, 3);
      expect(estimateCameraDistanceMm(0, 1280, 720)).toBeNull();
      expect(estimateCameraDistanceMm(30, 0, 0)).toBeNull();
    });

    it("carries enough FOV tolerance that no real camera rejects arm's length", () => {
      // The bounds are the range we want (250-630 mm) widened by the
      // worst-case field-of-view error, because the estimate assumes a
      // 68 degree FOV it cannot measure and real front cameras run
      // 55-85. Pin the derivation, not the numbers: whatever the bounds
      // become, they must still admit both edges of the intended range
      // as the most extreme lens would report them.
      const reportedFactor = (trueFovDeg: number) =>
        Math.tan((trueFovDeg / 2) * (Math.PI / 180)) /
        Math.tan((ASSUMED_HFOV_DEG / 2) * (Math.PI / 180));
      // A patient at 250 mm on the narrowest lens reads shorter...
      expect(CAPTURE_DISTANCE_MM_BOUNDS.min).toBeLessThanOrEqual(
        250 * reportedFactor(55),
      );
      // ...and one at 630 mm on the widest reads longer.
      expect(CAPTURE_DISTANCE_MM_BOUNDS.max).toBeGreaterThanOrEqual(
        630 * reportedFactor(85),
      );
      // Tolerance, not abdication — the term must still catch gross error.
      expect(CAPTURE_DISTANCE_MM_BOUNDS.min).toBeGreaterThanOrEqual(150);
      expect(CAPTURE_DISTANCE_MM_BOUNDS.max).toBeLessThanOrEqual(1000);
    });
  });

  it("never refuses a frame without naming something to fix", () => {
    // Acceptance needs the COMPOSITE over 0.6 as well as every check
    // over its own floor, and the composite is dragged down by the
    // weakest check whether or not that check is itself failing. A frame
    // where everything sits just above the floor is therefore refused
    // with nothing in `failing` — and the coach answered an empty list
    // with "Hold it right there…", so the patient held a frame that
    // would never be taken while being told they had it right.
    const marginal = assessFrameQuality(
      input({
        faceLuma: 70,
        faceLumaLeft: 51,
        faceLumaRight: 89,
        sharpness: 34.5,
        irisWidthPx: 12.285, // barely-resolved iris on this 1280x720 frame
        yawDeg: 5,
        pitchDeg: 10,
        rollDeg: 8,
      }),
    );
    // The situation this exists for: nothing is under its own floor…
    for (const [check, score] of Object.entries(marginal.scores)) {
      expect(
        score,
        `${check} should sit above its own 0.6 floor`,
      ).toBeGreaterThanOrEqual(0.6);
    }
    // …yet the composite refuses the frame.
    expect(marginal.overall).toBeLessThan(0.6);
    expect(marginal.acceptable).toBe(false);
    // So the coach must still have something to say — the weakest check.
    expect(marginal.failing.length).toBeGreaterThan(0);
    expect(coachMessage(marginal, "front")).not.toMatch(/hold it right there/i);
  });

  it("rejects a turned head on the frontal pose but accepts it on a turn pose", () => {
    const turned = { yawDeg: 20 };
    expect(
      assessFrameQuality(input({ ...turned, pose: "front" })).failing,
    ).toContain("pose");
    expect(
      assessFrameQuality(input({ ...turned, pose: "turn_right" })).acceptable,
    ).toBe(true);
  });

  it("refuses a near-frontal frame as a turn, however level the head", () => {
    // Perfect pitch/roll must not lift the composite over the bar at ~1°
    // of real yaw — that would auto-capture a straight-on frame as a
    // completed turn angle. A turn frame has to clear the near-frontal
    // measurement window (MEASUREMENT_YAW_LIMIT_DEG) to count.
    for (const yawDeg of [1, 5, 10]) {
      const result = assessFrameQuality(input({ yawDeg, pose: "turn_right" }));
      expect(result.acceptable).toBe(false);
      expect(result.failing).toContain("pose");
    }
    // Just past the window, the turn is real and acceptance resumes.
    expect(
      assessFrameQuality(input({ yawDeg: 14, pose: "turn_right" })).acceptable,
    ).toBe(true);
  });

  it("tolerates the self-shadow a turn manufactures, but only at a turn pose", () => {
    // Turning the head in even light rotates the far cheek into its own
    // shadow — the imbalance is caused by the pose the flow asked for.
    // The same delta on a FRONT frame is real side light and still fails:
    // front frames are where the measurements come from.
    const sideShadow = { faceLumaLeft: 100, faceLumaRight: 170 };
    expect(
      assessFrameQuality(input({ ...sideShadow, pose: "front" })).failing,
    ).toContain("lighting");
    const turned = assessFrameQuality(
      input({ ...sideShadow, pose: "turn_right", yawDeg: 20 }),
    );
    expect(turned.failing).not.toContain("lighting");
    expect(turned.acceptable).toBe(true);
    // The leniency keys to the ACTUAL yaw, not the nominal step: a frame
    // still inside the near-frontal measurement window would contribute
    // measurement samples, so it keeps the strict frontal balance bar
    // even while the flow is on a turn step.
    expect(
      assessFrameQuality(
        input({ ...sideShadow, pose: "turn_right", yawDeg: 6 }),
      ).failing,
    ).toContain("lighting");
  });

  it("rejects a blurred frame", () => {
    const result = assessFrameQuality(input({ sharpness: 5 }));
    expect(result.failing).toContain("occlusion");
  });

  it("hard-fails an incomplete capture even when everything else is perfect", () => {
    // Chin off-screen. We cannot measure what is not in frame, and a
    // clipped chin silently shortens nose-to-chin.
    const landmarks = goodLandmarks();
    landmarks[152] = { x: 0.5, y: 1.02 };
    const result = assessFrameQuality(input({ landmarks }));
    expect(result.scores.framing).toBe(0);
    expect(result.acceptable).toBe(false);
  });

  it("penalises a moving face", () => {
    const here = centroidOf(goodLandmarks());
    const result = assessFrameQuality(
      input({
        previousCentroids: [{ x: here.x + 0.05, y: here.y }],
      }),
    );
    expect(result.failing).toContain("motion");
  });

  it("does not penalise motion on the very first frame", () => {
    expect(assessFrameQuality(input()).scores.motion).toBe(1);
  });
});

describe("geometric pose fallback", () => {
  it("reads a level, forward-facing head as roughly zero on all axes", () => {
    const pose = estimatePoseFromLandmarks(goodLandmarks());
    expect(Math.abs(pose.yawDeg)).toBeLessThan(5);
    expect(Math.abs(pose.rollDeg)).toBeLessThan(5);
    // Pitch included deliberately: the estimator used to measure the
    // eye-to-BRIDGE span (which is ~0 on every face) against a baseline
    // built for eye-to-nose-tip, reading every level head as ~-30° and
    // silently zeroing the pose score on all real captures.
    expect(Math.abs(pose.pitchDeg)).toBeLessThan(5);
  });

  it("detects a pitched head from the nose-tip-to-eye-line span", () => {
    // Head tilted: the nose tip projects up toward the eye line.
    const pitched = goodLandmarks();
    pitched[1] = { x: 0.5, y: 0.46 };
    expect(
      Math.abs(estimatePoseFromLandmarks(pitched).pitchDeg),
    ).toBeGreaterThan(10);
  });

  it("detects a turn from cheek asymmetry, with the right sign", () => {
    const left = goodLandmarks();
    left[1] = { x: 0.38, y: 0.55 }; // nose swung toward the left cheek
    const right = goodLandmarks();
    right[1] = { x: 0.62, y: 0.55 };
    expect(estimatePoseFromLandmarks(left).yawDeg).toBeGreaterThan(10);
    expect(estimatePoseFromLandmarks(right).yawDeg).toBeLessThan(-10);
  });

  it("detects head tilt from the eye line", () => {
    const tilted = goodLandmarks();
    tilted[33] = { x: 0.38, y: 0.36 };
    tilted[263] = { x: 0.62, y: 0.44 };
    expect(Math.abs(estimatePoseFromLandmarks(tilted).rollDeg)).toBeGreaterThan(
      10,
    );
  });

  it("reads roll in true degrees, not degrees times the frame's aspect", () => {
    // Landmarks are normalised PER AXIS, so an atan2 that mixes x and y
    // reports atan(aspect · tan θ) unless the frame is square. Yaw (a
    // ratio of x's) and pitch (a ratio of y's) cancel the aspect out;
    // roll does not. Left unfixed, a true 10° tilt read as 17.4° on a
    // 16:9 landscape stream — past where the pose score collapses — and
    // as 5.7° on a 9:16 portrait one, slack enough to pass.
    const tiltedBy = (deg: number, w: number, h: number): Point2D[] => {
      const pts = goodLandmarks();
      const half = 0.12; // half the eye span, in normalised x
      const rad = (deg * Math.PI) / 180;
      // Build the eye line at a TRUE `deg` tilt in pixel space, then
      // express it back in normalised units the way MediaPipe would.
      const dxPx = 2 * half * w * Math.cos(rad);
      const dyPx = 2 * half * w * Math.sin(rad);
      pts[33] = { x: 0.5 - dxPx / (2 * w), y: 0.4 - dyPx / (2 * h) };
      pts[263] = { x: 0.5 + dxPx / (2 * w), y: 0.4 + dyPx / (2 * h) };
      return pts;
    };

    for (const [w, h] of [
      [1280, 720],
      [1080, 1440],
      [640, 480],
    ] as Array<[number, number]>) {
      for (const trueDeg of [0, 6, 12]) {
        const read = estimatePoseFromLandmarks(tiltedBy(trueDeg, w, h), {
          width: w,
          height: h,
        }).rollDeg;
        expect(
          Math.abs(read - trueDeg),
          `${w}x${h} at ${trueDeg}° read as ${read.toFixed(1)}°`,
        ).toBeLessThan(0.5);
      }
    }
  });

  it("does not let a level head fail the pose gate on a 16:9 stream", () => {
    // The regression this guards: a patient holding a 16:9 phone with a
    // 10° head tilt had roll reported as 17.4°, which zeroed the roll
    // sub-score, dragged `overall` under the acceptance floor, and
    // refused every frame — while `failing` stayed empty, so the coach
    // said "Hold it right there…".
    const w = 1280;
    const h = 720;
    const pts = goodLandmarks();
    const rad = (4 * Math.PI) / 180;
    const dxPx = 0.24 * w * Math.cos(rad);
    const dyPx = 0.24 * w * Math.sin(rad);
    pts[33] = { x: 0.5 - dxPx / (2 * w), y: 0.4 - dyPx / (2 * h) };
    pts[263] = { x: 0.5 + dxPx / (2 * w), y: 0.4 + dyPx / (2 * h) };
    const angles = estimatePoseFromLandmarks(pts, { width: w, height: h });
    const result = assessFrameQuality(
      input({
        landmarks: pts,
        frameWidth: w,
        frameHeight: h,
        yawDeg: angles.yawDeg,
        pitchDeg: angles.pitchDeg,
        rollDeg: angles.rollDeg,
      }),
    );
    expect(result.acceptable).toBe(true);
  });
});

describe("pose correction", () => {
  it("leaves a horizontal span alone under yaw — the iris calibration already self-corrects it", () => {
    // The iris is a circle: it foreshortens by the same cos(yaw) as any
    // horizontal span at its depth, and the two cancel in px / pxPerMm.
    // Dividing by cos(yaw) again (the old model) over-read every width
    // from a turned frame by ~6% at the 20° guided poses — verified
    // against pinhole projections of the canonical face model.
    expect(poseCorrect("noseWidth", 32, 20, 0)).toBeCloseTo(32, 5);
    expect(poseCorrect("faceWidthAtCheekbones", 140, 20, 0)).toBeCloseTo(
      140,
      5,
    );
  });

  it("leaves a horizontal span untouched by pitch", () => {
    expect(poseCorrect("noseWidth", 32, 0, 20)).toBeCloseTo(32, 5);
  });

  it("shrinks a vertical span measured on a turned head — the shrunken iris inflated it", () => {
    // Under yaw a vertical pixel span barely changes while the iris
    // (and with it pxPerMm) shrinks by cos(yaw), inflating the
    // millimetre value; multiply by cos(yaw) to undo the calibration
    // shift. A 20° turn ≈ 6%.
    const corrected = poseCorrect("noseToChin", 65, 20, 0);
    expect(corrected).toBeLessThan(65);
    expect(corrected).toBeGreaterThan(60);
  });

  it("expands a vertical span measured on a pitched head", () => {
    expect(poseCorrect("noseToChin", 65, 0, 20)).toBeGreaterThan(65);
  });

  it("does NOT model the depth lever that dominates noseToChin under pitch", () => {
    // Documented so nobody reads a pitch-driven offset in production as
    // a population fact and re-centres the catalog on it.
    //
    // `noseToChin` runs from the nose tip to the menton, and on the
    // canonical face those endpoints are 89.40 mm apart in the frontal
    // plane but ALSO 33.23 mm apart in DEPTH (z 75.87 -> 42.64). Pitch
    // rotates that depth into the image plane, so the projected span is
    //
    //     89.40 * cos(t)  +  33.23 * sin(t)
    //
    // and `poseCorrect` models only the first term. At 10 degrees the
    // term it ignores is 5.77 mm against the 1.36 mm it accounts for —
    // roughly four times larger, and of the opposite sign.
    const DY = 89.4;
    const DZ = 33.23;
    const rad = (10 * Math.PI) / 180;
    const cosTerm = Math.abs(DY * Math.cos(rad) - DY);
    const depthTerm = Math.abs(DZ * Math.sin(rad));
    expect(depthTerm).toBeGreaterThan(3 * cosTerm);

    // And because cos() is even, the correction always LENGTHENS: it
    // moves the right way for a chin-up frame (which reads short) and
    // the wrong way for chin-down (which reads long).
    expect(poseCorrect("noseToChin", 80, 0, 12)).toBeGreaterThan(80);
    expect(poseCorrect("noseToChin", 80, 0, -12)).toBeGreaterThan(80);

    // Which is why the per-frame pitch is now recorded (scan-signals.ts
    // -> fit_sessions.measurement_frames): the correction cannot be
    // fixed, nor a catalog offset confirmed, without knowing the angle
    // each real measurement was taken at.
  });

  it("stops correcting past 30 degrees rather than amplifying error", () => {
    const at30 = poseCorrect("noseToChin", 65, 30, 0);
    const at60 = poseCorrect("noseToChin", 65, 60, 0);
    expect(at60).toBeCloseTo(at30, 5);
  });
});

describe("turn coach nudges", () => {
  it("says nothing on the front pose or inside the turn window", () => {
    expect(turnCoachNudge(0, "front", false)).toBeNull();
    expect(turnCoachNudge(20, "turn_right", false)).toBeNull();
    expect(turnCoachNudge(-20, "turn_left", false)).toBeNull();
    // Either physical direction satisfies an unlocked turn step.
    expect(turnCoachNudge(-20, "turn_right", false)).toBeNull();
  });

  it("asks for more turn when the head is barely turned", () => {
    expect(turnCoachNudge(3, "turn_right", false)).toMatch(/further/i);
    expect(turnCoachNudge(-3, "turn_left", false)).toMatch(/further/i);
    // The nudge covers the whole refusal zone, including the hard
    // minimum-turn floor at the near-frontal cutoff — anywhere the gate
    // would refuse the frame as "not a turn", the coach asks for more.
    expect(turnCoachNudge(9, "turn_right", false)).toMatch(/further/i);
    expect(turnCoachNudge(10, "turn_right", false)).toMatch(/further/i);
  });

  it("asks for less when the head is turned past the window", () => {
    expect(turnCoachNudge(45, "turn_right", false)).toMatch(/too far/i);
    expect(turnCoachNudge(-45, "turn_left", false)).toMatch(/too far/i);
  });

  it("redirects a locked step turned the wrong way", () => {
    // One turn is already on film; the remaining step requires the other
    // direction, and the patient has turned the recorded way again.
    expect(turnCoachNudge(-20, "turn_right", true)).toMatch(/other way/i);
    expect(turnCoachNudge(20, "turn_left", true)).toMatch(/other way/i);
    // Straight-on at a locked step is "further", not "other way".
    expect(turnCoachNudge(2, "turn_right", true)).toMatch(/further/i);
  });
});

describe("multi-frame aggregation", () => {
  const goodQuality = assessFrameQuality(input());

  function frame(
    values: Record<string, number>,
    over: Partial<FrameMeasurement> = {},
  ): FrameMeasurement {
    return {
      pose: "front",
      quality: goodQuality,
      values,
      yawDeg: 0,
      pitchDeg: 0,
      ...over,
    };
  }

  it("takes the median, so one bad frame does not move the answer", () => {
    const result = aggregateFrames([
      frame({ noseWidth: 34 }),
      frame({ noseWidth: 34.4 }),
      frame({ noseWidth: 52 }), // the outlier
    ]);
    expect(result.measurements.noseWidth).toBeCloseTo(34.4, 1);
  });

  it("reports high agreement for consistent frames and low for scattered ones", () => {
    const tight = aggregateFrames([
      frame({ noseWidth: 34 }),
      frame({ noseWidth: 34.2 }),
      frame({ noseWidth: 34.1 }),
    ]);
    const scattered = aggregateFrames([
      frame({ noseWidth: 28 }),
      frame({ noseWidth: 34 }),
      frame({ noseWidth: 41 }),
    ]);
    expect(tight.agreement.noseWidth).toBeGreaterThan(0.95);
    expect(scattered.agreement.noseWidth).toBeLessThan(0.7);
    expect(tight.measurementConfidence).toBeGreaterThan(
      scattered.measurementConfidence,
    );
  });

  it("never rates a single frame as high confidence", () => {
    // One frame carries no agreement evidence, so it cannot clear the bar
    // however good the frame itself looks.
    const single = aggregateFrames([frame({ noseWidth: 34 })]);
    expect(single.frameCount).toBe(1);
    expect(single.band).not.toBe("high");
  });

  it("rates repeated, consistent near-frontal evidence as high confidence", () => {
    // Two front frames give every measurement two independent samples;
    // the turned frame adds capture evidence without contributing
    // measurement samples.
    const result = aggregateFrames([
      frame({ noseWidth: 34, noseToChin: 66 }, { pose: "front" }),
      frame(
        { noseWidth: 34.1, noseToChin: 66.2 },
        { pose: "front", yawDeg: 3 },
      ),
      frame(
        { noseWidth: 33.9, noseToChin: 65.8 },
        {
          pose: "turn_right",
          yawDeg: 18,
        },
      ),
    ]);
    expect(result.band).toBe("high");
    expect(result.frameCount).toBe(3);
  });

  describe("a burst is one observation, sampled repeatedly", () => {
    // Five frames ~140 ms apart at one posture share every systematic
    // error — distance, head angle, lighting, occlusion. Their agreement
    // measures detector stability, not measurement validity, so it must
    // not buy the same confidence as evidence that survived re-posing.
    const burst = (quality: QualityResult, n = 5) =>
      Array.from({ length: n }, (_, i) =>
        frame(
          { noseWidth: 34 + i * 0.05, noseToChin: 66 + i * 0.05 },
          { source: "burst", quality },
        ),
      );

    it("does not let mediocre frames reach high on self-agreement alone", () => {
      // The defect in one line: at a mean frame quality of ~0.5 the old
      // scoring cleared the route's 0.75 high-confidence scan floor
      // purely because five near-identical frames agreed with each other.
      const mediocre = assessFrameQuality(
        input({
          faceLuma: 78,
          faceLumaLeft: 66,
          faceLumaRight: 90,
          sharpness: 40,
        }),
      );
      expect(mediocre.overall).toBeLessThan(0.75);
      const result = aggregateFrames(burst(mediocre));
      expect(result.measurementConfidence).toBeLessThan(0.75);
      expect(result.band).not.toBe("high");
    });

    it("still lets a genuinely good burst reach high", () => {
      // The cap is a discount, not a veto: excellent pixels still earn
      // the band, they simply have to be excellent.
      const result = aggregateFrames(burst(goodQuality));
      expect(goodQuality.overall).toBeGreaterThan(0.8);
      expect(result.band).toBe("high");
    });

    it("scores a burst below the same frames captured independently", () => {
      const asBurst = aggregateFrames(burst(goodQuality));
      const asIndependent = aggregateFrames(
        burst(goodQuality).map((f) => ({ ...f, source: "guided" as const })),
      );
      expect(asBurst.measurementConfidence).toBeLessThan(
        asIndependent.measurementConfidence,
      );
    });

    it("leaves a caller that states no source on the old scoring", () => {
      // `source` is optional, and absent means independent — an
      // untagged caller must not be silently discounted.
      const untagged = aggregateFrames(
        burst(goodQuality).map(({ source: _source, ...f }) => f),
      );
      const tagged = aggregateFrames(burst(goodQuality));
      expect(untagged.measurementConfidence).toBeGreaterThan(
        tagged.measurementConfidence,
      );
    });

    it("does not discount a guided set that merely contains a burst frame", () => {
      // Scoped to a set that is ENTIRELY burst: a mixed set has some
      // genuine independence and keeps it.
      const mixed = aggregateFrames([
        frame({ noseWidth: 34, noseToChin: 66 }, { source: "burst" }),
        frame({ noseWidth: 34.1, noseToChin: 66.1 }, { source: "guided" }),
      ]);
      const allBurst = aggregateFrames([
        frame({ noseWidth: 34, noseToChin: 66 }, { source: "burst" }),
        frame({ noseWidth: 34.1, noseToChin: 66.1 }, { source: "burst" }),
      ]);
      expect(mixed.measurementConfidence).toBeGreaterThan(
        allBurst.measurementConfidence,
      );
    });
  });

  it("caps a set with only ONE near-frontal frame at moderate — every measurement is single-sampled", () => {
    // The guided-capture shape before the second front frame existed:
    // three good frames, but the turned two contribute no measurement
    // samples, so every value rests on a single look. The frame-count
    // bonus and the widths' agreement must not smuggle that into a
    // high-confidence fitting.
    const result = aggregateFrames([
      frame({ noseWidth: 34, noseToChin: 66 }, { pose: "front" }),
      frame(
        { noseWidth: 34.1, noseToChin: 66.2 },
        { pose: "turn_left", yawDeg: -18 },
      ),
      frame(
        { noseWidth: 33.9, noseToChin: 65.8 },
        { pose: "turn_right", yawDeg: 18 },
      ),
    ]);
    expect(result.band).not.toBe("high");
  });

  it("measures every span from near-frontal frames only", () => {
    // Turned frames are excluded from measuring on both axes: their
    // heights are distorted beyond the cos model (the nose's own depth
    // swings through the image plane), and their widths are
    // gaze-ambiguous — the iris only co-foreshortens when the eyes turn
    // with the head, and a patient watching the on-screen coach keeps
    // their iris camera-facing.
    const result = aggregateFrames([
      frame({ noseWidth: 34, noseToChin: 66 }, { pose: "front", yawDeg: 2 }),
      frame(
        { noseWidth: 31, noseToChin: 74 }, // distorted turned readings
        { pose: "turn_left", yawDeg: -20 },
      ),
      frame(
        { noseWidth: 38, noseToChin: 73 },
        { pose: "turn_right", yawDeg: 20 },
      ),
    ]);
    // Both values come from the front frame, not medians polluted by
    // the turned outliers.
    expect(result.measurements.noseWidth).toBeCloseTo(34, 1);
    expect(result.measurements.noseToChin).toBeCloseTo(66, 0);
  });

  it("falls back to every frame when none is near-frontal", () => {
    const result = aggregateFrames([
      frame({ noseToChin: 70 }, { pose: "turn_left", yawDeg: -20 }),
      frame({ noseToChin: 71 }, { pose: "turn_right", yawDeg: 20 }),
    ]);
    // Corrected by cos(20°) ≈ 0.94 — measured, not missing.
    expect(result.measurements.noseToChin).toBeGreaterThan(60);
    expect(result.measurements.noseToChin).toBeLessThan(70);
  });

  it("caps an all-turned fallback at 'low' however good the frames look", () => {
    // Both turned frames carry the SAME systematic bias (gaze-ambiguous
    // widths, residual vertical error past the cos model), so they agree
    // near-perfectly with each other and none of the ordinary caps
    // fire — the score alone read this set as high-band. Values are
    // still measured; the band routes the fitting to a fresh scan or a
    // human instead of shipping the bias as a confident recommendation.
    const good = assessFrameQuality(input({ yawDeg: 20, pose: "turn_right" }));
    expect(good.acceptable).toBe(true);
    const result = aggregateFrames([
      frame(
        { noseToChin: 70 },
        { pose: "turn_left", yawDeg: -20, quality: good },
      ),
      frame(
        { noseToChin: 70 },
        { pose: "turn_right", yawDeg: 20, quality: good },
      ),
    ]);
    expect(result.measurements.noseToChin).toBeGreaterThan(0);
    expect(result.band).toBe("low");
  });

  it("drags confidence down when the frames themselves were poor", () => {
    const poor = assessFrameQuality(input({ faceLuma: 30, sharpness: 5 }));
    const result = aggregateFrames([
      frame({ noseWidth: 34 }, { quality: poor }),
      frame({ noseWidth: 34.1 }, { quality: poor }),
      frame({ noseWidth: 34 }, { quality: poor }),
    ]);
    // A frame that failed its own quality gates is reported as `low`,
    // not merely "not high" — the score alone cannot get there, because a
    // single frame's fixed agreement term floors it around 0.35.
    expect(result.band).toBe("low");
  });

  it("does not let a rough TURN frame torpedo pristine front evidence", () => {
    // The "take the photo anyway" escape hatch exists for the turn steps,
    // and a patient who used it has produced a frame that fails its own
    // gates. That frame contributed NO measurement samples (yaw beyond
    // MEASUREMENT_YAW_LIMIT_DEG), so the unacceptable-frame floor must
    // not zero out two clean, agreeing front frames. (The live /measure
    // path usually drops failed frames before aggregating; this pins the
    // function's own contract for callers that pass everything.)
    const poor = assessFrameQuality(input({ faceLuma: 30, sharpness: 5 }));
    expect(poor.acceptable).toBe(false);
    const result = aggregateFrames([
      frame({ noseWidth: 34, noseToChin: 66 }, { pose: "front" }),
      frame(
        { noseWidth: 34.1, noseToChin: 66.2 },
        { pose: "front", yawDeg: 2 },
      ),
      frame(
        { noseWidth: 30, noseToChin: 75 },
        { pose: "turn_right", yawDeg: 24, quality: poor },
      ),
    ]);
    expect(result.band).not.toBe("low");
    // The measurements still come from the fronts alone.
    expect(result.measurements.noseWidth).toBeCloseTo(34.1, 1);
    // But when the bad frame IS load-bearing (nothing near-frontal), the
    // floor still applies in full.
    const allTurned = aggregateFrames([
      frame(
        { noseWidth: 30 },
        { pose: "turn_right", yawDeg: 24, quality: poor },
      ),
      frame(
        { noseWidth: 31 },
        { pose: "turn_left", yawDeg: -24, quality: poor },
      ),
    ]);
    expect(allTurned.band).toBe("low");
  });

  it("returns an empty, low-confidence result for no frames", () => {
    const result = aggregateFrames([]);
    expect(result.frameCount).toBe(0);
    expect(result.band).toBe("low");
    expect(result.measurementConfidence).toBe(0);
  });
});
