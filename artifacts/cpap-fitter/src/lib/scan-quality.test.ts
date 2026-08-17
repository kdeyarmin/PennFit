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
  it("expands a horizontal span measured on a turned head", () => {
    // A 20-degree turn foreshortens a width by ~6%.
    const corrected = poseCorrect("noseWidth", 32, 20, 0);
    expect(corrected).toBeGreaterThan(32);
    expect(corrected).toBeLessThan(35);
  });

  it("leaves a horizontal span untouched by pitch", () => {
    expect(poseCorrect("noseWidth", 32, 0, 20)).toBeCloseTo(32, 5);
  });

  it("corrects a vertical span by pitch, not yaw", () => {
    expect(poseCorrect("noseToChin", 65, 20, 0)).toBeCloseTo(65, 5);
    expect(poseCorrect("noseToChin", 65, 0, 20)).toBeGreaterThan(65);
  });

  it("stops correcting past 30 degrees rather than amplifying error", () => {
    const at30 = poseCorrect("noseWidth", 32, 30, 0);
    const at60 = poseCorrect("noseWidth", 32, 60, 0);
    expect(at60).toBeCloseTo(at30, 5);
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

  it("rates three consistent, high-quality frames as high confidence", () => {
    const result = aggregateFrames([
      frame({ noseWidth: 34, noseToChin: 66 }, { pose: "front" }),
      frame(
        { noseWidth: 34.1, noseToChin: 66.2 },
        {
          pose: "turn_left",
          yawDeg: -18,
        },
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

  it("drags confidence down when the frames themselves were poor", () => {
    const poor = assessFrameQuality(input({ faceLuma: 30, sharpness: 5 }));
    const result = aggregateFrames([
      frame({ noseWidth: 34 }, { quality: poor }),
      frame({ noseWidth: 34.1 }, { quality: poor }),
      frame({ noseWidth: 34 }, { quality: poor }),
    ]);
    expect(result.band).not.toBe("high");
  });

  it("returns an empty, low-confidence result for no frames", () => {
    const result = aggregateFrames([]);
    expect(result.frameCount).toBe(0);
    expect(result.band).toBe("low");
    expect(result.measurementConfidence).toBe(0);
  });
});
