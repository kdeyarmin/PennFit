/**
 * Recommendation Engine
 *
 * Pure recommendation logic: takes facial measurements + questionnaire scores
 * and returns ranked mask recommendations with plain-English reasoning.
 *
 * Clinical guidance references:
 *   - American Academy of Sleep Medicine (AASM): "Clinical Guidelines for the
 *     Manual Titration of Positive Airway Pressure in Patients with Obstructive
 *     Sleep Apnea" (2008, updated 2019)
 *   - Carlucci A, et al. "CPAP mask selection" Respir Care. 2015
 *   - DME clinical notes on contraindications for different mask types
 *
 * This module is STATELESS and contains no PHI. Inputs are numeric measurements
 * and boolean/enum answers. No images are accepted or processed here.
 */

import {
  maskCatalog,
  type MaskEntry,
  type MaskType,
} from "../../data/maskCatalog.js";

export interface FacialMeasurements {
  noseWidth: number;
  noseHeight: number;
  noseToChin: number;
  mouthWidth: number;
  faceWidthAtCheekbones: number;
  calibrationMethod: "creditCard" | "iris" | "manual";
}

export interface QuestionnaireAnswers {
  mouthBreather: boolean;
  claustrophobic: boolean;
  sideOrStomachSleeper: boolean;
  heavyFacialHair: boolean;
  wearsGlasses: boolean;
  frequentCongestion: boolean;
  priorMaskExperience: "none" | "nasal" | "nasalPillow" | "fullFace" | "hybrid";
  mobilityLimitations: boolean;
  sensitiveSkin: boolean;
  siliconeSensitivity: boolean;
  cpapPressureSetting: "unknown" | "low" | "medium" | "high";
}

export interface MaskTypeWeights {
  fullFace: number;
  nasal: number;
  nasalPillow: number;
  hybrid: number;
}

export interface MaskRecommendation {
  maskId: string;
  name: string;
  modelNumber: string;
  manufacturer: string;
  type: MaskType;
  confidence: number;
  summary: string;
  reasoning: string[];
  features: string[];
  contraindications: string[];
  imageUrl: string | null;
  /**
   * Best-guess size for this patient given their measurements, e.g. "M".
   * `null` when the mask only ships in a single size (no choice to make)
   * or when sizesAvailable is empty in the catalog. The string always
   * matches one of the entries in MaskEntry.sizesAvailable so the UI
   * can highlight it directly.
   */
  recommendedSize: string | null;
  /**
   * One-sentence rationale for `recommendedSize`. Always present (never
   * null) so the UI can render it without a conditional. When the mask
   * is single-sized this is a "no size choice" sentence. Treat as
   * guidance, not a clinical fitting.
   */
  sizeRationale: string;
}

export interface RecommendationResult {
  topRecommendations: MaskRecommendation[];
  alternatives: MaskRecommendation[];
  disclaimer: string;
}

/**
 * Per-manufacturer score multiplier applied at the end of `recommend()`,
 * AFTER the contraindication and pressure-rating penalties. PennPaps
 * preferentially stocks the React Health line (iVolve, Numa, Viva), so
 * a viable React Health mask should out-rank an otherwise-equivalent
 * mask from another manufacturer.
 *
 * The multiplier kicks in *after* `contraMultiplier * pressureMultiplier`,
 * so a contraindicated React mask (e.g. a nasal pillow for a heavy
 * mouth breather) still loses to a viable non-React mask — the boost
 * only matters when the React mask is already a clinically appropriate
 * choice. That's the intent of "weight React most when one of their
 * masks could be appropriate".
 *
 * Magnitude is intentionally modest: a ~15% bump is enough to promote
 * a competitive React mask past a non-React peer with a similar score,
 * but small enough that it cannot rescue a clearly worse-fitting mask.
 */
const MANUFACTURER_BOOST: Record<string, number> = {
  "React Health": 1.15,
};

