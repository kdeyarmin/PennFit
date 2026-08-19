/**
 * The tiered recommendation pipeline — pure.
 *
 * The hierarchy, in strict order:
 *
 *   1. Safety                     HARD FILTER
 *   2. Therapy compatibility      HARD FILTER
 *   3. Facial fit                 score
 *   4. Patient characteristics    score
 *   5. Provider formulary         bounded multiplier
 *   6. Inventory and financial    bounded multiplier
 *
 * Tiers 1 and 2 are FILTERS, never score reductions. A candidate they
 * remove leaves the pipeline with a reason attached and nothing downstream
 * can re-admit it. That is the whole difference from the previous engine,
 * where a contraindication was a 0.15 multiplier that a large enough
 * commercial boost could out-score.
 *
 * Tiers 5 and 6 are multipliers bounded so tightly that they can only
 * re-order near-ties, and they feed the RANKING score only — never the
 * patient-facing confidence.
 */

import { formularyMultiplier, resolveFormulary } from "./formulary.js";
import type {
  CatalogMask,
  ContraindicationFactor,
  ExclusionRecord,
  FitCandidate,
  FitContext,
  FitEngineInput,
  FitMeasurements,
  FitProfile,
  Formulary,
  MaskAvailability,
  SafetyResponse,
  SafetyScreen,
  SizeChoice,
  SizeVariant,
} from "./types.js";

// ── Tier 1: safety ───────────────────────────────────────────────────

export interface SafetyResult {
  survivors: CatalogMask[];
  excluded: ExclusionRecord[];
  flags: string[];
}

/**
 * Resolve the safety screen into risk flags.
 *
 * `unsure` is honoured per the question's own `unsureBehavesAs`, which the
 * seeded magnetic screen sets to `exclude`. Screening for an implanted
 * device is the one place where the safe default is to assume the risk is
 * present rather than to assume it away.
 */
export function resolveSafetyFlags(
  screen: SafetyScreen | null,
  responses: SafetyResponse[],
): { flags: string[]; disqualifiedAttributes: Set<string> } {
  const flags: string[] = [];
  const disqualifiedAttributes = new Set<string>();
  if (!screen) return { flags, disqualifiedAttributes };

  const byKey = new Map(responses.map((r) => [r.questionKey, r.answer]));
  for (const question of screen.questions) {
    const answer = byKey.get(question.questionKey);
    if (answer === undefined) continue;

    const triggers =
      answer === "yes" ||
      (answer === "unsure" && question.unsureBehavesAs !== "ignore");
    if (!triggers) continue;

    if (!flags.includes(question.riskFlag)) flags.push(question.riskFlag);

    const hard =
      question.severity === "exclude" &&
      (answer === "yes" || question.unsureBehavesAs === "exclude");
    if (hard && question.disqualifiesAttribute) {
      disqualifiedAttributes.add(question.disqualifiesAttribute);
    }
  }
  return { flags, disqualifiedAttributes };
}

function profileFactors(profile: FitProfile): Set<ContraindicationFactor> {
  const active = new Set<ContraindicationFactor>();
  if (profile.mouthBreather === true) active.add("mouth_breathing");
  if (
    profile.frequentCongestion === true ||
    profile.nasalObstruction === "chronic" ||
    profile.nasalObstruction === "post_surgical"
  ) {
    active.add("nasal_obstruction");
  }
  if (profile.claustrophobia === "severe") active.add("claustrophobia");
  if (profile.facialHair === "full_beard") active.add("facial_hair");
  if (profile.dentures === true) active.add("dentures");
  if (
    profile.skinIrritation === "pressure_sore" ||
    profile.siliconeSensitivity === true
  ) {
    active.add("skin_breakdown");
  }
  if (profile.pressureBand === "high") active.add("high_pressure");
  if (profile.supplementalOxygen === true) active.add("supplemental_oxygen");
  if (profile.handDexterity === "limited") active.add("hand_dexterity");
  if (profile.visionOrCognitiveLimitation === true) {
    active.add("vision_cognitive");
  }
  if (
    profile.sleepPositions.includes("side") ||
    profile.sleepPositions.includes("stomach")
  ) {
    active.add("side_sleeping");
  }
  return active;
}

