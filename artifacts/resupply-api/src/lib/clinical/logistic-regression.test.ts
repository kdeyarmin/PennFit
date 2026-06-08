import { describe, it, expect } from "vitest";

import {
  evaluate,
  predictProbability,
  trainLogisticRegression,
  type TrainingSample,
} from "./logistic-regression";

// A deterministic, linearly-separable dataset: label = 1 iff x0 > x1.
function makeSeparable(): TrainingSample[] {
  const out: TrainingSample[] = [];
  for (let a = 0; a < 10; a++) {
    for (let b = 0; b < 10; b++) {
      if (a === b) continue; // drop the ambiguous diagonal
      out.push({ x: [a, b], y: a > b ? 1 : 0 });
    }
  }
  return out;
}

describe("trainLogisticRegression + evaluate", () => {
  it("learns a separable boundary (high AUC + accuracy)", () => {
    const samples = makeSeparable();
    const model = trainLogisticRegression(samples, { iterations: 800 });
    const m = evaluate(model, samples);
    expect(m.n).toBe(samples.length);
    expect(m.auc).toBeGreaterThan(0.95);
    expect(m.accuracy).toBeGreaterThan(0.9);
    expect(model.sampleCount).toBe(samples.length);
    expect(model.featureMeans).toHaveLength(2);
  });

  it("predicts the right side of the boundary", () => {
    const model = trainLogisticRegression(makeSeparable(), { iterations: 800 });
    expect(predictProbability(model, [9, 0])).toBeGreaterThan(0.5); // a>b → compliant
    expect(predictProbability(model, [0, 9])).toBeLessThan(0.5); // a<b → not
  });

  it("handles a constant (zero-variance) feature without NaN", () => {
    const samples: TrainingSample[] = [
      { x: [1, 5], y: 1 },
      { x: [0, 5], y: 0 },
      { x: [1, 5], y: 1 },
      { x: [0, 5], y: 0 },
    ];
    const model = trainLogisticRegression(samples, { iterations: 200 });
    const p = predictProbability(model, [1, 5]);
    expect(Number.isFinite(p)).toBe(true);
  });
});

describe("evaluate — degenerate inputs", () => {
  it("returns auc 0.5 for an empty set", () => {
    const model = trainLogisticRegression([{ x: [0], y: 0 }]);
    expect(evaluate(model, []).auc).toBe(0.5);
  });

  it("returns auc 0.5 when only one class is present", () => {
    const samples: TrainingSample[] = [
      { x: [1], y: 1 },
      { x: [2], y: 1 },
    ];
    const model = trainLogisticRegression(samples, { iterations: 50 });
    expect(evaluate(model, samples).auc).toBe(0.5);
  });
});