/**
 * Score questionnaire answers into mask type weights.
 *
 * Clinical rationale:
 *   - Full face: indicated for mouth breathers (primary), high pressure, severe OSA
 *     Contraindicated: heavy beard (seal breaks), claustrophobia
 *   - Nasal: good all-rounder, needs closed mouth or chin strap
 *     Contraindicated: mouth breathing without chin strap, congestion
 *   - Nasal pillow: best for claustrophobia, side sleepers, active sleepers
 *     Contraindicated: very high pressures, nasal obstruction, mouth breathing
 *   - Hybrid: nasal pillow + mouth coverage — bridges nasal and full face
 *     Good for patients who partially mouth breathe but dislike full face
 */
export function scoreAnswers(answers: QuestionnaireAnswers): MaskTypeWeights {
  const weights: MaskTypeWeights = {
    fullFace: 0.25,
    nasal: 0.25,
    nasalPillow: 0.25,
    hybrid: 0.25,
  };

  // Mouth breather — strongly indicates full face or hybrid
  // Source: AASM guidelines — full face recommended when patient cannot maintain oral closure
  if (answers.mouthBreather) {
    weights.fullFace += 0.3;
    weights.hybrid += 0.15;
    weights.nasal -= 0.2;
    weights.nasalPillow -= 0.25;
  }

  // Claustrophobia — strongly contra-indicates full face
  // Nasal pillow is the lowest-contact option; best for claustrophobic patients
  if (answers.claustrophobic) {
    weights.nasalPillow += 0.3;
    weights.fullFace -= 0.3;
    weights.nasal += 0.05;
    weights.hybrid -= 0.1;
  }

  // Side/stomach sleeper — nasal pillow and minimal-contact masks fit better
  // Full face masks are more likely to dislodge with lateral head position
  if (answers.sideOrStomachSleeper) {
    weights.nasalPillow += 0.15;
    weights.nasal += 0.05;
    weights.fullFace -= 0.15;
    weights.hybrid += 0.05;
  }

  // Heavy facial hair — prevents seal on silicone cushions touching face
  // Full face is worst (largest cushion contact area); nasal pillow still risky
  // Minimally-contacting nasal masks are best option; hybrid okay if under-nose
  if (answers.heavyFacialHair) {
    weights.fullFace -= 0.25;
    weights.nasal += 0.1;
    weights.hybrid -= 0.1;
    weights.nasalPillow -= 0.05;
  }

  // Glasses — full face with nose bridge obstructs; under-nose or top-tube designs better
  if (answers.wearsGlasses) {
    weights.nasal += 0.1;
    weights.nasalPillow += 0.1;
    weights.hybrid += 0.05;
    weights.fullFace -= 0.15;
  }

  // Frequent congestion — nasal and nasal pillow become problematic
  // Full face allows breathing through mouth when nose is blocked
  if (answers.frequentCongestion) {
    weights.fullFace += 0.2;
    weights.hybrid += 0.1;
    weights.nasal -= 0.15;
    weights.nasalPillow -= 0.2;
  }

  // Prior experience — small nudge toward what they've used before (comfort factor)
  if (answers.priorMaskExperience !== "none") {
    const exp = answers.priorMaskExperience;
    if (exp in weights) {
      weights[exp as keyof MaskTypeWeights] += 0.1;
    }
  }

  // Mobility limitations — prefer easy clip-on / low-headgear designs
  // Magnetic clips and minimal adjustments help; this doesn't strongly favor a type
  // but slight preference for simpler masks (nasal/nasalPillow)
  if (answers.mobilityLimitations) {
    weights.nasalPillow += 0.05;
    weights.nasal += 0.05;
  }

  // Sensitive skin — memory foam or gel cushions preferred over standard silicone
  // All types can have sensitive-skin variants; slight preference for pillow (less surface area)
  if (answers.sensitiveSkin) {
    weights.nasalPillow += 0.05;
  }

  // Silicone sensitivity — most cushions are silicone; gel or foam alternatives available
  // Does not eliminate a mask type but reduces nasal pillow slightly (pillows are mostly silicone)
  if (answers.siliconeSensitivity) {
    weights.nasalPillow -= 0.1;
    weights.hybrid += 0.05;
  }

  // CPAP pressure setting
  // Source: AASM titration guidelines; manufacturer pressure ratings on most
  // nasal pillows top out around 20 cmH2O, while full-face masks are rated to 25+.
  // High pressures (>15) make a tight, broad-contact seal mandatory.
  if (answers.cpapPressureSetting === "high") {
    weights.fullFace += 0.2;
    weights.hybrid += 0.1;
    weights.nasalPillow -= 0.2;
    weights.nasal -= 0.05;
  } else if (answers.cpapPressureSetting === "low") {
    // Low pressure makes minimal-contact masks more viable / comfortable
    weights.nasalPillow += 0.05;
    weights.nasal += 0.05;
  }
  // medium and unknown: no adjustment (medium is the design center for most masks)

  // Normalize to [0, 1]
  const total = Object.values(weights).reduce((a, b) => a + b, 0);
  if (total > 0) {
    (Object.keys(weights) as Array<keyof MaskTypeWeights>).forEach((k) => {
      weights[k] = Math.max(0, weights[k] / total);
    });
  }

  return weights;
}

