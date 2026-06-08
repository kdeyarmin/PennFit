// Adherence-model store (RT #R7) — load an optionally-configured trained
// logistic model so the predictor can use it INSTEAD of the heuristic.
//
// Strictly opt-in + behavior-neutral by default: a model is used only
// when ADHERENCE_MODEL_JSON is set to a valid serialized LogisticModel
// (the offline harness produces one). Unset / malformed → null → the
// predictor keeps the live heuristic. No model is shipped in the repo.

import { FEATURE_NAMES } from "./adherence-features";
import { type LogisticModel } from "./logistic-regression";

const EXPECTED_DIM = FEATURE_NAMES.length;

function isNumberArray(v: unknown, len: number): v is number[] {
  return (
    Array.isArray(v) &&
    v.length === len &&
    v.every((n) => typeof n === "number" && Number.isFinite(n))
  );
}

/**
 * Parse + validate a serialized model. Returns null (never throws) when
 * the shape doesn't match the current feature contract, so a stale or
 * corrupt value can never crash scoring — it just falls back to the
 * heuristic. Pure.
 */
export function parseAdherenceModel(json: string): LogisticModel | null {
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    return null;
  }
  if (!raw || typeof raw !== "object") return null;
  const m = raw as Record<string, unknown>;
  if (!isNumberArray(m.weights, EXPECTED_DIM)) return null;
  if (!isNumberArray(m.featureMeans, EXPECTED_DIM)) return null;
  if (!isNumberArray(m.featureStds, EXPECTED_DIM)) return null;
  if (typeof m.bias !== "number" || !Number.isFinite(m.bias)) return null;
  return {
    weights: m.weights,
    bias: m.bias,
    featureMeans: m.featureMeans,
    featureStds: m.featureStds,
    trainedAt: typeof m.trainedAt === "string" ? m.trainedAt : "",
    sampleCount: typeof m.sampleCount === "number" ? m.sampleCount : 0,
  };
}

/** Load the configured model from the environment, or null when unset. */
export function loadConfiguredAdherenceModel(): LogisticModel | null {
  const json = process.env.ADHERENCE_MODEL_JSON?.trim();
  if (!json) return null;
  return parseAdherenceModel(json);
}
