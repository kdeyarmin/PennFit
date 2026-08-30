// Confidence scoring and the five exception states.
//
// The behaviour worth protecting here is the system's ability to REFUSE.
// A recommendation engine that always answers is indistinguishable from
// one that guesses, so each of the five states gets a test that proves it
// is reachable, plus the two caps that stop a confident-looking answer
// coming out of weak evidence.

import { describe, expect, it } from "vitest";

import {
  CONFIDENCE_THRESHOLDS,
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
      manufacturerPartNumber: null,
      bandMargin: 0.8,
      inBand: true,
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

describe("the capture's own verdict on the frame", () => {
  // The client aggregation flags `band: "low"` when a contributing frame
  // failed its quality gates outright. The weighted score cannot always
  // reach that conclusion on its own — a single frame's fixed agreement
  // term floors `measurementConfidence` around 0.35 — so a too-dark or
  // too-soft frame lands near 0.55 and would otherwise read as moderate.
  const UNUSABLE_FRAME: ScanSignals = {
    ...GOOD_SCAN,
    measurementConfidence: 0.56,
    band: "low",
  };

  it("caps a low-band scan at low_confidence even when the score would allow more", () => {
    const withoutBand = resolveConfidence({
      ...base,
      top: candidate(),
      scan: { ...UNUSABLE_FRAME, band: "moderate" },
    });
    expect(withoutBand.outcome).not.toBe("low_confidence");

    const withBand = resolveConfidence({
      ...base,
      top: candidate(),
      scan: UNUSABLE_FRAME,
    });
    expect(withBand.outcome).toBe("low_confidence");
    expect(withBand.requiresReview).toBe(true);
  });

  it("never upgrades on the band — a low band cannot raise a poor score", () => {
    const result = resolveConfidence({
      ...base,
      top: candidate(),
      scan: { ...POOR_SCAN, band: "high" },
    });
    expect(result.outcome).toBe("low_confidence");
  });

  it("leaves the band inert when gating is off", () => {
    const result = resolveConfidence({
      ...base,
      top: candidate(),
      scan: UNUSABLE_FRAME,
      gatingEnabled: false,
    });
    // Gating off never withholds — the pre-existing behaviour for tenants
    // who have not opted in, preserved exactly.
    expect(result.outcome).toBe("moderate_confidence");
  });
});

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

  it("does NOT withhold merely because no candidate landed in a band", () => {
    // This used to return `outside_validated_range` and name no mask,
    // and it dead-ended a real patient: every measurement comfortably
    // inside the adult window, on a high-band scan with cross-frame
    // agreement above 0.97 across all five spans, refused outright.
    // Their nose width landed in the AirFit F20's MEDIUM bucket while
    // their nose-to-chin and mouth width landed in its SMALL one, so no
    // single size held them — as on 32 of the 33 mouth-covering adult
    // masks. That is a statement about the catalog's per-dimension
    // partitioning, not about the patient, and it must not read back to
    // them as "your measurements fall outside the range our sizing data
    // covers".
    //
    // The millimetre values and the date are deliberately not reproduced
    // here: measurements tied to a date of service are patient-derived
    // biometrics and stay in the database. The behaviour under test does
    // not need them — the fixture below is synthetic.
    const result = resolveConfidence({
      ...base,
      top: candidate({
        cushion: { ...candidate().cushion!, inBand: false, bandMargin: 0 },
      }),
      outsideValidatedRange: true,
    });
    expect(result.outcome).not.toBe("outside_validated_range");
    // Recommended, but never sold as a sure thing: the unconfirmed size
    // caps at moderate, which promises clinical review before shipping.
    expect(result.outcome).toBe("moderate_confidence");
    expect(result.requiresReview).toBe(true);
    expect(result.confidence).toBeGreaterThan(0);
  });

  it("still withholds when the measurement itself is implausible", () => {
    // The half of the old condition that was right, kept: a value
    // outside the plausibility window means the NUMBER is suspect, so
    // nothing built on it can be trusted — even if some mask is in band.
    const result = resolveConfidence({
      ...base,
      top: candidate(),
      measurements: { ...MEASUREMENTS, noseToChin: 200 },
      outsideValidatedRange: false,
    });
    expect(result.outcome).toBe("outside_validated_range");
    expect(result.confidence).toBe(0);
  });
});

