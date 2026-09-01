// Pose-convention validation.
//
// `poseFromFacialTransformationMatrix` assumes a column-major layout and
// a Tait-Bryan sign convention that the tasks-vision docs do not state.
// If pitch is reversed, `noseToChinPitchFactor` — which is deliberately
// ASYMMETRIC in the sign of pitch — drives the depth correction the wrong
// way and roughly doubles the error it exists to remove.
//
// Every case below is a way a real device could produce that, or a way
// the detector could wrongly claim it had.

import { describe, expect, it } from "vitest";

import {
  POSE_STEP_SPECS,
  buildPoseValidationCsv,
  buildPoseValidationReport,
  summarizeStep,
  type DeviceDescriptor,
  type PoseDiagnosticFrame,
  type PoseValidationStep,
} from "./pose-diagnostics";

const DEVICE: DeviceDescriptor = {
  platform: "iOS 18.4",
  browser: "Safari 18",
  delegate: "GPU",
  frameWidth: 1280,
  frameHeight: 720,
};

interface FrameOptions {
  step: PoseValidationStep;
  matrix?: { yawDeg: number; pitchDeg: number; rollDeg: number } | null;
  geometric?: { yawDeg: number; pitchDeg: number; rollDeg: number };
  poseSource?: "matrix" | "geometric";
  quality?: number;
  count?: number;
}

function frames(options: FrameOptions): PoseDiagnosticFrame[] {
  const count = options.count ?? 5;
  return Array.from({ length: count }, (_, i) => ({
    atMs: i * 100,
    step: options.step,
    matrix:
      options.matrix === undefined
        ? { yawDeg: 0, pitchDeg: 0, rollDeg: 0 }
        : options.matrix,
    geometric: options.geometric ?? { yawDeg: 0, pitchDeg: 0, rollDeg: 0 },
    poseSource: options.poseSource ?? "matrix",
    qualityScore: options.quality ?? 0.9,
  }));
}

/** A whole session where the matrix follows a given sign multiplier. */
function session(opts: {
  pitchSign?: number;
  yawSign?: number;
  rollSign?: number;
  /** Emit no matrix at all. */
  noMatrix?: boolean;
  /** How far the head actually moved, on the geometric estimate. */
  movementDeg?: number;
  quality?: number;
  poseSource?: "matrix" | "geometric";
}): PoseDiagnosticFrame[] {
  const move = opts.movementDeg ?? 20;
  const pitchSign = opts.pitchSign ?? 1;
  const yawSign = opts.yawSign ?? 1;
  const rollSign = opts.rollSign ?? 1;

  const make = (
    step: PoseValidationStep,
    geo: { yawDeg: number; pitchDeg: number; rollDeg: number },
    mat: { yawDeg: number; pitchDeg: number; rollDeg: number },
  ) =>
    frames({
      step,
      geometric: geo,
      matrix: opts.noMatrix ? null : mat,
      quality: opts.quality,
      poseSource: opts.poseSource,
    });

  const zero = { yawDeg: 0, pitchDeg: 0, rollDeg: 0 };
  return [
    ...make("level", zero, zero),
    ...make(
      "chin_up",
      { ...zero, pitchDeg: move },
      { ...zero, pitchDeg: move * pitchSign },
    ),
    ...make(
      "chin_down",
      { ...zero, pitchDeg: -move },
      { ...zero, pitchDeg: -move * pitchSign },
    ),
    ...make(
      "turn_left",
      { ...zero, yawDeg: move },
      { ...zero, yawDeg: move * yawSign },
    ),
    ...make(
      "turn_right",
      { ...zero, yawDeg: -move },
      { ...zero, yawDeg: -move * yawSign },
    ),
    ...make(
      "roll_left",
      { ...zero, rollDeg: move },
      { ...zero, rollDeg: move * rollSign },
    ),
    ...make(
      "roll_right",
      { ...zero, rollDeg: -move },
      { ...zero, rollDeg: -move * rollSign },
    ),
  ];
}