export function applySafetyExclusions(
  catalog: CatalogMask[],
  profile: FitProfile,
  screen: SafetyScreen | null,
  responses: SafetyResponse[],
  magnetScreening: boolean,
): SafetyResult {
  const { flags, disqualifiedAttributes } = magnetScreening
    ? resolveSafetyFlags(screen, responses)
    : { flags: [], disqualifiedAttributes: new Set<string>() };

  const active = profileFactors(profile);
  const survivors: CatalogMask[] = [];
  const excluded: ExclusionRecord[] = [];

  for (const mask of catalog) {
    // Service line. A pediatric interface must never reach an adult, and
    // an adult-only interface must never reach a child.
    if (
      mask.serviceLine !== "both" &&
      mask.serviceLine !== profile.population
    ) {
      excluded.push({
        maskSlug: mask.slug,
        maskName: mask.modelName,
        tier: 1,
        code: "service_line_mismatch",
        patientReason:
          profile.population === "pediatric"
            ? "This mask is made for adults."
            : "This mask is made for children.",
        clinicianReason: `Service line mismatch: the model is ${mask.serviceLine}, the session is ${profile.population}.`,
      });
      continue;
    }

    // Magnetic components vs a screened implanted device — patient or
    // household member.
    if (
      disqualifiedAttributes.has("has_magnetic_components") &&
      mask.hasMagneticComponents
    ) {
      const householdOnly =
        flags.includes("magnet_implant_household") &&
        !flags.includes("magnet_implant_patient");
      excluded.push({
        maskSlug: mask.slug,
        maskName: mask.modelName,
        tier: 1,
        code: "magnetic_component_contraindicated",
        patientReason: householdOnly
          ? "This mask uses magnets in the headgear, and someone in your home has an implanted medical device."
          : "This mask uses magnets in the headgear, which is not safe with your implanted medical device.",
        clinicianReason:
          "Magnetic headgear clips excluded by the magnetic-component safety screen (" +
          flags.join(", ") +
          ").",
      });
      continue;
    }

    // Structured hard contraindications from the catalog.
    const hard = mask.contraindications.find(
      (c) => c.severity === "exclude" && active.has(c.factor),
    );
    if (hard) {
      excluded.push({
        maskSlug: mask.slug,
        maskName: mask.modelName,
        tier: 1,
        code: `contraindicated:${hard.factor}`,
        patientReason: hard.rationale,
        clinicianReason: `Hard contraindication (${hard.factor}): ${hard.rationale}`,
      });
      continue;
    }

    survivors.push(mask);
  }

  return { survivors, excluded, flags };
}

// ── Tier 2: therapy compatibility ────────────────────────────────────

export interface TherapyResult {
  survivors: CatalogMask[];
  excluded: ExclusionRecord[];
}