/**
 * Score how well a mask's physical fit ranges match the patient's measurements.
 * Returns a score 0–1. 1 = perfect fit center, 0 = outside range.
 *
 * Scoring: measurements within the fit range score 1.0.
 * Measurements outside are penalized proportionally to how far outside.
 */
function scoreFitMatch(
  mask: MaskEntry,
  measurements: FacialMeasurements,
): number {
  const { fitRanges } = mask;

  function dimensionScore(value: number, min: number, max: number): number {
    if (value >= min && value <= max) return 1.0;
    const range = max - min;
    if (range <= 0) return value === min ? 1.0 : 0;
    const overMin = Math.max(0, min - value);
    const overMax = Math.max(0, value - max);
    const overshoot = Math.max(overMin, overMax);
    // Penalize by how far outside the range (max penalty at 1.5x range away)
    return Math.max(0, 1 - overshoot / (range * 0.5));
  }

  const noseWidthScore = dimensionScore(
    measurements.noseWidth,
    fitRanges.noseWidthMin,
    fitRanges.noseWidthMax,
  );
  const noseToChinScore = dimensionScore(
    measurements.noseToChin,
    fitRanges.noseToChinMin,
    fitRanges.noseToChinMax,
  );
  const mouthWidthScore = dimensionScore(
    measurements.mouthWidth,
    fitRanges.mouthWidthMin,
    fitRanges.mouthWidthMax,
  );

  // Weight: nose width most critical (determines pillow/cushion size), then nose-to-chin, then mouth width
  return noseWidthScore * 0.45 + noseToChinScore * 0.35 + mouthWidthScore * 0.2;
}

/**
 * Pick the best-guess size for `mask` given the patient's measurements.
 *
 * Why a heuristic and not per-size dimensions:
 *   The mask catalog stores per-mask `fitRanges` (the overall envelope
 *   across every size the mask ships in) and `sizesAvailable` as a
 *   string array (e.g. ["S","M","L"]). We do NOT have per-size mm
 *   bands in the catalog yet — adding them requires manufacturer
 *   spec sheets we don't all have. Until then we partition the mask's
 *   overall fit range into N equal buckets and pick by where the
 *   patient lands. Conservative on purpose: the rationale always
 *   labels the result as "estimated" and the UI repeats the
 *   "verify at fitting" disclaimer the rest of the recommendation
 *   already shows.
 *
 * Dimension choice mirrors the weighting in `scoreFitMatch`:
 *   - nasal / nasalPillow: nose width (cushion seat is the constraint)
 *   - fullFace / hybrid:   nose-to-chin (mask body length is the constraint)
 *
 * Edge cases:
 *   - 0 sizes:    null + "single-size" rationale
 *   - 1 size:     return it
 *   - degenerate range (min == max): pick middle index
 *   - measurement < min or > max: clamp to the smallest/largest size
 *     and warn in the rationale (the patient may be marginal for the mask)
 */