describe("the winning size's own band verdict", () => {
  // The whole-field gate (outside_validated_range) fires only when EVERY
  // candidate is out of band. These pin the per-winner rule: a top pick
  // whose chosen size the geometry does not confirm caps at moderate —
  // strong patient factors must not sell an out-of-band size as "go
  // ahead and order".
  it("caps an out-of-band winner at moderate however well it scored", () => {
    const outOfBand = candidate({
      confidence: 1,
      cushion: { ...candidate().cushion!, inBand: false, bandMargin: 0 },
    });
    const result = resolveConfidence({ ...base, top: outOfBand });
    expect(result.outcome).toBe("moderate_confidence");
    expect(result.requiresReview).toBe(true);
    // The NUMBER is capped with the label: the results page renders it as
    // "N% match" next to the outcome copy, and "98% match" beside "worth
    // a second look" is the overclaim restated as a percentage.
    expect(result.confidence).toBeLessThan(CONFIDENCE_THRESHOLDS.high);
  });

  it("caps a winner with no sizing geometry at all — its size is a guess", () => {
    // scoreFacialFit's no-geometry fallback emits the default size with
    // inBand=false; a null cushion (no variants) is the same statement.
    const noGeometry = candidate({ confidence: 1, cushion: null });
    expect(resolveConfidence({ ...base, top: noGeometry }).outcome).toBe(
      "moderate_confidence",
    );
  });

  it("does not lift a weak match — the cap only ever downgrades", () => {
    const weak = candidate({
      confidence: 0.4,
      cushion: { ...candidate().cushion!, inBand: false },
    });
    expect(resolveConfidence({ ...base, top: weak }).outcome).toBe(
      "low_confidence",
    );
  });

  it("an in-band winner still reaches high confidence", () => {
    expect(resolveConfidence({ ...base, top: candidate() }).outcome).toBe(
      "high_confidence",
    );
  });

  it("is inert when gating is off — pre-opt-in behaviour is preserved", () => {
    const outOfBand = candidate({
      confidence: 1,
      cushion: { ...candidate().cushion!, inBand: false },
    });
    expect(
      resolveConfidence({ ...base, top: outOfBand, gatingEnabled: false })
        .outcome,
    ).toBe("high_confidence");
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

  it("a clinician's sign-off is not required for confidence — the scan decides", () => {
    // Reversal of the old behaviour, pinned deliberately. An unreviewed
    // estimated band used to be capped below high confidence until an RT
    // signed it off; requiring a human to hand-approve ~290 bands made
    // the fitter unusable at scale, so the gate was removed. A band's
    // provenance no longer changes the number the patient sees.
    const strong = candidate({ confidence: 1 });
    const unreviewed = candidate({
      confidence: 1,
      cushion: {
        ...strong.cushion!,
        needsClinicalReview: true,
        fitDataSource: "estimated",
      },
    });

    expect(resolveConfidence({ ...base, top: strong }).outcome).toBe(
      "high_confidence",
    );
    expect(resolveConfidence({ ...base, top: unreviewed }).outcome).toBe(
      "high_confidence",
    );
  });

  it("but a bad scan still overrides an unreviewed band's strong score", () => {
    // The point of removing the review gate was to let the SCAN decide,
    // not to let everything through. A strong geometric match on a bad
    // capture must still fail, review status notwithstanding.
    const unreviewed = candidate({
      confidence: 1,
      cushion: {
        ...candidate().cushion!,
        needsClinicalReview: true,
        fitDataSource: "estimated",
      },
    });
    expect(
      resolveConfidence({ ...base, top: unreviewed, scan: POOR_SCAN }).outcome,
    ).not.toBe("high_confidence");
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

  it("an entirely unanswered profile sits exactly at the documented floor", () => {
    // Regression pin: `priorMaskExperience !== undefined` used to count
    // as an answered question on every profile (the field is
    // non-nullable, so a skipped question is indistinguishable from
    // "none"), quietly lifting an unanswered profile to 0.64 — enough to
    // convert a low-confidence withhold into a moderate recommendation
    // near the threshold. The undetectable question is no longer scored.
    expect(profileCompleteness(emptyProfile())).toBeCloseTo(0.6, 10);
  });
});