export function applyTherapyCompatibility(
  catalog: CatalogMask[],
  profile: FitProfile,
  strictPressure: boolean,
): TherapyResult {
  const survivors: CatalogMask[] = [];
  const excluded: ExclusionRecord[] = [];

  for (const mask of catalog) {
    if (!mask.therapyModes.includes(profile.therapyMode)) {
      excluded.push({
        maskSlug: mask.slug,
        maskName: mask.modelName,
        tier: 2,
        code: "therapy_mode_unsupported",
        patientReason: `This mask isn't made for ${profile.therapyMode === "niv" ? "non-invasive ventilation" : "CPAP therapy"}.`,
        clinicianReason: `Model supports ${mask.therapyModes.join("/")}; session therapy mode is ${profile.therapyMode}.`,
      });
      continue;
    }

    // Vent configuration. A non-vented mask on a single-limb CPAP circuit
    // has no CO2 washout path — a rebreathing hazard, not a preference.
    if (profile.therapyMode === "pap" && mask.vented === "non_vented") {
      excluded.push({
        maskSlug: mask.slug,
        maskName: mask.modelName,
        tier: 2,
        code: "vent_incompatible",
        patientReason:
          "This mask has no built-in vent, so it can't be used with a standard CPAP machine.",
        clinicianReason:
          "Non-vented mask on a single-limb PAP circuit: no CO2 washout path. Requires an active exhalation valve or a dual-limb circuit.",
      });
      continue;
    }
    if (profile.therapyMode === "niv" && mask.vented === "vented") {
      excluded.push({
        maskSlug: mask.slug,
        maskName: mask.modelName,
        tier: 2,
        code: "vent_incompatible",
        patientReason:
          "This mask has a built-in vent, which isn't compatible with the ventilator circuit prescribed for you.",
        clinicianReason:
          "Vented mask on an NIV circuit with an active exhalation valve. A non-vented interface is required.",
      });
      continue;
    }

    // Prescribed pressure above the mask's rated maximum. Under strict
    // gating this is an exclusion rather than the old 0.5 score penalty —
    // a mask rated to 20 cmH2O cannot hold a 25 cmH2O prescription, and
    // scoring that down still lets it win a weak field.
    const prescribed = profile.pressureCmH2O;
    if (
      strictPressure &&
      prescribed !== null &&
      mask.pressureMax !== null &&
      prescribed > mask.pressureMax
    ) {
      excluded.push({
        maskSlug: mask.slug,
        maskName: mask.modelName,
        tier: 2,
        code: "pressure_rating_exceeded",
        patientReason: `This mask is rated up to ${mask.pressureMax} cmH₂O, below your prescribed pressure of ${prescribed} cmH₂O.`,
        clinicianReason: `Prescribed ${prescribed} cmH2O exceeds the model's rated maximum of ${mask.pressureMax} cmH2O.`,
      });
      continue;
    }

    if (
      profile.supplementalOxygen === true &&
      mask.supportsSupplementalOxygen === false
    ) {
      excluded.push({
        maskSlug: mask.slug,
        maskName: mask.modelName,
        tier: 2,
        code: "oxygen_entrainment_unsupported",
        patientReason: "This mask can't take a supplemental oxygen connection.",
        clinicianReason:
          "Model does not support oxygen entrainment; the session reports supplemental O2 use.",
      });
      continue;
    }

    survivors.push(mask);
  }

  return { survivors, excluded };
}

// ── Tier 3: facial fit ───────────────────────────────────────────────

const MEASUREMENT_OF_BAND: Record<string, keyof FitMeasurements> = {
  noseWidth: "noseWidth",
  noseHeight: "noseHeight",
  noseToChin: "noseToChin",
  mouthWidth: "mouthWidth",
  faceWidth: "faceWidthAtCheekbones",
};

interface BandCheck {
  key: keyof FitMeasurements;
  min: number;
  max: number;
  value: number;
}

function bandsFor(variant: SizeVariant, m: FitMeasurements): BandCheck[] {
  const pairs: Array<[string, number | null, number | null]> = [
    ["noseWidth", variant.noseWidthMin, variant.noseWidthMax],
    ["noseHeight", variant.noseHeightMin, variant.noseHeightMax],
    ["noseToChin", variant.noseToChinMin, variant.noseToChinMax],
    ["mouthWidth", variant.mouthWidthMin, variant.mouthWidthMax],
    ["faceWidth", variant.faceWidthMin, variant.faceWidthMax],
  ];
  const out: BandCheck[] = [];
  for (const [name, min, max] of pairs) {
    // A NULL band means the dimension does not gate this size. Skip it
    // rather than treating the absence of data as a failed match.
    if (min === null || max === null || max <= min) continue;
    const key = MEASUREMENT_OF_BAND[name]!;
    out.push({ key, min, max, value: m[key] });
  }
  return out;
}

/**
 * Score one size variant against the measurements.
 *
 * Returns null when the variant carries no usable bands at all — a variant
 * with no geometry cannot claim a fit, and silently scoring it 1.0 would be
 * the worst possible failure mode.
 */
export function scoreVariant(
  variant: SizeVariant,
  m: FitMeasurements,
): {
  score: number;
  margin: number;
  used: Array<keyof FitMeasurements>;
} | null {
  const bands = bandsFor(variant, m);
  if (bands.length === 0) return null;

  let total = 0;
  let worstMargin = 1;
  for (const band of bands) {
    const width = band.max - band.min;
    if (band.value >= band.min && band.value <= band.max) {
      total += 1;
      // How far inside the band, 0 at an edge and 1 dead centre.
      const centre = (band.min + band.max) / 2;
      const margin = 1 - Math.abs(band.value - centre) / (width / 2);
      worstMargin = Math.min(worstMargin, margin);
    } else {
      const overshoot =
        band.value < band.min ? band.min - band.value : band.value - band.max;
      // Falls to zero one half-width outside the band.
      total += Math.max(0, 1 - overshoot / (width * 0.5));
      worstMargin = 0;
    }
  }

  return {
    score: total / bands.length,
    margin: worstMargin,
    used: bands.map((b) => b.key),
  };
}