export interface SizeRecommendation {
  size: string | null;
  rationale: string;
}

export function recommendSize(
  mask: MaskEntry,
  measurements: FacialMeasurements,
): SizeRecommendation {
  const sizes = mask.sizesAvailable ?? [];
  if (sizes.length === 0) {
    return {
      size: null,
      rationale: "This mask ships in a single universal size — no size choice needed.",
    };
  }
  if (sizes.length === 1) {
    return {
      size: sizes[0],
      rationale: `Only ships in size ${sizes[0]}.`,
    };
  }

  let value: number;
  let min: number;
  let max: number;
  let axisLabel: string;
  if (mask.type === "fullFace" || mask.type === "hybrid") {
    value = measurements.noseToChin;
    min = mask.fitRanges.noseToChinMin;
    max = mask.fitRanges.noseToChinMax;
    axisLabel = "nose-to-chin distance";
  } else {
    // nasal, nasalPillow
    value = measurements.noseWidth;
    min = mask.fitRanges.noseWidthMin;
    max = mask.fitRanges.noseWidthMax;
    axisLabel = "nose width";
  }

  const range = max - min;
  if (range <= 0) {
    const idx = Math.floor(sizes.length / 2);
    return {
      size: sizes[idx],
      rationale: `Estimated size ${sizes[idx]} (mask's ${axisLabel} range is too narrow to refine).`,
    };
  }

  if (value < min) {
    return {
      size: sizes[0],
      rationale: `Your ${axisLabel} (${value} mm) is below this mask's ${min}–${max} mm range. Try size ${sizes[0]} but verify in person — you may be a marginal fit.`,
    };
  }
  if (value > max) {
    const last = sizes[sizes.length - 1];
    return {
      size: last,
      rationale: `Your ${axisLabel} (${value} mm) is above this mask's ${min}–${max} mm range. Try size ${last} but verify in person — you may be a marginal fit.`,
    };
  }

  // Linear partition: divide [min, max] into sizes.length equal buckets.
  // The boundary case `value === max` rounds the index down to the last
  // bucket so we never overflow.
  const fraction = (value - min) / range;
  const rawIdx = Math.floor(fraction * sizes.length);
  const idx = Math.min(rawIdx, sizes.length - 1);
  return {
    size: sizes[idx],
    rationale: `Estimated size ${sizes[idx]} from your ${axisLabel} (${value} mm) within the mask's ${min}–${max} mm range. Final fit confirmed at PennPaps.`,
  };
}

/**
 * Generate plain-English reasoning for a recommendation.
 */
