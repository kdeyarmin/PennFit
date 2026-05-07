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
  recommendSize,
  type FacialMeasurements,
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