function describeSize(
  variant: SizeVariant,
  used: Array<keyof FitMeasurements>,
  inBand: boolean,
): string {
  const names: Record<keyof FitMeasurements, string> = {
    noseWidth: "nose width",
    noseHeight: "nose height",
    noseToChin: "nose-to-chin height",
    mouthWidth: "mouth width",
    faceWidthAtCheekbones: "face width",
  };
  const list = used.map((u) => names[u]).join(" and ");
  // Cite a source when there IS one to cite. An estimated band used to
  // read "based on estimated sizing data pending clinical review" — a
  // hedge in the sentence a patient reads, and dropped deliberately along
  // with the RT sign-off gate it referred to.
  //
  // The provenance itself is unchanged: `fit_data_source` still records
  // it, the clinical fit report still prints it, and the admin review
  // queue still lists it. It simply no longer appears in patient copy.
  const source =
    variant.fitDataSource === "manufacturer"
      ? "manufacturer fitting data"
      : variant.fitDataSource === "measured"
        ? "measured sample data"
        : null;
  const because = source ? `, based on ${source}` : "";
  return inBand
    ? `Your ${list} falls inside the ${variant.sizeLabel} range${because}.`
    : `Your ${list} sits just outside the ${variant.sizeLabel} range — ${variant.sizeLabel} is the closest available size${because}. Verify the fit in person.`;
}

export interface FacialFitResult {
  score: number;
  cushion: SizeChoice | null;
  frame: SizeChoice | null;
  /** True when no variant of any component put the patient inside a band. */
  outsideAllBands: boolean;
}

export function scoreFacialFit(
  mask: CatalogMask,
  m: FitMeasurements,
): FacialFitResult {
  const pick = (
    components: SizeVariant["component"][],
  ): { choice: SizeChoice | null; score: number; inBand: boolean } => {
    const candidates = mask.variants.filter(
      (v) => components.includes(v.component) && v.status !== "discontinued",
    );
    let best: {
      variant: SizeVariant;
      score: number;
      margin: number;
      used: Array<keyof FitMeasurements>;
    } | null = null;
    for (const variant of candidates) {
      const scored = scoreVariant(variant, m);
      if (!scored) continue;
      if (!best || scored.score > best.score) {
        best = { variant, ...scored };
      }
    }
    if (!best) {
      // No geometry at all. Fall back to the flagged default size so the
      // patient still gets a size to try, but score it neutrally low so a
      // mask with real bands always wins on fit.
      const fallback =
        candidates.find((v) => v.isDefault) ?? candidates[0] ?? null;
      if (!fallback) return { choice: null, score: 0, inBand: false };
      return {
        choice: {
          variantId: fallback.id,
          component: fallback.component,
          sizeCode: fallback.sizeCode,
          sizeLabel: fallback.sizeLabel,
          manufacturerPartNumber: fallback.manufacturerPartNumber,
          bandMargin: 0,
          fitDataSource: fallback.fitDataSource,
          needsClinicalReview: fallback.needsClinicalReview,
          measurementsUsed: [],
          rationale: `No sizing data is on file for this component, so the standard ${fallback.sizeLabel} is suggested. Confirm the fit in person.`,
        },
        score: 0.5,
        inBand: false,
      };
    }
    const inBand = best.margin > 0;
    return {
      choice: {
        variantId: best.variant.id,
        component: best.variant.component,
        sizeCode: best.variant.sizeCode,
        sizeLabel: best.variant.sizeLabel,
        manufacturerPartNumber: best.variant.manufacturerPartNumber,
        bandMargin: best.margin,
        fitDataSource: best.variant.fitDataSource,
        needsClinicalReview: best.variant.needsClinicalReview,
        measurementsUsed: best.used,
        rationale: describeSize(best.variant, best.used, inBand),
      },
      score: best.score,
      inBand,
    };
  };

  const cushion = pick(["cushion", "pillow", "full_assembly"]);
  const frame = pick(["frame"]);

  // Frame sizing is independent on tube-up designs but absent on most
  // models; weight it lightly and only when it exists.
  const score =
    frame.choice && frame.choice.measurementsUsed.length > 0
      ? cushion.score * 0.8 + frame.score * 0.2
      : cushion.score;

  return {
    score,
    cushion: cushion.choice,
    frame: frame.choice,
    outsideAllBands: !cushion.inBand,
  };
}