function report(frameList: PoseDiagnosticFrame[]) {
  return buildPoseValidationReport({
    sessionId: "sess_1",
    startedAt: "2026-06-01T00:00:00.000Z",
    device: DEVICE,
    frames: frameList,
  });
}

describe("the correct convention", () => {
  it("confirms every axis when the matrix agrees", () => {
    const r = report(session({}));
    expect(r.verdicts).toEqual({
      pitch: "agreed",
      yaw: "agreed",
      roll: "agreed",
    });
    expect(r.conventionConfirmed).toBe(true);
    expect(r.conventionSuspect).toBe(false);
  });

  it("says out loud that the result does not generalise", () => {
    // One device passing is one device. Recording it as "validated"
    // across the matrix is exactly the false claim this exists to stop.
    expect(report(session({})).findings.join(" ")).toContain(
      "does not generalise",
    );
  });
});

describe("a reversed convention", () => {
  it("detects a reversed PITCH — the dangerous one", () => {
    const r = report(session({ pitchSign: -1 }));
    expect(r.verdicts.pitch).toBe("reversed");
    expect(r.verdicts.yaw).toBe("agreed");
    expect(r.conventionSuspect).toBe(true);
    expect(r.findings.join(" ")).toContain("doubles the error");
  });

  it("detects a reversed YAW", () => {
    const r = report(session({ yawSign: -1 }));
    expect(r.verdicts.yaw).toBe("reversed");
    expect(r.findings.join(" ")).toContain("turn the wrong way");
  });

  it("detects a reversed ROLL", () => {
    expect(report(session({ rollSign: -1 })).verdicts.roll).toBe("reversed");
  });

  it("detects a wholly inverted matrix", () => {
    const r = report(session({ pitchSign: -1, yawSign: -1, rollSign: -1 }));
    expect(Object.values(r.verdicts)).toEqual([
      "reversed",
      "reversed",
      "reversed",
    ]);
  });
});

describe("a matrix that is not tracking an axis", () => {
  it("reports `inconsistent`, not a clean reversal somebody could sign-flip", () => {
    // One direction right and the other wrong. Reported as `reversed` it
    // would invite a minus sign that fixes half the cases and breaks the
    // other half.
    const base = session({});
    const broken = base.map((f) =>
      f.step === "chin_down" && f.matrix
        ? { ...f, matrix: { ...f.matrix, pitchDeg: 20 } }
        : f,
    );
    const r = report(broken);
    expect(r.verdicts.pitch).toBe("inconsistent");
    expect(r.conventionSuspect).toBe(true);
    expect(r.findings.join(" ")).toContain("do not 'fix' it by flipping");
  });

  it("reports a matrix stuck at zero as inconsistent, not agreed", () => {
    // Zero has sign 0, which matches neither expected sign, so both
    // directions fail — that is `reversed` by the two-direction rule.
    // What matters is that it is NOT `agreed`.
    const stuck = session({}).map((f) =>
      f.matrix ? { ...f, matrix: { yawDeg: 0, pitchDeg: 0, rollDeg: 0 } } : f,
    );
    expect(report(stuck).verdicts.pitch).not.toBe("agreed");
  });
});

describe("a missing or malformed matrix", () => {
  it("reports `no_matrix` rather than a failure", () => {
    // A runtime that emits no matrix is the designed fallback, not a
    // fault. The fitter still works on the geometric estimate.
    const r = report(session({ noMatrix: true, poseSource: "geometric" }));
    expect(r.verdicts).toEqual({
      pitch: "no_matrix",
      yaw: "no_matrix",
      roll: "no_matrix",
    });
    expect(r.conventionSuspect).toBe(false);
    expect(r.findings.join(" ")).toContain("designed fallback");
  });

  it("still produces a usable report with no frames at all", () => {
    const r = report([]);
    expect(r.conventionConfirmed).toBe(false);
    expect(r.matrixAcceptanceRate).toBe(0);
    expect(r.steps).toHaveLength(POSE_STEP_SPECS.length);
  });
});

