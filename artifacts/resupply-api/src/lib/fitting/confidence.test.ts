// Confidence scoring and the five exception states.
//
// The behaviour worth protecting here is the system's ability to REFUSE.
// A recommendation engine that always answers is indistinguishable from
// one that guesses, so each of the five states gets a test that proves it
// is reachable, plus the two caps that stop a confident-looking answer
// coming out of weak evidence.

import { describe, expect, it } from "vitest";

import {
  measurementsOutOfBounds,
  profileCompleteness,
  resolveConfidence,
} from "./confidence";
import { emptyProfile } from "./profile";
import type { FitCandidate, FitProfile, ScanSignals } from "./types";

const GOOD_SCAN: ScanSignals = {
  frameCount: 3,
  quality: { lighting: 1, distance: 1, pose: 1, occlusion: 1, motion: 1 },
  agreement: {},
  measurementConfidence: 0.95,
  band: "high",
};

const POOR_SCAN: ScanSignals = {
  ...GOOD_SCAN,
  measurementConfidence: 0.3,
  band: "low",
};

const MEASUREMENTS = {
  noseWidth: 34,
  noseHeight: 45,
  noseToChin: 66,
  mouthWidth: 50,
  faceWidthAtCheekbones: 142,
};

function fullProfile(): FitProfile {
  return {
    ...emptyProfile(),
    mouthBreather: false,
    nasalObstruction: "none",
    frequentCongestion: false,
    sleepPositions: ["back"],
    claustrophobia: "none",
    facialHair: "none",
    skinIrritation: "none",
    sensitiveSkin: false,
    handDexterity: "normal",
    pressureCmH2O: 10,
    pressureBand: "medium",
    minimalContactPreference: "no_preference",
  };
}

function candidate(over: Partial<FitCandidate> = {}): FitCandidate {
  return {
    maskSlug: "m",
    maskId: "m",
    name: "Mask",
    manufacturer: "Acme",
    interfaceType: "full_face",
    imageUrl: null,
    confidence: 0.9,
    rankScore: 0.9,
    facialFitScore: 0.95,
    patientFactorScore: 0.85,
    cushion: {
      variantId: "v",
      component: "cushion",
      sizeCode: "M",
      sizeLabel: "Medium",
      bandMargin: 0.8,
      fitDataSource: "manufacturer",
      needsClinicalReview: false,
      measurementsUsed: ["noseWidth"],
      rationale: "Fits.",
    },
    frame: null,
    reasons: [],
    cautions: [],
    outsideFormulary: false,
    outsideFormularyReason: null,
    availability: null,
    rankedBelowBecause: null,
    ...over,
  };
}

const base = {
  scan: GOOD_SCAN,
  profile: fullProfile(),
  measurements: MEASUREMENTS,
  everythingExcluded: false,
  outsideValidatedRange: false,
  gatingEnabled: true,
};

describe("the five exception states are each reachable", () => {
  it("high_confidence — strong match, good scan, reviewed geometry", () => {
    expect(resolveConfidence({ ...base, top: candidate() }).outcome).toBe(
      "high_confidence",
    );
  });

  it("moderate_confidence — decent match that still warrants a look", () => {
    const result = resolveConfidence({
      ...base,
      top: candidate({ confidence: 0.68, patientFactorScore: 0.6 }),
    });
    expect(result.outcome).toBe("moderate_confidence");
    expect(result.requiresReview).toBe(true);
  });

  it("low_confidence — weak match", () => {
    expect(
      resolveConfidence({ ...base, top: candidate({ confidence: 0.4 }) })
        .outcome,
    ).toBe("low_confidence");
  });

  it("contraindicated — the clinical filters removed everything", () => {
    const result = resolveConfidence({
      ...base,
      top: null,
      everythingExcluded: true,
    });
    expect(result.outcome).toBe("contraindicated");
    expect(result.confidence).toBe(0);
    expect(result.requiresReview).toBe(true);
  });

  it("outside_validated_range — measurements outside the plausible window", () => {
    const result = resolveConfidence({
      ...base,
      top: candidate(),
      measurements: { ...MEASUREMENTS, noseWidth: 5 },
    });
    expect(result.outcome).toBe("outside_validated_range");
  });

  it("outside_validated_range — no candidate landed inside any size band", () => {
    expect(
      resolveConfidence({
        ...base,
        top: candidate(),
        outsideValidatedRange: true,
      }).outcome,
    ).toBe("outside_validated_range");
  });
});

