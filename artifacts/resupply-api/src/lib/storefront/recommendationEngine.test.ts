// Unit tests for recommendSize() in the storefront recommendation
// engine. The function partitions a mask's overall fit range into
// equal buckets keyed on the dominant axis (nose width for nasal /
// nasal-pillow, nose-to-chin for full-face / hybrid) and picks the
// size at the bucket the patient lands in.
//
// Coverage:
//   * 0-size catalog entry → null + single-size rationale
//   * 1-size entry → that size, regardless of measurement
//   * Linear partition over a 4-size pillow with nose-width axis
//   * Boundary value (== max) clamps to last size, never overflows
//   * Below-range / above-range → clamp + warning rationale
//   * Full-face mask uses nose-to-chin axis, not nose width

import { describe, it, expect } from "vitest";
import type { MaskEntry } from "../../data/maskCatalog";
import {
  recommend,
  recommendSize,
  scoreAnswers,
  type FacialMeasurements,
  type QuestionnaireAnswers,
} from "./recommendationEngine";

function maskFixture(overrides: Partial<MaskEntry>): MaskEntry {
  return {
    id: "test-mask",
    name: "Test Mask",
    modelNumber: "TEST",
    manufacturer: "Test",
    type: "nasalPillow",
    description: "",
    fitRanges: {
      noseWidthMin: 20,
      noseWidthMax: 36,
      noseToChinMin: 35,
      noseToChinMax: 65,
      mouthWidthMin: 30,
      mouthWidthMax: 50,
    },
    features: [],
    contraindications: [],
    cushionMaterial: "Silicone",
    headgearStyle: "Standard",
    hoseConnection: "front",
    weightGrams: 50,
    sizesAvailable: ["XS", "S", "M", "L"],
    pressureRangeMin: 4,
    pressureRangeMax: 20,
    priceTier: "standard",
    bestFor: [],
    imageUrl: null,
    ...overrides,
  };
}

const M: FacialMeasurements = {
  noseWidth: 28,
  noseHeight: 25,
  noseToChin: 50,
  mouthWidth: 40,
  faceWidthAtCheekbones: 130,
  calibrationMethod: "creditCard",
};

