/**
 * Confidence scoring and the five exception states — pure.
 *
 * The point of this module is that the system is allowed to say "I don't
 * know". A recommendation engine that always returns an answer is
 * indistinguishable from one that guesses, and a guess dressed up with a
 * percentage is worse than an honest refusal.
 *
 * Confidence combines three things and nothing else:
 *   * how good the scan was (a perfect clinical match measured badly is
 *     not a confident recommendation),
 *   * how well the winning size actually fits inside its band,
 *   * how complete the patient's profile is.
 *
 * Commercial signals — formulary preference, stock position, margin — are
 * excluded by construction. They live in `rankScore`, never here.
 *
 * A clinician's sign-off is NOT a fourth input. It used to be — an
 * unreviewed size band was capped below high confidence — and that gate
 * was removed on purpose (see `resolveConfidence`). Safety is enforced
 * where it belongs, in the tier 1-2 hard filters, not by withholding a
 * percentage.
 */

import { LEGACY_PROFILE_VERSION } from "./versions.js";
import type {
  FitCandidate,
  FitOutcome,
  FitProfile,
  ScanSignals,
} from "./types.js";

/**
 * Millimetre windows outside which a measurement is not a plausible adult
 * face. Mirrors PLAUSIBILITY_BOUNDS on the client and in the legacy route;
 * a value outside these is a measurement failure, not a small patient.
 */
export const PLAUSIBILITY_BOUNDS = {
  noseWidth: [20, 60],
  noseHeight: [25, 70],
  noseToChin: [40, 90],
  mouthWidth: [30, 80],
  faceWidthAtCheekbones: [110, 180],
} as const;

/** Pediatric faces legitimately fall below the adult floor. */
export const PEDIATRIC_PLAUSIBILITY_BOUNDS = {
  noseWidth: [12, 45],
  noseHeight: [15, 55],
  noseToChin: [25, 70],
  mouthWidth: [18, 60],
  faceWidthAtCheekbones: [80, 150],
} as const;

export const CONFIDENCE_THRESHOLDS = {
  high: 0.78,
  moderate: 0.55,
  /** Scan-quality floors that gate each band independently of fit. */
  highScan: 0.75,
  moderateScan: 0.5,
} as const;

/**
 * How much of the profile the patient actually answered. An unanswered
 * profile is not a confident one — we would be recommending on geometry
 * alone, which is exactly the shallow behaviour this work replaces.
 */
export function profileCompleteness(profile: FitProfile): number {
  const answered = [
    profile.mouthBreather !== null,
    profile.nasalObstruction !== null || profile.frequentCongestion !== null,
    profile.sleepPositions.length > 0,
    profile.claustrophobia !== null,
    profile.facialHair !== null,
    profile.skinIrritation !== null || profile.sensitiveSkin !== null,
    profile.priorMaskExperience !== undefined,
    profile.handDexterity !== null || profile.headgearDifficulty !== null,
    profile.pressureCmH2O !== null || profile.pressureBand !== "unknown",
  ];
  // Completeness measures how much of what we ASKED was answered. The
  // legacy 11-question set has no minimal-contact question, so a legacy
  // profile must not carry a permanent haircut for a question the patient
  // was never shown.
  if (profile.version !== LEGACY_PROFILE_VERSION) {
    answered.push(profile.minimalContactPreference !== null);
  }
  const yes = answered.filter(Boolean).length;
  // Floor at 0.6 — a sparse profile weakens confidence but should not on
  // its own drag a good geometric match into "low".
  return 0.6 + 0.4 * (yes / answered.length);
}

export function measurementsOutOfBounds(
  measurements: Record<string, number>,
  population: "adult" | "pediatric",
): boolean {
  const bounds =
    population === "pediatric"
      ? PEDIATRIC_PLAUSIBILITY_BOUNDS
      : PLAUSIBILITY_BOUNDS;
  for (const [key, [min, max]] of Object.entries(bounds)) {
    const value = measurements[key];
    if (typeof value !== "number" || !Number.isFinite(value)) return true;
    if (value < min || value > max) return true;
  }
  return false;
}

export interface ConfidenceInput {
  top: FitCandidate | null;
  scan: ScanSignals;
  profile: FitProfile;
  measurements: Record<string, number>;
  /** True when tiers 1-2 removed every candidate. */
  everythingExcluded: boolean;
  /** True when no candidate landed inside any size band. */
  outsideValidatedRange: boolean;
  /** When false, everything resolves to high/moderate and nothing gates. */
  gatingEnabled: boolean;
}

export interface ConfidenceResult {
  outcome: FitOutcome;
  confidence: number;
  guidance: string;
  /** True when a clinician should look at this before it goes out. */
  requiresReview: boolean;
}

