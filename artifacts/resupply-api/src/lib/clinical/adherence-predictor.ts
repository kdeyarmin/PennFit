// Adherence prediction — heuristic for 90-day CMS compliance.
//
// Phase 1 heuristic (this module): scores a patient at week 1 / 2 / 4
// of therapy using observable usage stats + mask type + machine type.
// Surfaces P(meets 90-day CMS compliance) as a 0..1 plus a structured
// factor list.
//
// Phase 2 (later): replace internals with a trained XGBoost model
// once we have ~5k closed observation windows; the public interface
// is stable so the swap is a one-place change.

import { getSupabaseServiceRoleClient } from "@workspace/resupply-db";

import { logger } from "../logger";
import {
  extractAdherenceFeatures,
  toFeatureVector,
  type TherapyNightInput,
} from "./adherence-features";
import { loadConfiguredAdherenceModel } from "./adherence-model-store";
import { predictProbability, type LogisticModel } from "./logistic-regression";

export const ADHERENCE_MODEL_VERSION = "heuristic-1.0";
/** Version stamped when a configured trained model produces the score. */
export const ADHERENCE_ML_MODEL_VERSION = "logreg-1.0";

export interface AdherenceScore {
  probabilityCompliant: number;
  daysOfTherapy: number;
  factors: Array<{ key: string; weight: number; label: string }>;
  scoredAt: string;
  /** Which scorer produced this — heuristic-1.0 or logreg-1.0. */
  modelVersion: string;
}

/** Predictor night-row shape (subset selected from patient_therapy_nights). */
interface PredictorNightRow {
  usage_minutes: number | null;
  leak_rate_l_min: string | null;
  night_date: string;
}

/**
 * Pure: score via a configured trained model. Maps the predictor's night
 * rows to the harness feature contract, runs the logistic model, and
 * shapes an AdherenceScore. Unit-tested directly.
 */
export function buildMlAdherenceScore(
  model: LogisticModel,
  nights: readonly PredictorNightRow[],
  daysOfTherapy: number,
  now: Date = new Date(),
): AdherenceScore {
  const mapped: TherapyNightInput[] = nights.map((n) => ({
    nightDate: n.night_date,
    usageMinutes: n.usage_minutes,
    leakLMin: n.leak_rate_l_min == null ? null : Number(n.leak_rate_l_min),
  }));
  const probability = predictProbability(
    model,
    toFeatureVector(extractAdherenceFeatures(mapped)),
  );
  return {
    probabilityCompliant: Math.max(0.01, Math.min(0.99, probability)),
    daysOfTherapy,
    factors: [
      {
        key: "ml_model",
        weight: 0,
        label: `Scored by trained model ${ADHERENCE_ML_MODEL_VERSION} (${model.sampleCount} training samples).`,
      },
    ],
    scoredAt: now.toISOString(),
    modelVersion: ADHERENCE_ML_MODEL_VERSION,
  };
}

const COMPLIANT_MINUTES = 240;
const CMS_COMPLIANT_NIGHTS = 21;
const CMS_WINDOW_DAYS = 30;

// Heuristic weights. Each factor moves P(compliant) in one direction;
// the floor + ceiling keep the score off the rails for edge cases.
const W_WEEK1_USAGE_HIGH = 0.4; // bumps probability UP
const W_WEEK1_USAGE_LOW = 0.45; // bumps probability DOWN
const W_WEEK1_NO_DATA = 0.15;
const W_WEEK1_HIGH_LEAK = 0.2;
const W_FULL_FACE_MASK = 0.05; // small DOWN — published correlates

const FLOOR = 0.05;
const CEILING = 0.97;