// ── Tier 4: patient characteristics and preferences ──────────────────

export interface PatientFactorResult {
  score: number;
  reasons: string[];
  cautions: string[];
}

/**
 * Score a mask against the patient's own characteristics and stated
 * preferences, using the catalog's structured tolerance ratings rather
 * than substring matching on free-text English.
 *
 * Starts at a neutral 0.5 and moves within [0, 1], so no single factor can
 * dominate and the tier stays commensurate with the facial-fit score it is
 * blended against.
 */
export function scorePatientFactors(
  mask: CatalogMask,
  profile: FitProfile,
): PatientFactorResult {
  const reasons: string[] = [];
  const cautions: string[] = [];
  let score = 0.5;

  const bump = (delta: number, reason?: string) => {
    score += delta;
    if (reason && delta > 0) reasons.push(reason);
    if (reason && delta < 0) cautions.push(reason);
  };

  const isNasalRoute =
    mask.interfaceType === "nasal" ||
    mask.interfaceType === "nasal_pillow" ||
    mask.interfaceType === "nasal_cradle";
  const coversMouth =
    mask.interfaceType === "full_face" ||
    mask.interfaceType === "total_face" ||
    mask.interfaceType === "hybrid" ||
    mask.interfaceType === "oral";

  // Mouth breathing / dry mouth: a nasal route leaks therapy through an
  // open mouth.
  if (profile.mouthBreather === true) {
    if (coversMouth) {
      bump(
        0.18,
        "Covers your mouth as well as your nose, so pressure isn't lost if your mouth falls open at night.",
      );
    } else {
      bump(
        -0.15,
        "Nasal-only, so an open mouth at night can let therapy pressure escape. A chinstrap often helps.",
      );
    }
  }
  if (profile.dryMouth === true && isNasalRoute) {
    bump(
      -0.05,
      "Nasal-only masks can worsen dry mouth if you sometimes breathe through your mouth.",
    );
  }

  // Nasal obstruction: a nasal route depends on a patent airway.
  if (
    profile.nasalObstruction === "chronic" ||
    profile.nasalObstruction === "post_surgical" ||
    profile.frequentCongestion === true
  ) {
    if (isNasalRoute) {
      bump(
        -0.12,
        "Relies on clear nasal breathing, which congestion can interrupt.",
      );
    } else {
      bump(
        0.1,
        "Doesn't depend on clear nasal passages, which suits congestion that comes and goes.",
      );
    }
  }

  // Claustrophobia.
  if (
    profile.claustrophobia === "severe" ||
    profile.claustrophobia === "mild"
  ) {
    const weight = profile.claustrophobia === "severe" ? 0.2 : 0.1;
    if (mask.claustrophobiaTolerance === "good") {
      bump(
        weight,
        "Minimal frame with an open field of view, which most people who feel closed-in tolerate well.",
      );
    } else if (mask.claustrophobiaTolerance === "poor") {
      bump(
        -weight,
        "Covers a large area of the face, which can feel confining.",
      );
    }
  }

  // Facial hair.
  if (
    profile.facialHair === "full_beard" ||
    profile.facialHair === "moustache"
  ) {
    const weight = profile.facialHair === "full_beard" ? 0.18 : 0.08;
    if (mask.facialHairTolerance === "good") {
      bump(weight, "Seals in a place that facial hair doesn't interrupt.");
    } else if (mask.facialHairTolerance === "poor") {
      bump(
        -weight,
        "The seal runs across the beard line, where facial hair commonly causes leaks.",
      );
    }
  }

  // Sleep position.
  if (
    profile.sleepPositions.includes("side") ||
    profile.sleepPositions.includes("stomach")
  ) {
    if (mask.sideSleepingTolerance === "good") {
      bump(
        0.14,
        "Stays sealed against a pillow, which matters for side and stomach sleeping.",
      );
    } else if (mask.sideSleepingTolerance === "poor") {
      bump(
        -0.12,
        "A bulkier front-facing frame can be dislodged by a pillow when you turn.",
      );
    }
  }

  // Skin integrity — the strongest single signal in the profile, because
  // an existing pressure sore on the nasal bridge rules out an entire
  // class of mask.
  if (profile.skinIrritation === "pressure_sore") {
    if (mask.avoidsNasalBridge) {
      bump(
        0.22,
        "Seals below the nose rather than across the bridge, keeping pressure off the area where sores usually form.",
      );
    } else {
      bump(
        -0.22,
        "Rests across the bridge of the nose, which is where pressure sores usually start.",
      );
    }
  } else if (
    profile.skinIrritation === "irritation" ||
    profile.sensitiveSkin === true
  ) {
    if (mask.avoidsNasalBridge) {
      bump(
        0.08,
        "Avoids the bridge of the nose, a common spot for irritation.",
      );
    }
    if (/cloth|gel|foam/i.test(mask.cushionMaterial ?? "")) {
      bump(
        0.08,
        "Uses a softer cushion material that's kinder to easily irritated skin.",
      );
    }
  }
  if (profile.siliconeSensitivity === true) {
    if (/silicone/i.test(mask.cushionMaterial ?? "")) {
      bump(
        -0.25,
        "The cushion is silicone, which you've told us you react to.",
      );
    } else {
      bump(0.15, "Silicone-free cushion.");
    }
  }

  // Dentures / changed facial structure: without teeth to support the
  // lower face a full-face seal on the chin becomes unreliable.
  if (profile.dentures === true || profile.facialStructureChange === true) {
    if (mask.interfaceType === "full_face") {
      bump(
        -0.1,
        "Full-face masks seal along the chin, which can be harder to hold without dentures in place.",
      );
    } else if (isNasalRoute) {
      bump(
        0.08,
        "Seals around the nose only, so it doesn't depend on the shape of your lower face.",
      );
    }
  }

  // Glasses.
  if (profile.wearsGlasses === true) {
    if (mask.glassesCompatible === true) {
      bump(
        0.08,
        "Leaves your line of sight clear, so you can wear glasses to read or watch TV.",
      );
    } else if (mask.glassesCompatible === false) {
      bump(
        -0.06,
        "The frame crosses the bridge of the nose, which gets in the way of glasses.",
      );
    }
  }

  // Handling: dexterity, headgear difficulty, vision or cognition.
  if (
    profile.handDexterity === "limited" ||
    profile.handDexterity === "caregiver_assisted" ||
    profile.headgearDifficulty === true ||
    profile.visionOrCognitiveLimitation === true
  ) {
    if (mask.hasMagneticComponents) {
      bump(
        0.1,
        "Magnetic clips make it much easier to put on and take off with limited hand strength.",
      );
    }
    if (/quick|easy|magnetic|slide/i.test(mask.headgearStyle ?? "")) {
      bump(0.06, "Simple headgear that's straightforward to adjust.");
    }
    if ((mask.weightGrams ?? 0) > 140) {
      bump(-0.05, "One of the heavier masks, which can be awkward to handle.");
    }
  }

  // Stated minimal-contact preference.
  if (profile.minimalContactPreference === "minimal" && mask.minimalContact) {
    bump(
      0.12,
      "A minimal-contact design, which is what you told us you'd prefer.",
    );
  } else if (
    profile.minimalContactPreference === "traditional" &&
    !mask.minimalContact
  ) {
    bump(
      0.08,
      "A traditional cushion-and-frame design, which is what you told us you'd prefer.",
    );
  }

  // Prior experience and where the previous mask leaked.
  if (profile.priorMaskExperience !== "none") {
    const priorMatchesType =
      (profile.priorMaskExperience === "nasal" &&
        mask.interfaceType === "nasal") ||
      (profile.priorMaskExperience === "nasalPillow" &&
        mask.interfaceType === "nasal_pillow") ||
      (profile.priorMaskExperience === "fullFace" &&
        mask.interfaceType === "full_face") ||
      (profile.priorMaskExperience === "hybrid" &&
        mask.interfaceType === "hybrid");
    const satisfaction = profile.priorMaskSatisfaction;
    if (priorMatchesType && satisfaction !== null) {
      if (satisfaction >= 4) {
        bump(0.12, "The same style of mask you've got on well with before.");
      } else if (satisfaction <= 2) {
        bump(
          -0.12,
          "The same style of mask you told us didn't work well for you.",
        );
      }
    }
    if (
      profile.priorLeakLocations.includes("bridge_of_nose") &&
      mask.avoidsNasalBridge
    ) {
      bump(
        0.12,
        "Seals below the nose, away from the bridge where your last mask leaked.",
      );
    }
    if (
      (profile.priorLeakLocations.includes("cheeks") ||
        profile.priorLeakLocations.includes("chin")) &&
      isNasalRoute
    ) {
      bump(
        0.08,
        "A much smaller seal that avoids the cheek and chin area where your last mask leaked.",
      );
    }
  }

  // Soft catalog cautions that did not rise to a hard exclusion.
  const factors = profileFactors(profile);
  for (const c of mask.contraindications) {
    if (c.severity === "caution" && factors.has(c.factor)) {
      if (!cautions.includes(c.rationale)) cautions.push(c.rationale);
      score -= 0.05;
    }
  }

  return { score: Math.min(1, Math.max(0, score)), reasons, cautions };
}