const GUIDANCE: Record<FitOutcome, string> = {
  high_confidence:
    "These measurements and answers give a clear match. You can go ahead and order.",
  moderate_confidence:
    "This is a good match, but worth a second look. A member of the clinical team will review it before your order ships.",
  low_confidence:
    "We don't have enough to recommend a mask confidently. The quickest fix is usually a fresh scan in better light; otherwise a respiratory therapist will fit you personally.",
  contraindicated:
    "Based on your safety answers and prescribed therapy, none of the masks we can offer are appropriate to recommend automatically. A respiratory therapist will fit you personally.",
  outside_validated_range:
    "Your measurements fall outside the range our sizing data covers, so we're not going to guess. A respiratory therapist will fit you personally.",
};

export function resolveConfidence(input: ConfidenceInput): ConfidenceResult {
  const {
    top,
    scan,
    profile,
    measurements,
    everythingExcluded,
    outsideValidatedRange,
    gatingEnabled,
  } = input;

  // 1. Nothing survived the clinical filters.
  if (everythingExcluded || !top) {
    return {
      outcome: "contraindicated",
      confidence: 0,
      guidance: GUIDANCE.contraindicated,
      requiresReview: true,
    };
  }

  // 2. Measurements outside the validated window. Checked before the
  //    score bands so a physically implausible face can never produce a
  //    confident answer just because some mask happened to score well.
  const implausible = measurementsOutOfBounds(measurements, profile.population);
  if (gatingEnabled && (implausible || outsideValidatedRange)) {
    return {
      outcome: "outside_validated_range",
      confidence: 0,
      guidance: GUIDANCE.outside_validated_range,
      requiresReview: true,
    };
  }

  // A scan can only ever hurt: at a perfect 1.0 it is neutral, and it
  // degrades the clinical score from there. This is what stops a strong
  // geometric match on a blurry, badly-lit frame reading as "high".
  const scanWeight = 0.6 + 0.4 * clamp01(scan.measurementConfidence);
  const combined = top.confidence * scanWeight * profileCompleteness(profile);

  // The scan decides.
  //
  // This used to carry a second gate: a variant whose bands were seeded
  // estimates (`needsClinicalReview`) could not reach high confidence
  // until an RT signed it off, however well it scored. That was a
  // product decision, and it has been reversed deliberately — requiring
  // a clinician to hand-approve ~290 size bands before the fitter can
  // speak confidently made the feature unusable at the scale it is meant
  // for. Confidence is now what this module always said it was: how good
  // the scan was, how well the winning size sits in its band, and how
  // complete the profile is.
  //
  // What this does NOT relax, and must not:
  //   * Tier 1-2 remain HARD FILTERS (see tiers.ts). A contraindicated or
  //     therapy-incompatible mask is removed from consideration entirely,
  //     not merely scored down — that is the safety floor and it is
  //     untouched by this change.
  //   * The scan-quality floors below still gate every band, and a
  //     capture the client judged unusable still forces low confidence.
  //   * Commercial signals are still excluded by construction.
  //
  // The cost, stated plainly: a size band that is an estimate can now
  // produce a high-confidence recommendation. `fitDataSource` still
  // records the provenance and the fit report still prints it, so the
  // claim remains auditable after the fact — but the engine no longer
  // waits for a human to vouch for the numbers.
  let outcome: FitOutcome;
  if (
    combined >= CONFIDENCE_THRESHOLDS.high &&
    scan.measurementConfidence >= CONFIDENCE_THRESHOLDS.highScan
  ) {
    outcome = "high_confidence";
  } else if (
    combined >= CONFIDENCE_THRESHOLDS.moderate &&
    scan.measurementConfidence >= CONFIDENCE_THRESHOLDS.moderateScan
  ) {
    outcome = "moderate_confidence";
  } else {
    outcome = "low_confidence";
  }

  // Honour the capture's own verdict on the frame.
  //
  // The client's aggregation sets `band: "low"` when a contributing frame
  // failed its quality gates outright — too dark, too soft, head turned
  // past the pose window. The weighted score alone does not always reach
  // that conclusion, because a single frame's fixed agreement term puts a
  // floor under `measurementConfidence` no matter how bad the pixels were.
  // Without this, a frame the capture step itself judged unusable could
  // still land a moderate recommendation.
  //
  // Only ever downgrades, and only when gating is on. Requests that send
  // no scan are unaffected: the neutral default's band is "moderate".
  if (gatingEnabled && scan.band === "low" && outcome !== "low_confidence") {
    outcome = "low_confidence";
  }

  // With gating off we never withhold a recommendation — that is the
  // pre-existing behaviour, preserved exactly for tenants who haven't
  // opted in yet.
  if (!gatingEnabled && outcome === "low_confidence") {
    outcome = "moderate_confidence";
  }

  return {
    outcome,
    confidence: Math.round(clamp01(combined) * 1000) / 1000,
    guidance: GUIDANCE[outcome],
    requiresReview: outcome !== "high_confidence",
  };
}

function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.min(1, Math.max(0, n));
}