function generateReasoning(
  mask: MaskEntry,
  measurements: FacialMeasurements,
  answers: QuestionnaireAnswers,
  typeWeights: MaskTypeWeights,
): string[] {
  const reasons: string[] = [];
  const typeWeight = typeWeights[mask.type];

  // Type-based reasons from questionnaire
  if (mask.type === "fullFace") {
    if (answers.mouthBreather) {
      reasons.push(
        "Covers both nose and mouth — ideal since you breathe through your mouth during sleep.",
      );
    }
    if (answers.frequentCongestion) {
      reasons.push(
        "When nasal congestion occurs, you can continue therapy breathing through your mouth.",
      );
    }
    if (typeWeight > 0.35) {
      reasons.push(
        "Your answers indicate full-face coverage is clinically appropriate for your breathing patterns.",
      );
    }
  }

  if (mask.type === "nasal") {
    if (!answers.mouthBreather) {
      reasons.push(
        "You breathe through your nose during sleep, making a nasal mask an effective choice.",
      );
    }
    if (answers.sideOrStomachSleeper) {
      reasons.push(
        "Nasal masks have a lower profile than full-face masks, which helps with side sleeping.",
      );
    }
    if (
      answers.wearsGlasses &&
      mask.features.some((f) => f.toLowerCase().includes("glass"))
    ) {
      reasons.push(
        "This mask is designed to remain clear of your line of sight, compatible with glasses.",
      );
    }
  }

  if (mask.type === "nasalPillow") {
    if (answers.claustrophobic) {
      reasons.push(
        "Minimal contact design — nasal pillows only contact the nostril entrance, reducing the enclosed feeling.",
      );
    }
    if (answers.sideOrStomachSleeper) {
      reasons.push(
        "Low-profile and flexible — stays in place for side and stomach sleepers.",
      );
    }
    if (!answers.mouthBreather) {
      reasons.push("Works well since you breathe through your nose at night.");
    }
    if (typeWeight > 0.35) {
      reasons.push(
        "Based on your profile, nasal pillow masks offer the best balance of comfort and minimal contact.",
      );
    }
  }

  if (mask.type === "hybrid") {
    if (answers.mouthBreather && answers.claustrophobic) {
      reasons.push(
        "Hybrid design bridges the gap — covers both nose and mouth while minimizing the enclosed feeling of a full-face mask.",
      );
    }
    if (answers.sideOrStomachSleeper) {
      reasons.push(
        "Top-of-head hose connection reduces tugging and works well with side sleeping.",
      );
    }
  }

  // Measurement-based reasons
  const { fitRanges } = mask;
  if (
    measurements.noseWidth >= fitRanges.noseWidthMin &&
    measurements.noseWidth <= fitRanges.noseWidthMax
  ) {
    reasons.push(
      `Your nose width (${measurements.noseWidth.toFixed(1)} mm) fits well within this mask's cushion range.`,
    );
  }
  if (
    measurements.noseToChin >= fitRanges.noseToChinMin &&
    measurements.noseToChin <= fitRanges.noseToChinMax
  ) {
    reasons.push(
      `Your nose-to-chin measurement (${measurements.noseToChin.toFixed(1)} mm) aligns with this mask's fit size.`,
    );
  }

  // Calibration note
  if (measurements.calibrationMethod === "iris") {
    reasons.push(
      "Measurements calibrated using iris diameter — consider verifying fit with physical sizing templates.",
    );
  }

  // Feature highlights relevant to answers
  if (
    answers.sensitiveSkin &&
    mask.features.some(
      (f) =>
        f.toLowerCase().includes("foam") ||
        f.toLowerCase().includes("gel") ||
        f.toLowerCase().includes("soft"),
    )
  ) {
    reasons.push("Features a soft cushion that is gentler on sensitive skin.");
  }
  if (
    answers.mobilityLimitations &&
    mask.features.some(
      (f) =>
        f.toLowerCase().includes("magnetic") ||
        f.toLowerCase().includes("clip"),
    )
  ) {
    reasons.push(
      "Magnetic clips make it easier to put on and remove without fine motor precision.",
    );
  }
  if (
    answers.siliconeSensitivity &&
    mask.features.some(
      (f) =>
        f.toLowerCase().includes("gel") ||
        f.toLowerCase().includes("foam") ||
        f.toLowerCase().includes("silicone-free"),
    )
  ) {
    reasons.push(
      "Gel or foam cushion available — check with your DME provider for non-silicone options.",
    );
  }

  if (reasons.length === 0) {
    reasons.push(
      "This mask fits your facial measurements and matches your questionnaire profile.",
    );
  }

  return reasons;
}

/**
 * Generate a personalized one-sentence summary tying the patient's specific
 * measurements and stated needs to the chosen mask. This is what the customer
 * sees first — it should sound human, not clinical.
 */
