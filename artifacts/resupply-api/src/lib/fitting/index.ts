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
import type {
  CatalogMask,
  ExclusionRecord,
  FitAssessment,
  FitCandidate,
  FitEngineInput,
} from "./types.js";

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
  /** Slugs the tier-1 magnet screen actually removed this session. */
  magnetExcluded: ReadonlySet<string>,
): string {
  // Before any score talk: if this IS the recommended mask minus the
  // magnets, say so. "Ranked below because its fit score is 0.04 lower"
  // is true and useless next to "same mask, magnet-free headgear".
  if (candidate.magnetFreeVariantOf === primary.maskSlug) {
    return "The same mask as the one recommended above, with magnet-free headgear clips instead of magnetic ones.";
  }
  // "A mask we had to rule out" is a claim about THIS session, so it is
  // gated on the parent actually sitting in the magnet-excluded set. A
  // twin can reach the alternatives through ordinary category selection
  // while its parent was never excluded at all — no implant answer given,
  // the twin simply outranked its parent — and saying the parent was
  // ruled out for implanted-device answers the patient never gave would
  // put a false clinical statement on the results page and the fit
  // report. Outside that case, fall through to the ordinary ranking
  // explanations.
  if (
    candidate.magnetFreeVariantOf &&
    magnetExcluded.has(candidate.magnetFreeVariantOf)
  ) {
    return "The magnet-free version of a mask we had to rule out because of the implanted-device answers.";
  }
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
/**
 * Name the manufacturer's magnet-free SKU on a magnet exclusion.
 *
 * Only when that SKU is actually in the RENDERED result — the primary or
 * an alternative the patient will see — not merely a survivor of the
 * filters. pickAlternatives caps the list at four and takes at most one
 * excluded mask's twin, so with several magnetic exclusions a twin can
 * clear every filter and still not be shown; telling the patient "we've
 * included it in your options below" about a mask that is not below is a
 * false statement on the results page. Runs as a post-pass AFTER the
 * primary and alternatives are chosen, for exactly that reason.
 *
 * Exported for direct unit testing.
 */
export function annotateMagnetFreeSwaps(
  excluded: ExclusionRecord[],
  catalog: readonly CatalogMask[],
  rendered: ReadonlySet<string>,
): ExclusionRecord[] {
  const bySlug = new Map(catalog.map((m) => [m.slug, m]));
  return excluded.map((ex) => {
    if (ex.code !== "magnetic_component_contraindicated") return ex;
    const twinSlug = bySlug.get(ex.maskSlug)?.magnetFreeVariantSlug;
    if (!twinSlug) return ex;
    const twin = bySlug.get(twinSlug);
    // Re-check the twin is actually magnet-free. A mis-seeded pointer at
    // another magnetic mask must be inert, never a safety claim.
    if (!twin || twin.hasMagneticComponents) return ex;
    if (!rendered.has(twinSlug)) return ex;
    return {
      ...ex,
      magnetFreeAlternativeSlug: twinSlug,
      magnetFreeAlternativeName: twin.modelName,
      patientReason: `${ex.patientReason} ${twin.manufacturer} makes this same mask in a magnet-free version, and we've included it in your options below.`,
      clinicianReason: `${ex.clinicianReason} A magnet-free SKU of the same model (${twinSlug}) survived every filter and is offered as an alternative.`,
    };
  });
}

function pickAlternatives(
  ranked: FitCandidate[],
  primary: FitCandidate,
  magneticSlugs: Set<string>,
  /** Magnetic parent slug -> its magnet-free twin's slug. */
  magnetFreeTwinOf: ReadonlyMap<string, string>,
  /** Slugs the tier-1 magnet filter removed, best-ranked first. */
  magnetExcludedSlugs: readonly string[],
  /** Same slugs as a set, for the wording gate in rankedBelowBecause. */
  magnetExcludedSet: ReadonlySet<string>,
): FitCandidate[] {
  const rest = ranked.filter((c) => c.maskSlug !== primary.maskSlug);
  const chosen: FitCandidate[] = [];
  const take = (c: FitCandidate | undefined) => {
    if (!c) return;
    if (chosen.some((x) => x.maskSlug === c.maskSlug)) return;
    chosen.push(c);
  };

  // The same mask minus the magnets beats every other alternative: identical
  // cushion, identical size band, nothing new to learn. Take it first.
  const primaryTwin = magnetFreeTwinOf.get(primary.maskSlug);
  if (primaryTwin) {
    take(rest.find((c) => c.maskSlug === primaryTwin));
  }

  // At most ONE twin of a mask the magnet filter removed. Capped so a
  // patient who screened positive against several magnetic masks still
  // gets a different-category option below rather than a list of near
  // duplicates.
  for (const excludedSlug of magnetExcludedSlugs) {
    const twin = magnetFreeTwinOf.get(excludedSlug);
    const found = twin ? rest.find((c) => c.maskSlug === twin) : undefined;
    if (found) {
      take(found);
      break;
    }
  }

  const primaryCategory = categoryOf(primary);
  take(rest.find((c) => categoryOf(c) === primaryCategory));
  take(rest.find((c) => categoryOf(c) !== primaryCategory));

  // A non-magnetic option matters even when the safety screen came back
  // clear: patients acquire implants, and household members change. Kept
  // alongside the same-model swap above — this answers a different
  // question, and fires for magnetic masks that have no magnet-free twin.
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
    rankedBelowBecause: rankedBelowBecause(c, primary, magnetExcludedSet),
  }));
}