export async function scorePatientAdherence(
  patientId: string,
): Promise<AdherenceScore | null> {
  const supabase = getSupabaseServiceRoleClient();
  const { data: nights } = await supabase
    .schema("resupply")
    .from("patient_therapy_nights")
    .select("usage_minutes, leak_rate_l_min, night_date")
    .eq("patient_id", patientId)
    .order("night_date", { ascending: true })
    .limit(200);
  if (!nights || nights.length === 0) {
    return {
      probabilityCompliant: 0.5,
      daysOfTherapy: 0,
      factors: [
        {
          key: "no_data",
          weight: 0,
          label: "No therapy nights on file — score defaults to 50%.",
        },
      ],
      scoredAt: new Date().toISOString(),
      modelVersion: ADHERENCE_MODEL_VERSION,
    };
  }
  const firstNight = new Date(nights[0]!.night_date).getTime();
  const daysOfTherapy = Math.floor(
    (Date.now() - firstNight) / (24 * 3600 * 1000),
  );

  // Opt-in: when a trained model is configured (ADHERENCE_MODEL_JSON), use
  // it instead of the heuristic. Unset → heuristic (the default; no
  // behavior change). A malformed value parses to null → heuristic.
  const model = loadConfiguredAdherenceModel();
  if (model) {
    return buildMlAdherenceScore(model, nights, daysOfTherapy);
  }

  // Build a 0..1 score using survival math like the denial scorer.
  let positive = 0.5; // baseline
  const factors: AdherenceScore["factors"] = [];

  const week1 = nights.slice(0, 7);
  if (week1.length === 0) {
    factors.push({
      key: "no_week1_data",
      weight: -W_WEEK1_NO_DATA,
      label: "No data in week 1 — penalty applied.",
    });
    positive -= W_WEEK1_NO_DATA;
  } else {
    const avgUsage =
      week1.reduce((s, n) => s + (n.usage_minutes ?? 0), 0) / week1.length;
    if (avgUsage >= COMPLIANT_MINUTES) {
      positive += W_WEEK1_USAGE_HIGH;
      factors.push({
        key: "week1_usage_high",
        weight: W_WEEK1_USAGE_HIGH,
        label: `Week 1 average usage ${Math.round(avgUsage)} min/night — strong predictor of 90-day compliance.`,
      });
    } else if (avgUsage > 0 && avgUsage < 180) {
      positive -= W_WEEK1_USAGE_LOW;
      factors.push({
        key: "week1_usage_low",
        weight: -W_WEEK1_USAGE_LOW,
        label: `Week 1 average usage ${Math.round(avgUsage)} min/night — high churn risk per EnsoData publications.`,
      });
    }
    const highLeak = week1.filter((n) => {
      const v = n.leak_rate_l_min ? Number.parseFloat(n.leak_rate_l_min) : 0;
      return Number.isFinite(v) && v > 24;
    }).length;
    if (highLeak >= 3) {
      positive -= W_WEEK1_HIGH_LEAK;
      factors.push({
        key: "week1_high_leak",
        weight: -W_WEEK1_HIGH_LEAK,
        label: `High mask leak on ${highLeak} of week 1 nights — coach a refit before adherence drops.`,
      });
    }
  }

  // Mask-type correlate placeholder. equipment_assets currently
  // tracks device class but not mask type; once a mask catalog FK
  // lands we can read it here and apply W_FULL_FACE_MASK (~3-5%
  // published correlate with lower 90-day adherence).
  void W_FULL_FACE_MASK;

  // Recent observed CMS-compliance signal (if we already have >=30
  // days of data). Strong evidence of where they're heading.
  if (daysOfTherapy >= CMS_WINDOW_DAYS && nights.length >= CMS_WINDOW_DAYS) {
    const recent = nights.slice(-CMS_WINDOW_DAYS);
    const compliantNights = recent.filter(
      (n) => (n.usage_minutes ?? 0) >= COMPLIANT_MINUTES,
    ).length;
    if (compliantNights >= CMS_COMPLIANT_NIGHTS) {
      positive = Math.max(positive, 0.9);
      factors.push({
        key: "recent_window_compliant",
        weight: 0.4,
        label: `Recent ${CMS_WINDOW_DAYS}-day window already CMS-compliant (${compliantNights}/${CMS_WINDOW_DAYS} nights >=4h).`,
      });
    } else if (compliantNights < CMS_COMPLIANT_NIGHTS / 2) {
      positive = Math.min(positive, 0.25);
      factors.push({
        key: "recent_window_low",
        weight: -0.4,
        label: `Recent ${CMS_WINDOW_DAYS}-day window only ${compliantNights}/${CMS_WINDOW_DAYS} compliant — coaching needed.`,
      });
    }
  }

  const probability = Math.max(FLOOR, Math.min(CEILING, positive));

  return {
    probabilityCompliant: probability,
    daysOfTherapy,
    factors,
    scoredAt: new Date().toISOString(),
    modelVersion: ADHERENCE_MODEL_VERSION,
  };
}

export async function scoreAndPersistAdherence(
  patientId: string,
): Promise<AdherenceScore | null> {
  const score = await scorePatientAdherence(patientId);
  if (!score) return null;
  const supabase = getSupabaseServiceRoleClient();
  const { error: persistErr } = await supabase
    .schema("resupply")
    .from("adherence_predictions")
    .insert({
      patient_id: patientId,
      model_version: score.modelVersion,
      days_of_therapy: score.daysOfTherapy,
      probability_compliant: score.probabilityCompliant,
      factors_json: score.factors as unknown as never,
      scored_at: score.scoredAt,
    });
  if (persistErr) {
    logger.warn(
      { err: persistErr.message, patientId },
      "adherence-predictor: persist failed (non-fatal)",
    );
  }
  return score;
}