function generateSummary(
  mask: MaskEntry,
  measurements: FacialMeasurements,
  answers: QuestionnaireAnswers,
): string {
  // Build a profile of the patient's most relevant needs, but only include
  // needs that are CONGRUENT with the recommended mask type — never claim a
  // user "prefers minimal coverage" while we're handing them a full-face mask.
  const needs: string[] = [];
  if (
    answers.mouthBreather &&
    (mask.type === "fullFace" || mask.type === "hybrid")
  ) {
    needs.push("breathe through your mouth at night");
  }
  if (
    answers.claustrophobic &&
    (mask.type === "nasalPillow" || mask.type === "nasal")
  ) {
    needs.push("prefer minimal facial coverage");
  }
  if (answers.sideOrStomachSleeper) needs.push("sleep on your side or stomach");
  if (
    answers.heavyFacialHair &&
    (mask.type === "nasalPillow" || mask.type === "hybrid")
  ) {
    needs.push("have facial hair");
  }
  if (answers.wearsGlasses) needs.push("wear glasses");
  if (
    answers.frequentCongestion &&
    (mask.type === "fullFace" || mask.type === "hybrid")
  ) {
    needs.push("often have nasal congestion");
  }
  if (answers.sensitiveSkin) needs.push("have sensitive skin");
  if (
    answers.siliconeSensitivity &&
    !mask.cushionMaterial.toLowerCase().includes("silicone")
  ) {
    needs.push("are sensitive to silicone");
  }
  if (answers.mobilityLimitations) needs.push("need easy on/off");

  const needsClause =
    needs.length === 0
      ? "you primarily need a comfortable nasal-breathing seal"
      : needs.length === 1
        ? `you ${needs[0]}`
        : needs.length === 2
          ? `you ${needs[0]} and ${needs[1]}`
          : `you ${needs.slice(0, -1).join(", ")}, and ${needs[needs.length - 1]}`;

  // Highlight the mask's most relevant matching feature
  let matchClause = "";
  if (mask.type === "fullFace") {
    matchClause = "covers both your nose and mouth for stable airflow";
  } else if (mask.type === "nasal") {
    matchClause =
      "seals comfortably over the nose with a lower profile than full-face";
  } else if (mask.type === "nasalPillow") {
    matchClause =
      "uses minimal-contact nasal pillows that stay clear of your face";
  } else if (mask.type === "hybrid") {
    matchClause =
      "combines a top-of-head hose with under-nose coverage for freedom of movement";
  }

  // Add ONE feature-specific tie-in that actually addresses a stated need
  const featureLower = mask.features.map((f) => f.toLowerCase());
  if (
    answers.mobilityLimitations &&
    featureLower.some((f) => f.includes("magnetic"))
  ) {
    matchClause +=
      ", and the magnetic clips make it easy to put on and take off";
  } else if (
    answers.wearsGlasses &&
    featureLower.some(
      (f) =>
        f.includes("glass") || f.includes("top-of-head") || f.includes("open"),
    )
  ) {
    matchClause +=
      ", and it stays clear of your line of sight so glasses fit comfortably";
  } else if (
    answers.sensitiveSkin &&
    (mask.cushionMaterial.toLowerCase().includes("foam") ||
      mask.cushionMaterial.toLowerCase().includes("gel"))
  ) {
    matchClause += `, and the ${mask.cushionMaterial.toLowerCase()} cushion is gentler on sensitive skin`;
  } else if (
    answers.sideOrStomachSleeper &&
    (mask.hoseConnection === "top" ||
      featureLower.some(
        (f) =>
          f.includes("low profile") ||
          f.includes("compact") ||
          f.includes("minimal"),
      ))
  ) {
    matchClause +=
      mask.hoseConnection === "top"
        ? ", and the top-of-head hose stays out of the way when you change positions"
        : ", and the low-profile design holds its seal when you move";
  }

  // Truth-preserving measurement tie-in: only claim a "fits squarely within"
  // when the patient's nose width is actually inside the mask's range.
  // Otherwise use neutral wording about the closest available size range.
  const noseW = measurements.noseWidth;
  const min = mask.fitRanges.noseWidthMin;
  const max = mask.fitRanges.noseWidthMax;
  let measureClause: string;
  if (noseW >= min && noseW <= max) {
    measureClause = `your ${noseW.toFixed(0)} mm nose width falls within the ${min}–${max} mm range of available cushion sizes`;
  } else {
    // Out of range — be honest about it and recommend professional sizing
    const direction = noseW < min ? "narrower than" : "wider than";
    measureClause = `your ${noseW.toFixed(0)} mm nose width is ${direction} this mask's typical ${min}–${max} mm range, so a sizing fitting at Penn Home Medical Supply is recommended`;
  }

  return `Because ${needsClause}, the ${mask.manufacturer} ${mask.name} (model ${mask.modelNumber}) ${matchClause} — and ${measureClause}.`;
}