export function assess(input: FitEngineInput): FitAssessment {
  const tiers = runTiers(input);
  const magneticSlugs = new Set(
    input.catalog.filter((m) => m.hasMagneticComponents).map((m) => m.slug),
  );
  // Magnetic parent -> its magnet-free twin. Only pointers whose target is
  // genuinely magnet-free are kept, so a mis-seeded row is inert here too.
  const magnetFreeTwinOf = new Map<string, string>();
  for (const m of input.catalog) {
    const twinSlug = m.magnetFreeVariantSlug;
    if (!twinSlug) continue;
    const twin = input.catalog.find((x) => x.slug === twinSlug);
    if (twin && !twin.hasMagneticComponents) {
      magnetFreeTwinOf.set(m.slug, twinSlug);
    }
  }
  const magnetExcludedSlugs = tiers.excluded
    .filter((e) => e.code === "magnetic_component_contraindicated")
    .map((e) => e.maskSlug);
  const magnetExcludedSet = new Set(magnetExcludedSlugs);

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
      : pickAlternatives(
          tiers.candidates,
          primary,
          magneticSlugs,
          magnetFreeTwinOf,
          magnetExcludedSlugs,
          magnetExcludedSet,
        );

  // Annotate the exclusion records only now, against what the patient
  // will actually SEE — the primary plus the chosen alternatives — so
  // "we've included it in your options below" is never said about a twin
  // pickAlternatives capped out. (On the withheld path the clinical
  // reference list stands in for the options and is annotated the same
  // way — those masks ARE shown, just unbadged.)
  const renderedSlugs = new Set<string>(
    [primary?.maskSlug, ...alternatives.map((a) => a.maskSlug)].filter(
      (slug): slug is string => Boolean(slug),
    ),
  );
  const excluded = annotateMagnetFreeSwaps(
    tiers.excluded,
    input.catalog,
    renderedSlugs,
  );

  const catalogSnapshotVersion = input.catalog.reduce(
    (max, m) => Math.max(max, m.catalogVersion),
    0,
  );

  return {
    outcome: confidence.outcome,
    primary,
    alternatives,
    excluded,
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
      formularyExcludedSlugs: tiers.formularyExcludedSlugs,
      outsideValidatedRange: tiers.outsideValidatedRange,
      degraded: input.degraded,
    },
  };
}

export { RULES_ENGINE_VERSION, FIT_PROFILE_VERSION } from "./versions.js";
export * from "./types.js";
export {
  resolveFormulary,
  formularyMultiplier,
  resolveCatalogVisibility,
  isManufacturerHidden,
  NO_HIDDEN_CATALOG,
  OPEN_FORMULARY,
  type CatalogVisibility,
} from "./formulary.js";
export {
  resolveConfidence,
  measurementsOutOfBounds,
  profileCompleteness,
  ADULT_PLAUSIBILITY_BOUNDS,
  PEDIATRIC_PLAUSIBILITY_BOUNDS,
  UNION_PLAUSIBILITY_BOUNDS,
  PLAUSIBILITY_FIELDS,
  type PlausibilityField,
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
