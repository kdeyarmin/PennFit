/**
 * `assess()` — the clinical fitting engine's single entry point. Pure.
 *
 * Takes measurements, a patient fit profile, scan-quality signals, a
 * catalog, a formulary, and safety answers; returns a primary
 * recommendation, ranked alternatives, an explicit record of what was
 * ruled out and why, a confidence band, and the provenance needed to
 * reprint the result years later.
 *
 * No I/O. The caller loads the catalog and formulary (`catalog-store.ts`)
 * and persists the outcome; this module only decides.
 */

import { resolveConfidence } from "./confidence.js";
import { runTiers } from "./tiers.js";
import { RULES_ENGINE_VERSION } from "./versions.js";
import type { FitAssessment, FitCandidate, FitEngineInput } from "./types.js";

export const FIT_DISCLAIMER =
  "This is a sizing guide based on facial measurements and the answers you gave us — not a clinical fitting. " +
  "Your provider confirms the final mask and size, and you can change it at setup if it doesn't feel right.";

/** Interface categories that answer a similar clinical question. */
function categoryOf(c: FitCandidate): string {
  switch (c.interfaceType) {
    case "nasal_pillow":
    case "nasal_cradle":
      return "minimal";
    case "nasal":
      return "nasal";
    case "full_face":
    case "total_face":
      return "full_face";
    case "hybrid":
    case "oral":
      return "hybrid";
    default:
      return c.interfaceType;
  }
}

/**
 * Explain, in one sentence, why a candidate ranked below the primary.
 * Generated from whichever term actually cost it the position, so the
 * report never says "lower score" without saying which score.
 */
function rankedBelowBecause(
  candidate: FitCandidate,
  primary: FitCandidate,
): string {
  if (candidate.outsideFormulary && !primary.outsideFormulary) {
    return (
      candidate.outsideFormularyReason ??
      "Sits outside your provider's formulary."
    );
  }
  const fitGap = primary.facialFitScore - candidate.facialFitScore;
  const factorGap = primary.patientFactorScore - candidate.patientFactorScore;
  if (fitGap > 0.08 && fitGap >= factorGap) {
    return "Your measurements sit closer to the middle of the recommended mask's size range.";
  }
  if (factorGap > 0.08) {
    return "The recommended mask is a better match for what you told us about how you sleep and what's bothered you before.";
  }
  if (
    candidate.availability === "out" ||
    candidate.availability === "not_stocked"
  ) {
    return "Clinically comparable, but not currently on the shelf at your location.";
  }
  if (candidate.cautions.length > 0) {
    return candidate.cautions[0]!;
  }
  return "A close second — the recommended mask scored marginally higher on fit and comfort together.";
}

/**
 * Pick the alternatives the spec requires:
 *   * the best alternative in the SAME interface category,
 *   * the best in a DIFFERENT appropriate category,
 *   * a non-magnetic alternative whenever the primary has magnets.
 *
 * Deduplicated, order preserved, capped at four so the results page stays
 * a decision rather than a catalog.
 */
function pickAlternatives(
  ranked: FitCandidate[],
  primary: FitCandidate,
  magneticSlugs: Set<string>,
): FitCandidate[] {
  const rest = ranked.filter((c) => c.maskSlug !== primary.maskSlug);
  const chosen: FitCandidate[] = [];
  const take = (c: FitCandidate | undefined) => {
    if (!c) return;
    if (chosen.some((x) => x.maskSlug === c.maskSlug)) return;
    chosen.push(c);
  };

  const primaryCategory = categoryOf(primary);
  take(rest.find((c) => categoryOf(c) === primaryCategory));
  take(rest.find((c) => categoryOf(c) !== primaryCategory));

  // A non-magnetic option matters even when the safety screen came back
  // clear: patients acquire implants, and household members change.
  if (magneticSlugs.has(primary.maskSlug)) {
    take(rest.find((c) => !magneticSlugs.has(c.maskSlug)));
  }

  // Top up to at least two so the caller always has real choices.
  for (const c of rest) {
    if (chosen.length >= 2) break;
    take(c);
  }

  return chosen.slice(0, 4).map((c) => ({
    ...c,
    rankedBelowBecause: rankedBelowBecause(c, primary),
  }));
}

export function assess(input: FitEngineInput): FitAssessment {
  const tiers = runTiers(input);
  const magneticSlugs = new Set(
    input.catalog.filter((m) => m.hasMagneticComponents).map((m) => m.slug),
  );

  const top = tiers.candidates[0] ?? null;
  const confidence = resolveConfidence({
    top,
    scan: input.scan,
    profile: input.profile,
    measurements: input.measurements as unknown as Record<string, number>,
    everythingExcluded: tiers.candidates.length === 0,
    outsideValidatedRange: tiers.outsideValidatedRange,
    gatingEnabled: input.confidenceGating,
  });

  // On a withheld outcome we deliberately return no primary. Showing a
  // product card next to "we can't recommend this confidently" is exactly
  // the mixed message the exception states exist to prevent.
  const withheld =
    confidence.outcome === "contraindicated" ||
    confidence.outcome === "low_confidence" ||
    confidence.outcome === "outside_validated_range";

  const primary = withheld ? null : top;
  const alternatives =
    primary === null
      ? // Still surface the closest options so a clinician has somewhere
        // to start, but without a "recommended" badge on any of them.
        tiers.candidates.slice(0, 3).map((c) => ({
          ...c,
          rankedBelowBecause:
            "Shown for clinical reference only — not an automated recommendation.",
        }))
      : pickAlternatives(tiers.candidates, primary, magneticSlugs);

  const catalogSnapshotVersion = input.catalog.reduce(
    (max, m) => Math.max(max, m.catalogVersion),
    0,
  );

  return {
    outcome: confidence.outcome,
    primary,
    alternatives,
    excluded: tiers.excluded,
    recommendationConfidence: confidence.confidence,
    safetyFlags: tiers.safetyFlags,
    guidance: confidence.guidance,
    disclaimer: FIT_DISCLAIMER,
    provenance: {
      rulesEngineVersion: RULES_ENGINE_VERSION,
      formularyId: input.formulary.id,
      formularyName: input.formulary.name,
      formularyVersion: input.formulary.version,
      catalogSnapshotVersion,
      formularyRulesMatched: tiers.formularyRulesMatched,
      degraded: input.degraded,
    },
  };
}

export { RULES_ENGINE_VERSION, FIT_PROFILE_VERSION } from "./versions.js";
export * from "./types.js";
export {
  resolveFormulary,
  formularyMultiplier,
  OPEN_FORMULARY,
} from "./formulary.js";
export {
  resolveConfidence,
  measurementsOutOfBounds,
  profileCompleteness,
  PLAUSIBILITY_BOUNDS,
  CONFIDENCE_THRESHOLDS,
} from "./confidence.js";
export {
  runTiers,
  applySafetyExclusions,
  applyTherapyCompatibility,
  scoreFacialFit,
  scorePatientFactors,
  scoreVariant,
  resolveSafetyFlags,
  supplyMultiplier,
} from "./tiers.js";