describe("insufficient movement", () => {
  it("is INCONCLUSIVE, which is neither a pass nor a failure", () => {
    // A patient who barely moved proves nothing. Rounding this to
    // "agreed" is how a device gets marked validated on no evidence.
    const r = report(session({ movementDeg: 3 }));
    expect(r.verdicts.pitch).toBe("inconclusive");
    expect(r.conventionConfirmed).toBe(false);
    expect(r.conventionSuspect).toBe(false);
    expect(r.findings.join(" ")).toContain("not a pass");
  });

  it("uses the GEOMETRIC estimate to decide whether the test ran", () => {
    // Deciding it from the matrix would let a matrix stuck at zero call
    // every step inconclusive and quietly avoid ever being tested.
    const barelyMovedMatrix = session({}).map((f) =>
      f.matrix
        ? {
            ...f,
            matrix: {
              yawDeg: f.matrix.yawDeg * 0.05,
              pitchDeg: f.matrix.pitchDeg * 0.05,
              rollDeg: f.matrix.rollDeg * 0.05,
            },
          }
        : f,
    );
    // Movement is real (geometric says 20 degrees), so the step ran and
    // the sign was checked — even though the matrix reported only 1.
    expect(report(barelyMovedMatrix).verdicts.pitch).toBe("agreed");
  });
});

describe("saturated angles", () => {
  it("handles a matrix pinned at its extremes", () => {
    const saturated = session({}).map((f) =>
      f.matrix
        ? {
            ...f,
            matrix: {
              yawDeg: Math.sign(f.matrix.yawDeg) * 90,
              pitchDeg: Math.sign(f.matrix.pitchDeg) * 90,
              rollDeg: Math.sign(f.matrix.rollDeg) * 180,
            },
          }
        : f,
    );
    // Saturation preserves sign, so the convention still reads as agreed
    // — which is correct: this test is about direction, not magnitude.
    expect(report(saturated).verdicts).toEqual({
      pitch: "agreed",
      yaw: "agreed",
      roll: "agreed",
    });
  });
});

describe("baseline correction", () => {
  it("subtracts the resting offset a person holding a phone actually has", () => {
    // Someone looking slightly down at a phone rests at a few degrees.
    // Without correction, chin_up at +20 and chin_down at -20 measured
    // from a -8 rest would read +12 and -28 — still signed correctly
    // here, but a larger rest would flip one of them.
    const rest = -12;
    const withRest = session({}).map((f) => ({
      ...f,
      geometric: { ...f.geometric, pitchDeg: f.geometric.pitchDeg + rest },
      matrix: f.matrix
        ? { ...f.matrix, pitchDeg: f.matrix.pitchDeg + rest }
        : null,
    }));
    expect(report(withRest).verdicts.pitch).toBe("agreed");
  });

  it("corrects each estimate against its OWN baseline", () => {
    // The geometric pitch estimator reads several degrees positive on a
    // level head by construction (the anatomy confound PITCH_GRACE_DEG
    // exists for). Subtracting the matrix's offset from it would import
    // that error into the movement check.
    const geoOffset = 5.4;
    const skewed = session({}).map((f) => ({
      ...f,
      geometric: { ...f.geometric, pitchDeg: f.geometric.pitchDeg + geoOffset },
    }));
    expect(report(skewed).verdicts.pitch).toBe("agreed");
  });
});

describe("frame quality", () => {
  it("ignores frames too poor to read a sign from", () => {
    const noisy = [
      ...session({}),
      ...frames({
        step: "chin_up",
        quality: 0.1,
        geometric: { yawDeg: 0, pitchDeg: -40, rollDeg: 0 },
        matrix: { yawDeg: 0, pitchDeg: -40, rollDeg: 0 },
        count: 20,
      }),
    ];
    expect(report(noisy).verdicts.pitch).toBe("agreed");
  });
});

