import { describe, it, expect } from "vitest";

import { buildMlAdherenceScore } from "./adherence-predictor";
import { type LogisticModel } from "./logistic-regression";

const NOW = new Date("2026-06-01T00:00:00.000Z");

function nightRows(usageMinutes: number) {
  // 7 week-1 nights so feature extraction has data.
  return Array.from({ length: 7 }, (_, i) => {
    const d = new Date(Date.UTC(2026, 0, 1));
    d.setUTCDate(d.getUTCDate() + i);
    return {
      usage_minutes: usageMinutes,
      leak_rate_l_min: "10",
      night_date: d.toISOString().slice(0, 10),
    };
  });
}

// weights[0] is week1AvgUsageHours (FEATURE_NAMES[0]); positive weight →
// more usage ⇒ higher P(compliant).
function model(week1UsageWeight: number): LogisticModel {
  return {
    weights: [week1UsageWeight, 0, 0, 0, 0, 0],
    bias: 0,
    featureMeans: [0, 0, 0, 0, 0, 0],
    featureStds: [1, 1, 1, 1, 1, 1],
    trainedAt: "2026-06-01T00:00:00.000Z",
    sampleCount: 1000,
  };
}

describe("buildMlAdherenceScore", () => {
  it("stamps the ML model version + a model factor", () => {
    const s = buildMlAdherenceScore(model(0), nightRows(300), 7, NOW);
    expect(s.modelVersion).toBe("logreg-1.0");
    expect(s.factors[0]!.key).toBe("ml_model");
    expect(s.daysOfTherapy).toBe(7);
    // bias 0 + zero weights → sigmoid(0) = 0.5.
    expect(s.probabilityCompliant).toBeCloseTo(0.5, 5);
  });

  it("reflects the model: higher week-1 usage → higher probability", () => {
    const high = buildMlAdherenceScore(model(1), nightRows(360), 7, NOW);
    const low = buildMlAdherenceScore(model(1), nightRows(60), 7, NOW);
    expect(high.probabilityCompliant).toBeGreaterThan(low.probabilityCompliant);
  });

  it("clamps probability into (0.01, 0.99)", () => {
    const s = buildMlAdherenceScore(model(100), nightRows(600), 7, NOW);
    expect(s.probabilityCompliant).toBeLessThanOrEqual(0.99);
    expect(s.probabilityCompliant).toBeGreaterThanOrEqual(0.01);
  });
});
