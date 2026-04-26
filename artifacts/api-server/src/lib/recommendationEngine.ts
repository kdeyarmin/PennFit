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

import { maskCatalog, type MaskEntry, type MaskType } from "../data/maskCatalog.js";

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
  manufacturer: string;
  type: MaskType;
  confidence: number;
  reasoning: string[];
  features: string[];
  contraindications: string[];
  imageUrl: string | null;
}

export interface RecommendationResult {
  topRecommendations: MaskRecommendation[];
  alternatives: MaskRecommendation[];
  disclaimer: string;
}

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
    weights.fullFace += 0.30;
    weights.hybrid += 0.15;
    weights.nasal -= 0.20;
    weights.nasalPillow -= 0.25;
  }

  // Claustrophobia — strongly contra-indicates full face
  // Nasal pillow is the lowest-contact option; best for claustrophobic patients
  if (answers.claustrophobic) {
    weights.nasalPillow += 0.30;
    weights.fullFace -= 0.30;
    weights.nasal += 0.05;
    weights.hybrid -= 0.10;
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
    weights.nasal += 0.10;
    weights.hybrid -= 0.10;
    weights.nasalPillow -= 0.05;
  }

  // Glasses — full face with nose bridge obstructs; under-nose or top-tube designs better
  if (answers.wearsGlasses) {
    weights.nasal += 0.10;
    weights.nasalPillow += 0.10;
    weights.hybrid += 0.05;
    weights.fullFace -= 0.15;
  }

  // Frequent congestion — nasal and nasal pillow become problematic
  // Full face allows breathing through mouth when nose is blocked
  if (answers.frequentCongestion) {
    weights.fullFace += 0.20;
    weights.hybrid += 0.10;
    weights.nasal -= 0.15;
    weights.nasalPillow -= 0.20;
  }

  // Prior experience — small nudge toward what they've used before (comfort factor)
  if (answers.priorMaskExperience !== "none") {
    const exp = answers.priorMaskExperience;
    if (exp in weights) {
      weights[exp as keyof MaskTypeWeights] += 0.10;
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
    weights.nasalPillow -= 0.10;
    weights.hybrid += 0.05;
  }

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
function scoreFitMatch(mask: MaskEntry, measurements: FacialMeasurements): number {
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

  const noseWidthScore = dimensionScore(measurements.noseWidth, fitRanges.noseWidthMin, fitRanges.noseWidthMax);
  const noseToChinScore = dimensionScore(measurements.noseToChin, fitRanges.noseToChinMin, fitRanges.noseToChinMax);
  const mouthWidthScore = dimensionScore(measurements.mouthWidth, fitRanges.mouthWidthMin, fitRanges.mouthWidthMax);

  // Weight: nose width most critical (determines pillow/cushion size), then nose-to-chin, then mouth width
  return noseWidthScore * 0.45 + noseToChinScore * 0.35 + mouthWidthScore * 0.20;
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
      reasons.push("Covers both nose and mouth — ideal since you breathe through your mouth during sleep.");
    }
    if (answers.frequentCongestion) {
      reasons.push("When nasal congestion occurs, you can continue therapy breathing through your mouth.");
    }
    if (typeWeight > 0.35) {
      reasons.push("Your answers indicate full-face coverage is clinically appropriate for your breathing patterns.");
    }
  }

  if (mask.type === "nasal") {
    if (!answers.mouthBreather) {
      reasons.push("You breathe through your nose during sleep, making a nasal mask an effective choice.");
    }
    if (answers.sideOrStomachSleeper) {
      reasons.push("Nasal masks have a lower profile than full-face masks, which helps with side sleeping.");
    }
    if (answers.wearsGlasses && mask.features.some(f => f.toLowerCase().includes("glass"))) {
      reasons.push("This mask is designed to remain clear of your line of sight, compatible with glasses.");
    }
  }

  if (mask.type === "nasalPillow") {
    if (answers.claustrophobic) {
      reasons.push("Minimal contact design — nasal pillows only contact the nostril entrance, reducing the enclosed feeling.");
    }
    if (answers.sideOrStomachSleeper) {
      reasons.push("Low-profile and flexible — stays in place for side and stomach sleepers.");
    }
    if (!answers.mouthBreather) {
      reasons.push("Works well since you breathe through your nose at night.");
    }
    if (typeWeight > 0.35) {
      reasons.push("Based on your profile, nasal pillow masks offer the best balance of comfort and minimal contact.");
    }
  }

  if (mask.type === "hybrid") {
    if (answers.mouthBreather && answers.claustrophobic) {
      reasons.push("Hybrid design bridges the gap — covers both nose and mouth while minimizing the enclosed feeling of a full-face mask.");
    }
    if (answers.sideOrStomachSleeper) {
      reasons.push("Top-of-head hose connection reduces tugging and works well with side sleeping.");
    }
  }

  // Measurement-based reasons
  const { fitRanges } = mask;
  if (
    measurements.noseWidth >= fitRanges.noseWidthMin &&
    measurements.noseWidth <= fitRanges.noseWidthMax
  ) {
    reasons.push(`Your nose width (${measurements.noseWidth.toFixed(1)} mm) fits well within this mask's cushion range.`);
  }
  if (
    measurements.noseToChin >= fitRanges.noseToChinMin &&
    measurements.noseToChin <= fitRanges.noseToChinMax
  ) {
    reasons.push(`Your nose-to-chin measurement (${measurements.noseToChin.toFixed(1)} mm) aligns with this mask's fit size.`);
  }

  // Calibration note
  if (measurements.calibrationMethod === "iris") {
    reasons.push("Measurements calibrated using iris diameter — consider verifying fit with physical sizing templates.");
  }

  // Feature highlights relevant to answers
  if (answers.sensitiveSkin && mask.features.some(f => f.toLowerCase().includes("foam") || f.toLowerCase().includes("gel") || f.toLowerCase().includes("soft"))) {
    reasons.push("Features a soft cushion that is gentler on sensitive skin.");
  }
  if (answers.mobilityLimitations && mask.features.some(f => f.toLowerCase().includes("magnetic") || f.toLowerCase().includes("clip"))) {
    reasons.push("Magnetic clips make it easier to put on and remove without fine motor precision.");
  }
  if (answers.siliconeSensitivity && mask.features.some(f => f.toLowerCase().includes("gel") || f.toLowerCase().includes("foam") || f.toLowerCase().includes("silicone-free"))) {
    reasons.push("Gel or foam cushion available — check with your DME provider for non-silicone options.");
  }

  if (reasons.length === 0) {
    reasons.push("This mask fits your facial measurements and matches your questionnaire profile.");
  }

  return reasons;
}

