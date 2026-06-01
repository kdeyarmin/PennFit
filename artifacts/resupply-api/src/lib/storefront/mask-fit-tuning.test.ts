// Tests for the mask-fit → rec-engine tuning core (RT #22b), plus proof
// the engine applies fitAdjustments to ranking only (not confidence).

import { describe, it, expect } from "vitest";

import { computeFitAdjustments, tallyOutcomesByMask } from "./mask-fit-tuning";
import { recommend } from "./recommendationEngine";
import type {
  FacialMeasurements,
  QuestionnaireAnswers,
} from "./recommendationEngine";

describe("computeFitAdjustments", () => {
  it("stays neutral (omits the mask) below minSamples", () => {
    const adj = computeFitAdjustments(
      { "mask-a": { good: 4, leaking: 1, uncomfortable: 0 } },
      { minSamples: 10 },
    );
    expect(adj["mask-a"]).toBeUndefined();
  });

  it("nudges a well-sealing mask up and a leaky one down, bounded", () => {
    const adj = computeFitAdjustments(
      {
        good_mask: { good: 18, leaking: 1, uncomfortable: 1 }, // mostly good
        bad_mask: { good: 2, leaking: 10, uncomfortable: 8 }, // mostly bad
      },
      { minSamples: 10, maxAdjustment: 0.15 },
    );
    expect(adj.good_mask).toBeGreaterThan(1);
    expect(adj.good_mask).toBeLessThanOrEqual(1.15);
    expect(adj.bad_mask).toBeLessThan(1);
    expect(adj.bad_mask).toBeGreaterThanOrEqual(0.85);
  });

  it("is monotonic — more good ⇒ higher multiplier", () => {
    const a = computeFitAdjustments({
      m: { good: 12, leaking: 8, uncomfortable: 0 },
    });
    const b = computeFitAdjustments({
      m: { good: 18, leaking: 2, uncomfortable: 0 },
    });
    expect(b.m!).toBeGreaterThan(a.m!);
  });

  it("an all-good mask hits +maxAdjustment exactly", () => {
    const adj = computeFitAdjustments(
      { m: { good: 20, leaking: 0, uncomfortable: 0 } },
      { minSamples: 10, maxAdjustment: 0.1 },
    );
    expect(adj.m).toBeCloseTo(1.1, 5);
  });
});

describe("tallyOutcomesByMask", () => {
  it("folds rows into per-mask counts, dropping null maskIds", () => {
    const byMask = tallyOutcomesByMask([
      { maskId: "m1", fitOutcome: "good" },
      { maskId: "m1", fitOutcome: "leaking" },
      { maskId: "m1", fitOutcome: "good" },
      { maskId: null, fitOutcome: "uncomfortable" },
    ]);
    expect(byMask.m1).toEqual({ good: 2, leaking: 1, uncomfortable: 0 });
    expect(Object.keys(byMask)).toEqual(["m1"]);
  });
});

describe("recommend() with fitAdjustments", () => {
  const measurements: FacialMeasurements = {
    noseWidth: 35,
    noseHeight: 50,
    noseToChin: 70,
    mouthWidth: 50,
    faceWidthAtCheekbones: 130,
    calibrationMethod: "manual",
  };
  const answers: QuestionnaireAnswers = {
    mouthBreather: false,
    claustrophobic: false,
    sideOrStomachSleeper: false,
    heavyFacialHair: false,
    wearsGlasses: false,
    frequentCongestion: false,
    priorMaskExperience: "none",
    mobilityLimitations: false,
    sensitiveSkin: false,
    siliconeSensitivity: false,
    cpapPressureSetting: "medium",
  };

  it("leaves confidence unchanged but re-weights ranking", () => {
    const base = recommend(measurements, answers);
    const top = base.topRecommendations[0]!;

    // Confidence is a pure clinical-fit signal — a fit BOOST on the top
    // mask keeps it top (ranking) but must NOT change its confidence.
    const tuned = recommend(measurements, answers, {
      fitAdjustments: { [top.maskId]: 1.15 },
    });
    const tunedTop = tuned.topRecommendations[0]!;
    expect(tunedTop.maskId).toBe(top.maskId);
    expect(tunedTop.confidence).toBe(top.confidence);
  });

  it("is identical to the no-options call when fitAdjustments is empty", () => {
    const a = recommend(measurements, answers);
    const b = recommend(measurements, answers, {});
    expect(b.topRecommendations.map((r) => r.maskId)).toEqual(
      a.topRecommendations.map((r) => r.maskId),
    );
    expect(b.topRecommendations.map((r) => r.confidence)).toEqual(
      a.topRecommendations.map((r) => r.confidence),
    );
  });
});