// ── Tier 6: inventory and financial ──────────────────────────────────

export const SUPPLY_MULTIPLIER_BOUNDS = { min: 0.94, max: 1.06 } as const;

/**
 * Bounded supply multiplier. Deliberately the narrowest band in the
 * pipeline: stock position and margin may break a tie, and nothing more.
 * Out of stock demotes and annotates; it never excludes, because a mask
 * being off the shelf today is a logistics fact, not a clinical one.
 */
export function supplyMultiplier(a: MaskAvailability | undefined): number {
  if (!a) return 1;
  let mult: number;
  switch (a.availability) {
    case "in_stock":
      mult = 1.03;
      break;
    case "special_order":
      mult = 0.97;
      break;
    case "out":
    case "not_stocked":
      mult = SUPPLY_MULTIPLIER_BOUNDS.min;
      break;
    // "low" and "unknown" are both neutral: low stock is still stock, and
    // an unknown position must never be read as a reason to demote.
    case "low":
    default:
      mult = 1;
  }
  // Margin is a coarse 1..5 bucket and moves the score by at most 1.5%.
  if (a.marginRank !== null) {
    mult *= 1 + (a.marginRank - 3) * 0.005;
  }
  return Math.min(
    SUPPLY_MULTIPLIER_BOUNDS.max,
    Math.max(SUPPLY_MULTIPLIER_BOUNDS.min, mult),
  );
}

