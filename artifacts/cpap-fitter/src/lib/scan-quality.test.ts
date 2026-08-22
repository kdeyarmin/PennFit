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
  centroidOf,
  coachMessage,
  estimatePoseFromLandmarks,
  poseCorrect,
  turnCoachNudge,
  type CapturePose,
  type FrameMeasurement,
  type Point2D,
  type QualityInput,
} from "./scan-quality";

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
    irisWidthPx: 30, // pxPerMm ~2.56, mid-window
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

  it("rejects a face held too far away and too close", () => {
    expect(assessFrameQuality(input({ irisWidthPx: 10 })).failing).toContain(
      "distance",
    );
    expect(assessFrameQuality(input({ irisWidthPx: 70 })).failing).toContain(
      "distance",
    );
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
      frame({ noseToChin: 70 }, { pose: "turn_left", yawDeg: -20, quality: good }),
      frame({ noseToChin: 70 }, { pose: "turn_right", yawDeg: 20, quality: good }),
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
