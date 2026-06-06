// Auto-enroll early-risk patients into adherence coaching (RT #R3).
//
// Why this exists
// ---------------
// The adherence heuristic (`scorePatientAdherence`) already flags who is
// likely to MISS the Medicare 90-day compliance window, but until now a
// human had to read the score and open a `patient_coaching_plans` row by
// hand. By the time anyone looks, the early-therapy window — where a mask
// refit or a pressure tweak can still save the patient — is often gone.
//
// This sweep closes that gap: it scores active patients still inside the
// early window and, for the genuinely at-risk ones with no plan already,
// opens a coaching plan so the RT queue surfaces them automatically. It
// reuses the existing scorer and the existing plan model — no new schema.
//
// Posture
// -------
// Creating clinical-workflow records automatically is a real action, so
// the worker registration is OFF by default and opt-in via an env gate
// (see worker/jobs/coaching-auto-enroll.ts). This module is the pure-ish
// engine; the decision rule `shouldAutoEnroll` is fully unit-tested.
//
// Idempotency
// -----------
// A patient with an open plan — or one closed within the last 30 days
// (a CSR just worked/resolved it) — is suppressed, so re-runs never pile
// duplicate plans onto the same patient or churn a freshly-closed one.

import { getSupabaseServiceRoleClient } from "@workspace/resupply-db";

import { logger } from "../logger";
import {
  scorePatientAdherence,
  type AdherenceScore,
} from "./adherence-predictor";

/**
 * Enroll at/below this predicted P(90-day compliant). Calibrated against
 * the scorer's weights: a real low-usage week 1 lands ~0.05 and a
 * high-leak week 1 lands ~0.30 (both enrolled), while a patient whose
 * ONLY negative is a week-1 data GAP lands ~0.35 (NOT enrolled) — so a
 * sync hiccup alone never auto-opens a plan.
 */
export const RISK_THRESHOLD = 0.3;
/** Need a few nights of signal before acting. */
export const EARLY_WINDOW_MIN_DAYS = 5;
/** Past this, the 90-day window has usually closed; coaching is reactive. */
export const EARLY_WINDOW_MAX_DAYS = 60;

const RECENT_NIGHT_DAYS = 14;
const MAX_CANDIDATES = 1000;
const MAX_ENROLLMENTS_PER_RUN = 100;
const RECENT_PLAN_SUPPRESSION_DAYS = 30;
const AUTO_ENROLL_ACTOR = "system:cron:coaching-auto-enroll";
const DEFAULT_TARGET_COMPLIANCE_PCT = 70;

export interface AutoEnrollOptions {
  riskThreshold?: number;
  minDays?: number;
  maxDays?: number;
}

/**
 * Pure decision: should this adherence score auto-open a coaching plan?
 * True only for a patient inside the early-therapy window whose predicted
 * 90-day compliance is at/below the risk threshold. The window bound also
 * excludes the no-data case (the scorer returns daysOfTherapy=0 with no
 * nights on file).
 */
export function shouldAutoEnroll(
  score: AdherenceScore,
  opts: AutoEnrollOptions = {},
): boolean {
  const riskThreshold = opts.riskThreshold ?? RISK_THRESHOLD;
  const minDays = opts.minDays ?? EARLY_WINDOW_MIN_DAYS;
  const maxDays = opts.maxDays ?? EARLY_WINDOW_MAX_DAYS;
  if (score.daysOfTherapy < minDays || score.daysOfTherapy > maxDays) {
    return false;
  }
  return score.probabilityCompliant <= riskThreshold;
}

export interface AutoEnrollSweepStats {
  candidates: number;
  scored: number;
  enrolled: number;
  skippedExistingPlan: number;
}

/**
 * Scan patients with a therapy night in the last 14 days, score the ones
 * without a recent/open coaching plan, and open a plan for the early-risk
 * ones (capped per run). Returns a stats envelope for the worker to log.
 */
export async function runCoachingAutoEnrollSweep(): Promise<AutoEnrollSweepStats> {
  const supabase = getSupabaseServiceRoleClient();
  const stats: AutoEnrollSweepStats = {
    candidates: 0,
    scored: 0,
    enrolled: 0,
    skippedExistingPlan: 0,
  };

  // 1. Candidates: patients with a recent therapy night (active on PAP).
  const since = new Date();
  since.setUTCDate(since.getUTCDate() - RECENT_NIGHT_DAYS);
  const sinceIso = since.toISOString().slice(0, 10);
  const { data: nightRows, error: nightsErr } = await supabase
    .schema("resupply")
    .from("patient_therapy_nights")
    .select("patient_id")
    .gte("night_date", sinceIso)
    .limit(MAX_CANDIDATES * RECENT_NIGHT_DAYS);
  const candidateIds = [...new Set((nightRows ?? []).map((r) => r.patient_id))];
  stats.candidates = candidateIds.length;
  if (candidateIds.length === 0) return stats;

  // 2. Suppress patients with an open plan OR one closed in the last 30
  //    days — never duplicate, never churn a plan a CSR just worked.
  const suppressSinceMs =
    Date.now() - RECENT_PLAN_SUPPRESSION_DAYS * 24 * 3600 * 1000;
  const { data: plans, error: plansErr } = await supabase
    .schema("resupply")
    .from("patient_coaching_plans")
    .select("patient_id, closed_at")
    .in("patient_id", candidateIds);
  if (plansErr) throw plansErr;
  const suppressed = new Set<string>();
  for (const p of plans ?? []) {
    if (p.closed_at == null || Date.parse(p.closed_at) >= suppressSinceMs) {
      suppressed.add(p.patient_id);
    }
  }

  // 3. Score the rest; open a plan for the early-risk ones (capped).
  for (const patientId of candidateIds) {
    if (stats.enrolled >= MAX_ENROLLMENTS_PER_RUN) break;
    if (suppressed.has(patientId)) {
      stats.skippedExistingPlan += 1;
      continue;
    }
    let score: AdherenceScore | null;
    try {
      score = await scorePatientAdherence(patientId);
    } catch (err) {
      logger.warn(
        {
          err:
            err instanceof Error
              ? { name: err.name, message: err.message }
              : { message: String(err) },
          patientId,
        },
        "coaching-auto-enroll: score failed (skip)",
      );
    }
    if (!score) continue;
    stats.scored += 1;
    if (!shouldAutoEnroll(score)) continue;

    const { error: insErr } = await supabase
      .schema("resupply")
      .from("patient_coaching_plans")
      .insert({
        patient_id: patientId,
        status: "open",
        opened_by_user_id: AUTO_ENROLL_ACTOR,
        target_compliance_pct: DEFAULT_TARGET_COMPLIANCE_PCT,
      });
    if (insErr) {
      logger.warn(
        { err: insErr, patientId },
        "coaching-auto-enroll: plan insert failed (skip)",
      );
      continue;
    }
    stats.enrolled += 1;
  }

  return stats;
}