describe("recommendSize", () => {
  it("returns null for a 0-size entry", () => {
    const r = recommendSize(maskFixture({ sizesAvailable: [] }), M);
    expect(r.size).toBeNull();
    expect(r.rationale).toMatch(/single|universal/i);
  });

  it("returns the only size for a 1-size entry, ignoring measurements", () => {
    const r = recommendSize(maskFixture({ sizesAvailable: ["One"] }), M);
    expect(r.size).toBe("One");
  });

  it("partitions a 4-size nasal-pillow over [20, 36] mm by nose width", () => {
    // sizesAvailable: ["XS","S","M","L"] across noseWidth 20..36 (range 16).
    // Bucket boundaries at 20+0, 20+4, 20+8, 20+12 = 20, 24, 28, 32.
    // 21 mm → fraction 1/16 → idx 0 → XS
    // 25 mm → fraction 5/16 → idx 1 → S
    // 29 mm → fraction 9/16 → idx 2 → M
    // 33 mm → fraction 13/16 → idx 3 → L
    const m = maskFixture({});
    expect(recommendSize(m, { ...M, noseWidth: 21 }).size).toBe("XS");
    expect(recommendSize(m, { ...M, noseWidth: 25 }).size).toBe("S");
    expect(recommendSize(m, { ...M, noseWidth: 29 }).size).toBe("M");
    expect(recommendSize(m, { ...M, noseWidth: 33 }).size).toBe("L");
  });

  it("clamps a measurement equal to max into the last bucket (no overflow)", () => {
    const m = maskFixture({});
    // Exact max (36) — would otherwise compute idx 4 with sizes.length 4.
    const r = recommendSize(m, { ...M, noseWidth: 36 });
    expect(r.size).toBe("L");
  });

  it("returns the smallest size with a marginal-fit rationale below range", () => {
    const m = maskFixture({});
    const r = recommendSize(m, { ...M, noseWidth: 18 });
    expect(r.size).toBe("XS");
    expect(r.rationale).toMatch(/below|verify in person/i);
  });

  it("returns the largest size with a marginal-fit rationale above range", () => {
    const m = maskFixture({});
    const r = recommendSize(m, { ...M, noseWidth: 40 });
    expect(r.size).toBe("L");
    expect(r.rationale).toMatch(/above|verify in person/i);
  });

  it("uses nose-to-chin (not nose width) for a full-face mask", () => {
    // Full-face mask: noseToChin 35..65 (range 30), sizes S/M/L (3).
    // 38 mm → fraction 3/30 = 0.1 → idx 0 → S
    // 50 mm → fraction 15/30 = 0.5 → idx 1 → M
    // 62 mm → fraction 27/30 = 0.9 → idx 2 → L
    const m = maskFixture({
      type: "fullFace",
      sizesAvailable: ["S", "M", "L"],
    });
    expect(recommendSize(m, { ...M, noseToChin: 38 }).size).toBe("S");
    expect(recommendSize(m, { ...M, noseToChin: 50 }).size).toBe("M");
    expect(recommendSize(m, { ...M, noseToChin: 62 }).size).toBe("L");
    // Sanity: rationale mentions the chin-axis label, not nose width.
    const r = recommendSize(m, { ...M, noseToChin: 50 });
    expect(r.rationale).toMatch(/nose-to-chin/i);
  });

  it("falls back to the middle index when the range is degenerate", () => {
    // Identical min == max → range = 0, can't partition.
    const m = maskFixture({
      fitRanges: {
        noseWidthMin: 28,
        noseWidthMax: 28,
        noseToChinMin: 50,
        noseToChinMax: 50,
        mouthWidthMin: 40,
        mouthWidthMax: 40,
      },
    });
    const r = recommendSize(m, M);
    // 4 sizes → middle idx = 2 → "M"
    expect(r.size).toBe("M");
    expect(r.rationale).toMatch(/too narrow|middle/i);
  });
});

// ── Manufacturer boost ──────────────────────────────────────────────
//
// PennPaps preferentially stocks the React Health line, so a viable
// React Health mask should out-rank an otherwise-equivalent mask from
// another manufacturer. The boost is applied AFTER contra/pressure
// penalties so a contraindicated React mask still loses to a viable
// non-React one. It affects RANKING only — it is excluded from the
// patient-facing `confidence`. These tests pin that behavior.

const PROFILE_MEASUREMENTS: FacialMeasurements = {
  noseWidth: 28,
  noseHeight: 25,
  noseToChin: 50,
  mouthWidth: 40,
  faceWidthAtCheekbones: 130,
  calibrationMethod: "creditCard",
};

function answers(
  overrides: Partial<QuestionnaireAnswers> = {},
): QuestionnaireAnswers {
  return {
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
    ...overrides,
  };
}