describe("what cannot produce a confident answer", () => {
  it("a perfect clinical match measured badly is never high confidence", () => {
    const result = resolveConfidence({
      ...base,
      top: candidate({ confidence: 1 }),
      scan: POOR_SCAN,
    });
    expect(result.outcome).not.toBe("high_confidence");
  });

  it("an unreviewed estimated size band caps the result at moderate", () => {
    // This is the safety valve that makes shipping estimated geometry
    // defensible: until an RT signs a variant off, it cannot produce a
    // confident automated recommendation however well it scores.
    const strong = candidate({ confidence: 1 });
    expect(resolveConfidence({ ...base, top: strong }).outcome).toBe(
      "high_confidence",
    );

    const unreviewed = candidate({
      confidence: 1,
      cushion: {
        ...strong.cushion!,
        needsClinicalReview: true,
        fitDataSource: "estimated",
      },
    });
    expect(resolveConfidence({ ...base, top: unreviewed }).outcome).toBe(
      "moderate_confidence",
    );
  });

  it("an unanswered profile drags an otherwise strong match down", () => {
    const answered = resolveConfidence({ ...base, top: candidate() });
    const unanswered = resolveConfidence({
      ...base,
      top: candidate(),
      profile: emptyProfile(),
    });
    expect(unanswered.confidence).toBeLessThan(answered.confidence);
  });
});

describe("gating disabled preserves the previous behaviour", () => {
  it("never withholds a recommendation and never flags out-of-range", () => {
    const weak = resolveConfidence({
      ...base,
      top: candidate({ confidence: 0.2 }),
      gatingEnabled: false,
    });
    expect(weak.outcome).toBe("moderate_confidence");

    const outOfRange = resolveConfidence({
      ...base,
      top: candidate(),
      measurements: { ...MEASUREMENTS, noseWidth: 5 },
      gatingEnabled: false,
    });
    expect(outOfRange.outcome).not.toBe("outside_validated_range");
  });

  it("still refuses when every candidate was clinically excluded", () => {
    // Safety is not part of the opt-in. Even with gating off, an empty
    // survivor set is contraindicated, not a shrug.
    expect(
      resolveConfidence({
        ...base,
        top: null,
        everythingExcluded: true,
        gatingEnabled: false,
      }).outcome,
    ).toBe("contraindicated");
  });
});

describe("plausibility bounds", () => {
  it("accepts a normal adult face and rejects an implausible one", () => {
    expect(measurementsOutOfBounds(MEASUREMENTS, "adult")).toBe(false);
    expect(
      measurementsOutOfBounds(
        { ...MEASUREMENTS, faceWidthAtCheekbones: 400 },
        "adult",
      ),
    ).toBe(true);
  });

  it("uses a wider window for children, so a small face isn't a failure", () => {
    const child = {
      noseWidth: 22,
      noseHeight: 28,
      noseToChin: 42,
      mouthWidth: 32,
      faceWidthAtCheekbones: 105,
    };
    expect(measurementsOutOfBounds(child, "adult")).toBe(true);
    expect(measurementsOutOfBounds(child, "pediatric")).toBe(false);
  });

  it("rejects a missing or non-finite measurement", () => {
    expect(
      measurementsOutOfBounds(
        { ...MEASUREMENTS, noseWidth: Number.NaN },
        "adult",
      ),
    ).toBe(true);
    const { noseWidth: _omitted, ...missing } = MEASUREMENTS;
    expect(measurementsOutOfBounds(missing, "adult")).toBe(true);
  });
});

describe("profile completeness", () => {
  it("scores a full profile above an empty one, with a floor", () => {
    expect(profileCompleteness(fullProfile())).toBeGreaterThan(
      profileCompleteness(emptyProfile()),
    );
    expect(profileCompleteness(emptyProfile())).toBeGreaterThanOrEqual(0.6);
    expect(profileCompleteness(fullProfile())).toBeLessThanOrEqual(1);
  });
});
