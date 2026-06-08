import { describe, it, expect, afterEach } from "vitest";

import {
  loadConfiguredAdherenceModel,
  parseAdherenceModel,
} from "./adherence-model-store";

const SIX = [0, 0, 0, 0, 0, 0];
function validModelJson(): string {
  return JSON.stringify({
    weights: SIX,
    bias: 0.1,
    featureMeans: SIX,
    featureStds: [1, 1, 1, 1, 1, 1],
    trainedAt: "2026-06-01T00:00:00.000Z",
    sampleCount: 1200,
  });
}

describe("parseAdherenceModel", () => {
  it("parses a valid 6-feature model", () => {
    const m = parseAdherenceModel(validModelJson());
    expect(m).not.toBeNull();
    expect(m?.weights).toHaveLength(6);
    expect(m?.bias).toBe(0.1);
    expect(m?.sampleCount).toBe(1200);
  });

  it("returns null on malformed JSON", () => {
    expect(parseAdherenceModel("{not json")).toBeNull();
  });

  it("returns null when the feature dimension doesn't match", () => {
    const m = parseAdherenceModel(
      JSON.stringify({
        weights: [0, 0, 0], // wrong length
        bias: 0,
        featureMeans: SIX,
        featureStds: SIX,
      }),
    );
    expect(m).toBeNull();
  });

  it("returns null when bias is missing/non-numeric", () => {
    expect(
      parseAdherenceModel(
        JSON.stringify({ weights: SIX, featureMeans: SIX, featureStds: SIX }),
      ),
    ).toBeNull();
  });
});

describe("loadConfiguredAdherenceModel", () => {
  const prev = process.env.ADHERENCE_MODEL_JSON;
  afterEach(() => {
    if (prev === undefined) delete process.env.ADHERENCE_MODEL_JSON;
    else process.env.ADHERENCE_MODEL_JSON = prev;
  });

  it("returns null when the env var is unset", () => {
    delete process.env.ADHERENCE_MODEL_JSON;
    expect(loadConfiguredAdherenceModel()).toBeNull();
  });

  it("loads the model when the env var holds a valid model", () => {
    process.env.ADHERENCE_MODEL_JSON = validModelJson();
    expect(loadConfiguredAdherenceModel()).not.toBeNull();
  });

  it("returns null (falls back) when the env var is malformed", () => {
    process.env.ADHERENCE_MODEL_JSON = "garbage";
    expect(loadConfiguredAdherenceModel()).toBeNull();
  });
});