export const FIT_ADJUSTMENT_BOUNDS = { min: 0.85, max: 1.15 } as const;

// ── Full pipeline ────────────────────────────────────────────────────

export interface RankedResult {
  candidates: FitCandidate[];
  excluded: ExclusionRecord[];
  safetyFlags: string[];
  formularyRulesMatched: Record<string, string[]>;
  /** True when the winner sits outside every size band we have. */
  outsideValidatedRange: boolean;
}

const AVAILABILITY_NOTE: Partial<
  Record<MaskAvailability["availability"], string>
> = {
  out: "Currently out of stock at your location.",
  not_stocked: "Not normally stocked at your location.",
  special_order: "Available by special order.",
  low: "Low stock at your location.",
};

export function runTiers(input: FitEngineInput): RankedResult {
  const safety = applySafetyExclusions(
    input.catalog,
    input.profile,
    input.safetyScreen,
    input.safetyResponses,
    input.magnetScreening,
  );
  const therapy = applyTherapyCompatibility(
    safety.survivors,
    input.profile,
    input.confidenceGating,
  );

  const formularyRulesMatched: Record<string, string[]> = {};
  const candidates: FitCandidate[] = [];

  // Reverse index of the catalog's magnet-free pointers: twin slug -> the
  // magnetic model it is the manufacturer's magnet-free version of. Built
  // once here rather than looked up per candidate, and read only — a mask
  // that nothing points at simply never appears in the map.
  //
  // Validated, not copied: a pointer only lands in the map when the parent
  // is genuinely magnetic AND the twin exists AND the twin is genuinely
  // magnet-free. This field feeds PATIENT-FACING copy ("magnet-free
  // headgear clips") in rankedBelowBecause, so an unvalidated pointer
  // would turn a catalog mis-seed into a clinical safety misstatement.
  // A bad pointer must be inert, never a claim.
  const catalogBySlug = new Map(input.catalog.map((m) => [m.slug, m]));
  const magnetFreeVariantOf = new Map<string, string>();
  for (const m of input.catalog) {
    const twinSlug = m.magnetFreeVariantSlug;
    if (!twinSlug || !m.hasMagneticComponents) continue;
    const twin = catalogBySlug.get(twinSlug);
    if (twin && !twin.hasMagneticComponents) {
      magnetFreeVariantOf.set(twinSlug, m.slug);
    }
  }

  for (const mask of therapy.survivors) {
    const fit = scoreFacialFit(mask, input.measurements);
    const factors = scorePatientFactors(mask, input.profile);

    // Tier 5 operates only on candidates that already cleared tiers 1-2.
    const decision = resolveFormulary(
      input.formulary,
      mask,
      fit.cushion
        ? (mask.variants.find((v) => v.id === fit.cushion!.variantId) ?? null)
        : null,
      input.context,
    );
    formularyRulesMatched[mask.slug] = decision.matchedRuleIds;

    // Patient-facing confidence: clinical terms only. Formulary,
    // inventory, margin, and empirical adjustments are all excluded by
    // construction, so a patient can never be shown a confidence number
    // inflated by a commercial preference.
    const clinicalScore = factors.score * 0.55 + fit.score * 0.45;

    const availability = input.availability[mask.slug];
    const adjustment = Math.min(
      FIT_ADJUSTMENT_BOUNDS.max,
      Math.max(FIT_ADJUSTMENT_BOUNDS.min, input.fitAdjustments[mask.slug] ?? 1),
    );

    // Empirical outcome evidence sits ABOVE commercial preference in the
    // multiplier stack and gets the wider bound: what actually happened to
    // real patients should outrank what the DME would rather dispense.
    const rankScore =
      clinicalScore *
      adjustment *
      formularyMultiplier(decision) *
      supplyMultiplier(availability);

    const cautions = [...factors.cautions];
    if (availability && AVAILABILITY_NOTE[availability.availability]) {
      cautions.push(AVAILABILITY_NOTE[availability.availability]!);
    }

    candidates.push({
      maskSlug: mask.slug,
      maskId: mask.id,
      name: mask.modelName,
      manufacturer: mask.manufacturer,
      interfaceType: mask.interfaceType,
      imageUrl: mask.imageUrl,
      confidence: Math.min(1, Math.max(0, clinicalScore)),
      rankScore,
      facialFitScore: fit.score,
      patientFactorScore: factors.score,
      cushion: fit.cushion,
      frame:
        fit.frame && fit.frame.measurementsUsed.length > 0 ? fit.frame : null,
      reasons: factors.reasons,
      cautions,
      outsideFormulary: !decision.allowed,
      outsideFormularyReason: decision.allowed
        ? null
        : decision.denyReasonCode === "not_in_closed_formulary"
          ? "Not on your provider's formulary."
          : `Excluded by your provider's formulary${decision.denyReasonCode ? ` (${decision.denyReasonCode})` : ""}.`,
      availability: availability?.availability ?? null,
      magnetFreeVariantOf: magnetFreeVariantOf.get(mask.slug) ?? null,
      rankedBelowBecause: null,
    });
  }

  // In-formulary candidates rank ahead of out-of-formulary ones, but the
  // out-of-formulary ones are KEPT: when the clinical tiers leave nothing
  // else, the best of them still surfaces, flagged, for a clinician.
  candidates.sort((a, b) => {
    if (a.outsideFormulary !== b.outsideFormulary) {
      return a.outsideFormulary ? 1 : -1;
    }
    return b.rankScore - a.rankScore;
  });

  const outsideValidatedRange =
    candidates.length > 0 &&
    candidates.every((c) => (c.cushion?.bandMargin ?? 0) === 0);

  return {
    candidates,
    excluded: [...safety.excluded, ...therapy.excluded],
    safetyFlags: safety.flags,
    formularyRulesMatched,
    outsideValidatedRange,
  };
}

/** Re-exported for the tests and the report's provenance block. */
export { profileFactors };

export type { CatalogMask, FitContext, Formulary, SafetyScreen };