describe("recommend — React Health manufacturer boost", () => {
  it("gives the React Health iVolve P2 the SAME confidence as the equivalent ResMed AirFit P10 (boost excluded from confidence)", () => {
    // Both masks are nasal pillows with identical fit ranges and are
    // viable for this low-pressure profile, so their clinical scores are
    // equal. The manufacturer boost must NOT inflate the patient-facing
    // confidence — it only affects ranking (see the next test).
    const result = recommend(
      PROFILE_MEASUREMENTS,
      answers({
        claustrophobic: true,
        sideOrStomachSleeper: true,
        cpapPressureSetting: "low",
      }),
    );
    const all = [...result.topRecommendations, ...result.alternatives];
    const ivolveP2 = all.find((m) => m.maskId === "react-health-ivolve-p2");
    const airfitP10 = all.find((m) => m.maskId === "resmed-airfit-p10");
    expect(ivolveP2).toBeDefined();
    expect(airfitP10).toBeDefined();
    expect(ivolveP2!.confidence).toBeCloseTo(airfitP10!.confidence, 10);
  });

  it("keeps iVolve P2 ranked ahead of AirFit P10 by list order when both are viable", () => {
    const result = recommend(
      PROFILE_MEASUREMENTS,
      answers({
        claustrophobic: true,
        sideOrStomachSleeper: true,
        cpapPressureSetting: "low",
      }),
    );
    const all = [...result.topRecommendations, ...result.alternatives];
    const ivolveP2Index = all.findIndex(
      (m) => m.maskId === "react-health-ivolve-p2",
    );
    const airfitP10Index = all.findIndex((m) => m.maskId === "resmed-airfit-p10");
    expect(ivolveP2Index).toBeGreaterThanOrEqual(0);
    expect(airfitP10Index).toBeGreaterThanOrEqual(0);
    expect(ivolveP2Index).toBeLessThan(airfitP10Index);
  });

  it("does NOT promote a clinically-inappropriate React Health pillow over a viable full-face mask for a heavy mouth breather", () => {
    // Mouth breather with frequent congestion — full-face / hybrid is
    // clinically indicated; nasal pillows score badly. The boost must
    // not rescue a React Health pillow into the #1 slot here, because
    // doing so would be a clinical-safety regression.
    const result = recommend(
      PROFILE_MEASUREMENTS,
      answers({
        mouthBreather: true,
        frequentCongestion: true,
        cpapPressureSetting: "high",
      }),
    );
    const top = result.topRecommendations[0];
    expect(top).toBeDefined();
    // The #1 mask should be a full-face or hybrid, regardless of brand.
    expect(["fullFace", "hybrid"]).toContain(top.type);
  });
});

// ---------------------------------------------------------------------------
// P4 — null ("I'm not sure") path
// ---------------------------------------------------------------------------
// Three pins:
//   1. scoreAnswers treats null identically to false (no weight delta
//      from that question) — null is "no opinion", not "implicit no".
//   2. A patient who answered nothing produces the baseline 0.25 split.
//   3. The buildReasons / buildExplanation / contraindication paths
//      only fire on `=== true`, so a null-answering patient never sees
//      a reasons-string that claims they stated a need.

describe("scoreAnswers — P4 null answers are no-ops", () => {
  it("all-null answers produce the baseline 0.25 weight split (no question pushed)", () => {
    const weights = scoreAnswers({
      mouthBreather: null,
      claustrophobic: null,
      sideOrStomachSleeper: null,
      heavyFacialHair: null,
      wearsGlasses: null,
      frequentCongestion: null,
      priorMaskExperience: "none",
      mobilityLimitations: null,
      sensitiveSkin: null,
      siliconeSensitivity: null,
      cpapPressureSetting: "unknown",
    });
    expect(weights.fullFace).toBeCloseTo(0.25, 5);
    expect(weights.nasal).toBeCloseTo(0.25, 5);
    expect(weights.nasalPillow).toBeCloseTo(0.25, 5);
    expect(weights.hybrid).toBeCloseTo(0.25, 5);
  });

  it("a null answer yields the same weights as a false answer (no opposite-direction push)", () => {
    // The engine intentionally does not push the OPPOSITE direction
    // when the patient says no — there's no negative-weight branch for
    // false. So null and false must produce identical weights; the
    // P4 change is about UX honesty, not scoring math.
    const nullWeights = scoreAnswers(answers({ mouthBreather: null }));
    const falseWeights = scoreAnswers(answers({ mouthBreather: false }));
    expect(nullWeights).toEqual(falseWeights);
  });

  it("a true answer still applies its weight delta (regression)", () => {
    const trueWeights = scoreAnswers(answers({ mouthBreather: true }));
    const nullWeights = scoreAnswers(answers({ mouthBreather: null }));
    // Mouth-breather=true boosts fullFace by +0.3 vs null/false.
    expect(trueWeights.fullFace).toBeGreaterThan(nullWeights.fullFace);
  });
});