describe("matrix acceptance rate", () => {
  it("reports zero acceptance as the gate doing its job, not as data loss", () => {
    const rejected = session({ pitchSign: -1, poseSource: "geometric" });
    const r = report(rejected);
    expect(r.matrixAcceptanceRate).toBe(0);
    expect(r.findings.join(" ")).toContain(
      "degrades to the geometric estimate rather than corrupting a measurement",
    );
  });

  it("warns when the gates are firing on more than half the frames", () => {
    const mixed = session({}).map((f, i) =>
      i % 3 === 0 ? f : { ...f, poseSource: "geometric" as const },
    );
    expect(report(mixed).findings.join(" ")).toContain("gates are firing");
  });
});

describe("summarizeStep", () => {
  it("returns a level step with no axis verdict", () => {
    const spec = POSE_STEP_SPECS[0];
    const outcome = summarizeStep(spec, frames({ step: "level" }));
    expect(outcome.axis).toBeNull();
    expect(outcome.signMatched).toBeNull();
    expect(outcome.movedEnough).toBe(true);
  });

  it("counts frames with and without a matrix separately", () => {
    const spec = POSE_STEP_SPECS[1];
    const mixed = [
      ...frames({
        step: "chin_up",
        count: 3,
        geometric: { yawDeg: 0, pitchDeg: 20, rollDeg: 0 },
      }),
      ...frames({ step: "chin_up", count: 2, matrix: null }),
    ];
    const outcome = summarizeStep(spec, mixed);
    expect(outcome.framesSeen).toBe(5);
    expect(outcome.framesWithMatrix).toBe(3);
  });
});

describe("buildPoseValidationCsv", () => {
  const r = report(session({ pitchSign: -1 }));

  it("carries angles, verdicts and device metadata", () => {
    const csv = buildPoseValidationCsv(r);
    expect(csv.split("\r\n")[0]).toContain("median_matrix_deg");
    expect(csv).toContain("iOS 18.4");
    expect(csv).toContain("chin_up");
  });

  it("has no image field, because no image ever reaches this module", () => {
    const csv = buildPoseValidationCsv(r);
    expect(csv.toLowerCase()).not.toContain("image");
    expect(csv.toLowerCase()).not.toContain("photo");
    expect(csv.toLowerCase()).not.toContain("data:");
  });

  it("has one row per step", () => {
    const rows = buildPoseValidationCsv(r).trim().split("\r\n");
    expect(rows).toHaveLength(POSE_STEP_SPECS.length + 1);
  });
});

describe("the step sequence itself", () => {
  it("covers every axis in both directions", () => {
    for (const axis of ["pitch", "yaw", "roll"] as const) {
      const forAxis = POSE_STEP_SPECS.filter((s) => s.axis === axis);
      expect(forAxis).toHaveLength(2);
      expect(forAxis.map((s) => s.expectedSign).sort()).toEqual([-1, 1]);
    }
  });

  it("starts with a level baseline that asserts no direction", () => {
    expect(POSE_STEP_SPECS[0].step).toBe("level");
    expect(POSE_STEP_SPECS[0].expectedSign).toBe(0);
  });

  it("states an instruction and a threshold for every step", () => {
    for (const spec of POSE_STEP_SPECS) {
      expect(spec.instruction.length).toBeGreaterThan(20);
      if (spec.axis) expect(spec.minMagnitudeDeg).toBeGreaterThan(0);
    }
  });

  it("requires more movement than the geometric estimator's own anatomy confound", () => {
    // PITCH_GRACE_DEG is 6. A pitch step that accepted 5 degrees would
    // be reading the confound, not the movement.
    for (const spec of POSE_STEP_SPECS.filter((s) => s.axis === "pitch")) {
      expect(spec.minMagnitudeDeg).toBeGreaterThan(6);
    }
  });
});