/**
 * Check if a mask is contraindicated for this patient.
 * Returns array of triggered contraindication strings, empty if none.
 */
function getActiveContraindications(
  mask: MaskEntry,
  answers: QuestionnaireAnswers,
): string[] {
  const triggered: string[] = [];

  for (const contra of mask.contraindications) {
    const lower = contra.toLowerCase();
    if (lower.includes("mouth breath") && answers.mouthBreather) {
      triggered.push(contra);
    }
    if (lower.includes("claustrophob") && answers.claustrophobic) {
      triggered.push(contra);
    }
    if (
      (lower.includes("facial hair") || lower.includes("beard")) &&
      answers.heavyFacialHair
    ) {
      triggered.push(contra);
    }
    if (
      lower.includes("silicone") &&
      lower.includes("allergy") &&
      answers.siliconeSensitivity
    ) {
      triggered.push(contra);
    }
    if (
      (lower.includes("congestion") ||
        lower.includes("sinusitis") ||
        lower.includes("congested")) &&
      answers.frequentCongestion
    ) {
      triggered.push(contra);
    }
  }

  return triggered;
}

/**
 * Main recommendation function.
 *
 * For any plausible input, at least one viable mask is returned.
 * (Guaranteed because we return alternatives even when confidence is low.)
 */