describe("recommend — P4 null answers don't fabricate reasons strings", () => {
  it("a patient who answered nothing gets no patient-stated needs in their explanation", () => {
    const result = recommend(PROFILE_MEASUREMENTS, {
      mouthBreather: null,
      claustrophobic: null,
      sideOrStomachSleeper: null,
      heavyFacialHair: null,
      wearsGlasses: null,
      frequentCongestion: null,
      priorMaskExperience: "none",
      mobilityLimitations: null,
      sensitiveSkin: null,
      siliconeSensitivity: null,
      cpapPressureSetting: "unknown",
    });
    const top = result.topRecommendations[0];
    expect(top).toBeDefined();
    // The reasoning array MUST NOT contain phrasing that asserts the
    // patient said anything — those strings are reserved for explicit
    // `=== true` (or `=== false` for the nasal-vs-mouth-breather case).
    // Also include the summary sentence (built by buildExplanation),
    // which is the other place patient-stated-needs land.
    const blob = [...top.reasoning, top.summary].join(" ").toLowerCase();
    expect(blob).not.toContain("you breathe through your mouth");
    expect(blob).not.toContain("you breathe through your nose");
    expect(blob).not.toContain("nasal congestion");
    expect(blob).not.toContain("side and stomach");
    expect(blob).not.toContain("claustrophob");
    expect(blob).not.toContain("sensitive skin");
    expect(blob).not.toContain("magnetic clips");
  });

  it("an explicit no on mouthBreather can still ground the recommendation (regression)", () => {
    const result = recommend(
      PROFILE_MEASUREMENTS,
      answers({
        mouthBreather: false,
        // Other answers stay defaulted to false → the existing
        // engine math should still produce a non-empty result.
      }),
    );
    const top = result.topRecommendations[0];
    expect(top).toBeDefined();
    expect(top.reasoning.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Confidence clamping invariant
// ---------------------------------------------------------------------------
// confidence is computed from clinicalScore only (no brand boost) and is
// clamped to [0, 1]. These tests verify the invariant holds across results.

describe("recommend — confidence clamping invariant", () => {
  it("every mask in topRecommendations has confidence in [0, 1]", () => {
    const result = recommend(
      PROFILE_MEASUREMENTS,
      answers({
        claustrophobic: true,
        sideOrStomachSleeper: true,
        cpapPressureSetting: "low",
      }),
    );
    for (const rec of result.topRecommendations) {
      expect(rec.confidence).toBeGreaterThanOrEqual(0);
      expect(rec.confidence).toBeLessThanOrEqual(1);
    }
  });

  it("every mask in alternatives has confidence in [0, 1]", () => {
    const result = recommend(PROFILE_MEASUREMENTS, answers());
    for (const rec of result.alternatives) {
      expect(rec.confidence).toBeGreaterThanOrEqual(0);
      expect(rec.confidence).toBeLessThanOrEqual(1);
    }
  });

  it("a React Health mask that ranks #1 still has confidence <= 1 even though its sortScore may exceed 1", () => {
    // For the high-fit nasal-pillow profile the iVolve P2's clinical
    // score is near the top, and the 1.15x boost raises sortScore
    // beyond 1.0. The confidence field must remain <= 1.0.
    const result = recommend(
      PROFILE_MEASUREMENTS,
      answers({
        claustrophobic: true,
        sideOrStomachSleeper: true,
        cpapPressureSetting: "low",
      }),
    );
    const all = [...result.topRecommendations, ...result.alternatives];
    const ivolveP2 = all.find((m) => m.maskId === "react-health-ivolve-p2");
    expect(ivolveP2).toBeDefined();
    expect(ivolveP2!.confidence).toBeLessThanOrEqual(1);
  });
});

// ---------------------------------------------------------------------------
// Result shape
// ---------------------------------------------------------------------------
// (sortScore/confidence independence — that the brand boost moves ranking
// but not the patient-facing confidence — is already pinned by the two
// "manufacturer boost" tests above: equal confidence for equivalent masks
// plus iVolve ranked first.)

describe("recommend — result shape", () => {
  it("always contains at least one mask for a reasonable measurement set", () => {
    // Belt-and-suspenders: the engine should never return empty lists.
    const result = recommend(PROFILE_MEASUREMENTS, answers());
    const total =
      result.topRecommendations.length + result.alternatives.length;
    expect(total).toBeGreaterThan(0);
  });
});