/**
 * Check if a mask is contraindicated for this patient.
 * Returns array of triggered contraindication strings, empty if none.
 */
function getActiveContraindications(mask: MaskEntry, answers: QuestionnaireAnswers): string[] {
  const triggered: string[] = [];

  for (const contra of mask.contraindications) {
    const lower = contra.toLowerCase();
    if (lower.includes("mouth breath") && answers.mouthBreather) {
      triggered.push(contra);
    }
    if (lower.includes("claustrophob") && answers.claustrophobic) {
      triggered.push(contra);
    }
    if ((lower.includes("facial hair") || lower.includes("beard")) && answers.heavyFacialHair) {
      triggered.push(contra);
    }
    if ((lower.includes("silicone") && lower.includes("allergy")) && answers.siliconeSensitivity) {
      triggered.push(contra);
    }
    if ((lower.includes("congestion") || lower.includes("sinusitis") || lower.includes("congested")) && answers.frequentCongestion) {
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

    // Combined score: 60% type preference (questionnaire-driven), 40% physical fit
    const rawScore = (typeScore * 0.60 + fitScore * 0.40) * contraMultiplier;

    const reasoning = generateReasoning(mask, measurements, answers, typeWeights);

    const recommendation: MaskRecommendation = {
      maskId: mask.id,
      name: mask.name,
      manufacturer: mask.manufacturer,
      type: mask.type,
      confidence: Math.min(1, Math.max(0, rawScore)),
      reasoning,
      features: mask.features,
      contraindications: mask.contraindications,
      imageUrl: mask.imageUrl,
    };

    return { recommendation, hasContraindications: activeContras.length > 0 };
  });

  // Sort by confidence descending
  scoredMasks.sort((a, b) => b.recommendation.confidence - a.recommendation.confidence);

  // Top 3 non-contraindicated recommendations
  const nonContraindicated = scoredMasks.filter((m) => !m.hasContraindications);
  const contraindicated = scoredMasks.filter((m) => m.hasContraindications);

  const topRecommendations = nonContraindicated.slice(0, 3).map((m) => m.recommendation);

  // If we don't have 3 non-contraindicated, fill with contraindicated (with lower confidence)
  while (topRecommendations.length < 3 && contraindicated.length > 0) {
    const next = contraindicated.shift();
    if (next) {
      const rec = {
        ...next.recommendation,
        reasoning: [
          "Note: This mask has considerations that may affect fit for your profile — discuss with your DME provider.",
          ...next.recommendation.reasoning,
        ],
      };
      topRecommendations.push(rec);
    }
  }

  // Alternatives: next 5 masks after top 3 (non-contraindicated preferred)
  const remaining = [...nonContraindicated.slice(3), ...contraindicated];
  const alternatives = remaining.slice(0, 5).map((m) => m.recommendation);

  const disclaimer =
    "This is a starting recommendation to guide your initial fitting — not a clinical diagnosis or prescription. " +
    "Actual mask fit depends on individual facial anatomy, pressure settings, and personal comfort. " +
    "Always work with your DME provider or a respiratory therapist to confirm fit with physical sizing templates " +
    "before finalizing your mask selection.";

  return {
    topRecommendations,
    alternatives,
    disclaimer,
  };
}
