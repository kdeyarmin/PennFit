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
// non-React one. These tests pin that behavior.

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
  it("ranks the React Health iVolve P2 above the ResMed AirFit P10 for a claustrophobic side-sleeper on low pressure", () => {
    // Both masks are nasal pillow, both rated to 20+ cmH2O, both viable
    // for this profile. Without the boost they score very close. With
    // the 1.15× boost on the React Health entry, iVolve P2 should win.
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
    expect(ivolveP2!.confidence).toBeGreaterThan(airfitP10!.confidence);
  });

  it("places at least one React Health mask in the top 3 when the patient profile is broadly viable", () => {
    // Generic, no strong contraindications — the boost should be enough
    // to push at least one React entry into the top recommendations
    // alongside the dominant-type winners.
    const result = recommend(PROFILE_MEASUREMENTS, answers());
    const topIsReact = result.topRecommendations.some(
      (m) => m.manufacturer === "React Health",
    );
    expect(topIsReact).toBe(true);
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