export function recommend(
  measurements: FacialMeasurements,
  answers: QuestionnaireAnswers,
): RecommendationResult {
  const typeWeights = scoreAnswers(answers);

  const scoredMasks = maskCatalog.map((mask) => {
    const fitScore = scoreFitMatch(mask, measurements);
    const typeScore = typeWeights[mask.type];
    const activeContras = getActiveContraindications(mask, answers);

    // Contraindicated masks get a severe penalty but are not fully excluded
    // They may still appear in alternatives with low confidence
    const contraMultiplier = activeContras.length > 0 ? 0.15 : 1.0;

    // Pressure-rating penalty: if the patient is on high pressure (>15 cmH2O)
    // but the mask isn't rated for it, mark it as a soft contra. Most nasal
    // pillows top out at ~20 cmH2O; high-pressure patients need a mask rated
    // ≥20 to preserve the seal under load.
    let pressureMultiplier = 1.0;
    let pressureNote: string | null = null;
    if (answers.cpapPressureSetting === "high" && mask.pressureRangeMax < 20) {
      pressureMultiplier = 0.5;
      pressureNote = `Note: ${mask.name} is rated up to ${mask.pressureRangeMax} cmH₂O; high-pressure patients (15+) typically need a mask rated to at least 20 cmH₂O.`;
    }

    // Combined score: 60% type preference (questionnaire-driven), 40% physical fit
    // Manufacturer boost is applied LAST (after contra/pressure penalties) so a
    // contraindicated preferred-line mask still loses to a viable non-preferred
    // mask. See MANUFACTURER_BOOST docstring.
    const brandMultiplier = MANUFACTURER_BOOST[mask.manufacturer] ?? 1.0;
    const rawScore =
      (typeScore * 0.6 + fitScore * 0.4) *
      contraMultiplier *
      pressureMultiplier *
      brandMultiplier;

    const reasoning = generateReasoning(
      mask,
      measurements,
      answers,
      typeWeights,
    );
    if (pressureNote) reasoning.unshift(pressureNote);
    const summary = generateSummary(mask, measurements, answers);

    const sizeRec = recommendSize(mask, measurements);
    const recommendation: MaskRecommendation = {
      maskId: mask.id,
      name: mask.name,
      modelNumber: mask.modelNumber,
      manufacturer: mask.manufacturer,
      type: mask.type,
      confidence: Math.min(1, Math.max(0, rawScore)),
      summary,
      reasoning,
      features: mask.features,
      contraindications: mask.contraindications,
      imageUrl: mask.imageUrl,
      recommendedSize: sizeRec.size,
      sizeRationale: sizeRec.rationale,
    };

    return {
      recommendation,
      sortScore: rawScore,
      hasContraindications:
        activeContras.length > 0 || pressureMultiplier < 1.0,
      maskType: mask.type,
    };
  });

  // Sort by unclamped raw score so boosted masks can still outrank
  // otherwise-equivalent peers even when display confidence is capped at 1.0.
  scoredMasks.sort((a, b) => b.sortScore - a.sortScore);

  // Top 3 non-contraindicated recommendations
  const nonContraindicated = scoredMasks.filter((m) => !m.hasContraindications);
  const contraindicated = scoredMasks.filter((m) => m.hasContraindications);

  // Build top 3 with diversification: prefer at least 2 distinct mask types
  // in the top 3 so the customer has a meaningful choice between options
  // rather than 3 nearly-identical masks. The #1 slot is always the highest
  // scorer; slot #3 is swapped for a different-type mask if available within
  // a reasonable confidence band.
  const topRecommendations: MaskRecommendation[] = [];
  if (nonContraindicated.length > 0) {
    topRecommendations.push(nonContraindicated[0].recommendation);
  }
  if (nonContraindicated.length > 1) {
    topRecommendations.push(nonContraindicated[1].recommendation);
  }
  if (nonContraindicated.length > 2) {
    const slot3Default = nonContraindicated[2];
    const top1Type = nonContraindicated[0].maskType;
    const top2Type =
      nonContraindicated.length > 1 ? nonContraindicated[1].maskType : null;
    const allSameSoFar = top2Type === null || top1Type === top2Type;
    const slot3SameType = slot3Default.maskType === top1Type;

    // If the top 3 would otherwise all be the same type, look for a
    // different-type alternative whose confidence is within 0.20 of the
    // default slot-3 candidate. Otherwise keep the natural ranking.
    if (allSameSoFar && slot3SameType) {
      const alt = nonContraindicated
        .slice(3)
        .find(
          (m) =>
            m.maskType !== top1Type &&
            m.sortScore >= slot3Default.sortScore - 0.2,
        );
      topRecommendations.push((alt ?? slot3Default).recommendation);
    } else {
      topRecommendations.push(slot3Default.recommendation);
    }
  }

  // If we don't have 3 non-contraindicated, fill with contraindicated (with lower confidence)
  let contraIdx = 0;
  while (topRecommendations.length < 3 && contraIdx < contraindicated.length) {
    const next = contraindicated[contraIdx++];
    const rec = {
      ...next.recommendation,
      reasoning: [
        "Note: This mask has considerations that may affect fit for your profile — discuss with your DME provider.",
        ...next.recommendation.reasoning,
      ],
    };
    topRecommendations.push(rec);
  }

  // Alternatives: next 5 masks after top 3 (non-contraindicated preferred)
  const usedIds = new Set(topRecommendations.map((r) => r.maskId));
  const remaining = [
    ...nonContraindicated.filter((m) => !usedIds.has(m.recommendation.maskId)),
    ...contraindicated.filter((m) => !usedIds.has(m.recommendation.maskId)),
  ];
  const alternatives = remaining.slice(0, 5).map((m) => m.recommendation);

  const disclaimer =
    "This is a starting recommendation from Penn Home Medical Supply to guide your initial fitting — not a clinical diagnosis or prescription. " +
    "Actual mask fit depends on individual facial anatomy, pressure settings, and personal comfort. " +
    "Please contact your Penn Home Medical Supply respiratory therapist or DME specialist to confirm fit with physical sizing templates " +
    "before finalizing your mask selection.";

  return {
    topRecommendations,
    alternatives,
    disclaimer,
  };
}
