/**
 * Shared types for the clinical fitting engine.
 *
 * PURITY CONTRACT
 * ---------------
 * Everything under `src/lib/fitting/` is pure: no database, no logger, no
 * `process`, no network. The catalog, the formulary decisions, and the
 * patient's answers all arrive as arguments. That keeps the whole clinical
 * pipeline unit-testable without a database and keeps PHI handling at the
 * route boundary where it belongs.
 *
 * The one impure companion is `catalog-store.ts`, which loads a tenant's
 * catalog + formulary and is deliberately the only file here that touches
 * Supabase. It is imported by routes, never by the tier modules.
 *
 * NO IMAGES. This module accepts numeric measurements and enum answers.
 * It never sees, and must never be given, image bytes.
 */

/** Millimetre measurements derived on the patient's device. */
export interface FitMeasurements {
  noseWidth: number;
  noseHeight: number;
  noseToChin: number;
  mouthWidth: number;
  faceWidthAtCheekbones: number;
}

export type InterfaceType =
  | "nasal"
  | "nasal_pillow"
  | "nasal_cradle"
  | "hybrid"
  | "full_face"
  | "total_face"
  | "oral";

export type Population = "adult" | "pediatric";
export type TherapyMode = "pap" | "niv";
export type Tolerance = "poor" | "fair" | "good";
export type FitDataSource = "manufacturer" | "measured" | "estimated";

/**
 * The clinical factors a mask can be contraindicated for. `exclude` is a
 * hard filter applied in tier 1; `caution` is a tier-4 penalty plus a
 * caveat printed on the fit report.
 */
export type ContraindicationFactor =
  | "mouth_breathing"
  | "nasal_obstruction"
  | "claustrophobia"
  | "facial_hair"
  | "dentures"
  | "skin_breakdown"
  | "high_pressure"
  | "supplemental_oxygen"
  | "magnet_implant_patient"
  | "magnet_implant_household"
  | "niv_vented_mismatch"
  | "hand_dexterity"
  | "side_sleeping"
  | "vision_cognitive"
  | "pediatric_service_line";

export interface MaskContraindication {
  factor: ContraindicationFactor;
  severity: "exclude" | "caution";
  rationale: string;
}

/**
 * One orderable size of one component. A NULL band means the dimension
 * does not gate this size — the engine skips it rather than treating the
 * absence as a failed match.
 */
export interface SizeVariant {
  id: string;
  component: "cushion" | "frame" | "pillow" | "headgear" | "full_assembly";
  sizeCode: string;
  sizeLabel: string;
  sortOrder: number;
  noseWidthMin: number | null;
  noseWidthMax: number | null;
  noseHeightMin: number | null;
  noseHeightMax: number | null;
  noseToChinMin: number | null;
  noseToChinMax: number | null;
  mouthWidthMin: number | null;
  mouthWidthMax: number | null;
  faceWidthMin: number | null;
  faceWidthMax: number | null;
  isDefault: boolean;
  hcpcsCode: string | null;
  /** Manufacturer part number for THIS size — what actually gets ordered. */
  manufacturerPartNumber: string | null;
  status: "current" | "discontinued";
  fitDataSource: FitDataSource;
  needsClinicalReview: boolean;
}

/** A mask model plus everything the engine needs to reason about it. */
export interface CatalogMask {
  id: string;
  slug: string;
  manufacturer: string;
  modelName: string;
  productLine: string | null;
  interfaceType: InterfaceType;
  serviceLine: "adult" | "pediatric" | "both";
  therapyModes: TherapyMode[];
  vented: "vented" | "non_vented" | "both";
  hasMagneticComponents: boolean;
  magnetFreeVariantSlug: string | null;
  pressureMin: number | null;
  pressureMax: number | null;
  supportsSupplementalOxygen: boolean | null;
  minimalContact: boolean;
  avoidsNasalBridge: boolean;
  hosePosition: "front" | "top" | "side" | null;
  facialHairTolerance: Tolerance | null;
  sideSleepingTolerance: Tolerance | null;
  claustrophobiaTolerance: Tolerance | null;
  glassesCompatible: boolean | null;
  cushionMaterial: string | null;
  headgearStyle: string | null;
  weightGrams: number | null;
  description: string | null;
  imageUrl: string | null;
  status: "current" | "discontinued" | "pre_release";
  fitDataSource: FitDataSource;
  needsClinicalReview: boolean;
  catalogVersion: number;
  variants: SizeVariant[];
  contraindications: MaskContraindication[];
}

// ── Patient Fit Profile ──────────────────────────────────────────────

export type SleepPosition = "back" | "side" | "stomach" | "mixed";
export type LeakLocation =
  | "bridge_of_nose"
  | "cheeks"
  | "sides"
  | "mouth"
  | "chin";

/**
 * The structured assessment. Every field is optional or explicitly
 * nullable: `null` means "the patient declined or wasn't sure", and every
 * branch must compare against a concrete value rather than truthiness so a
 * null can never be read as a "no".
 */
export interface FitProfile {
  version: string;
  population: Population;
  therapyMode: TherapyMode;
  therapyDevice: "cpap" | "apap" | "bilevel" | "asv" | "unknown";
  /** Exact prescribed pressure in cmH2O when the patient knows it. */
  pressureCmH2O: number | null;
  /** Coarse band, kept for back-compatibility with the original 11 answers. */
  pressureBand: "unknown" | "low" | "medium" | "high";
  supplementalOxygen: boolean | null;

  mouthBreather: boolean | null;
  nasalObstruction: "none" | "seasonal" | "chronic" | "post_surgical" | null;
  frequentCongestion: boolean | null;
  dryMouth: boolean | null;

  sleepPositions: SleepPosition[];
  claustrophobia: "none" | "mild" | "severe" | null;
  minimalContactPreference: "minimal" | "traditional" | "no_preference" | null;

  facialHair: "none" | "stubble" | "moustache" | "full_beard" | null;
  dentures: boolean | null;
  facialStructureChange: boolean | null;
  skinIrritation: "none" | "irritation" | "pressure_sore" | null;
  sensitiveSkin: boolean | null;
  siliconeSensitivity: boolean | null;
  wearsGlasses: boolean | null;

  priorMaskExperience: "none" | "nasal" | "nasalPillow" | "fullFace" | "hybrid";
  priorMaskModelSlug: string | null;
  priorMaskSize: string | null;
  priorLeakLocations: LeakLocation[];
  /** 1 (hated it) .. 5 (loved it). Null when there was no prior mask. */
  priorMaskSatisfaction: number | null;
  headgearDifficulty: boolean | null;
  handDexterity: "normal" | "limited" | "caregiver_assisted" | null;
  visionOrCognitiveLimitation: boolean | null;
}

// ── Safety screening ─────────────────────────────────────────────────

export interface SafetyQuestion {
  questionKey: string;
  prompt: string;
  helpText: string | null;
  subject: "patient" | "household";
  sortOrder: number;
  riskFlag: string;
  /** The CatalogMask boolean a positive answer disqualifies on. */
  disqualifiesAttribute: "has_magnetic_components" | null;
  severity: "exclude" | "warn";
  unsureBehavesAs: "exclude" | "warn" | "ignore";
}

export interface SafetyScreen {
  slug: string;
  version: string;
  title: string;
  introCopy: string | null;
  attestationCopy: string;
  questions: SafetyQuestion[];
}

export interface SafetyResponse {
  questionKey: string;
  answer: "yes" | "no" | "unsure";
}

// ── Scan quality ─────────────────────────────────────────────────────

export interface ScanSignals {
  frameCount: number;
  /** 0..1 per check. Absent keys are treated as unknown, not as a pass. */
  quality: Partial<
    Record<
      "lighting" | "distance" | "pose" | "occlusion" | "motion" | "framing",
      number
    >
  >;
  /** 0..1 cross-frame agreement per measurement. */
  agreement: Partial<Record<keyof FitMeasurements, number>>;
  measurementConfidence: number;
  band: "high" | "moderate" | "low";
}

// ── Formulary ────────────────────────────────────────────────────────

export interface FitContext {
  locationId: string | null;
  payerProfileId: string | null;
  contractRef: string | null;
  population: Population;
  therapyMode: TherapyMode;
  /** ISO date the rules are evaluated against. Injected, never `new Date()`. */
  asOf: string;
}

export interface FormularyRule {
  id: string;
  locationId: string | null;
  payerProfileId: string | null;
  contractRef: string | null;
  serviceLine: Population | null;
  therapyMode: TherapyMode | null;
  targetKind:
    | "manufacturer"
    | "interface_type"
    | "mask_model"
    | "size_variant"
    | "all";
  targetManufacturer: string | null;
  targetInterfaceType: string | null;
  targetMaskModelId: string | null;
  targetSizeVariantId: string | null;
  effect: "allow" | "deny" | "prefer" | "deprioritize";
  preferenceRank: number | null;
  reasonCode: string | null;
  /** Internal note. STAFF-ONLY — redacted from every patient-facing surface. */
  reasonNote: string | null;
  effectiveFrom: string | null;
  effectiveTo: string | null;
  createdAt: string;
}

export interface Formulary {
  id: string | null;
  name: string;
  version: number;
  defaultPosture: "open" | "closed";
  rules: FormularyRule[];
}

export interface FormularyDecision {
  allowed: boolean;
  /** True when a rule denied it — as opposed to a `closed` default. */
  deniedByRule: boolean;
  denyReasonCode: string | null;
  denyReasonNote: string | null;
  preferenceRank: number | null;
  deprioritized: boolean;
  matchedRuleIds: string[];
}

// ── Availability ─────────────────────────────────────────────────────

export interface MaskAvailability {
  availability:
    | "in_stock"
    | "low"
    | "out"
    | "special_order"
    | "not_stocked"
    | "unknown";
  marginRank: number | null;
}

// ── Engine output ────────────────────────────────────────────────────

/** Which tier removed a candidate, and why — the defensibility record. */
export interface ExclusionRecord {
  maskSlug: string;
  maskName: string;
  tier: 1 | 2;
  code: string;
  /** Plain language, safe to show a patient. */
  patientReason: string;
  /** Fuller detail for the clinician and the fit report. */
  clinicianReason: string;
  /**
   * The same model's magnet-free SKU, when the manufacturer ships one AND
   * it survived every other filter. Only ever set on a magnet exclusion:
   * naming a swap we did not actually offer is worse than saying nothing.
   *
   * Optional, not required — `fit_sessions.excluded` is jsonb and rows
   * written before this existed carry neither key. Read them as `?? null`.
   */
  magnetFreeAlternativeSlug?: string | null;
  magnetFreeAlternativeName?: string | null;
}

export interface SizeChoice {
  variantId: string;
  component: SizeVariant["component"];
  sizeCode: string;
  sizeLabel: string;
  /**
   * Manufacturer part number for this exact size. Carried through to the
   * order so the recommended SIZE reaches fulfilment — the previous flow
   * ranked a mask, then dropped which size it had chosen.
   */
  manufacturerPartNumber: string | null;
  /** How far inside its band the measurement sits, 0..1. */
  bandMargin: number;
  fitDataSource: FitDataSource;
  needsClinicalReview: boolean;
  /** Which measurements actually gated this size. */
  measurementsUsed: Array<keyof FitMeasurements>;
  rationale: string;
}

export interface FitCandidate {
  maskSlug: string;
  maskId: string;
  name: string;
  manufacturer: string;
  interfaceType: InterfaceType;
  imageUrl: string | null;
  /** Patient-facing confidence. Commercial signals never touch this. */
  confidence: number;
  /** Internal ordering score. Commercial signals DO touch this. */
  rankScore: number;
  facialFitScore: number;
  patientFactorScore: number;
  cushion: SizeChoice | null;
  frame: SizeChoice | null;
  reasons: string[];
  cautions: string[];
  /** Set when the formulary demoted it but clinical tiers kept it alive. */
  outsideFormulary: boolean;
  outsideFormularyReason: string | null;
  availability: MaskAvailability["availability"] | null;
  /** Why this ranked below the primary. Empty on the primary itself. */
  rankedBelowBecause: string | null;
  /**
   * Slug of the magnetic model this SKU is the manufacturer's magnet-free
   * version of. Lets the results page label it as the same mask rather
   * than an unrelated third option. Optional for the same jsonb-back-compat
   * reason as `ExclusionRecord` above.
   */
  magnetFreeVariantOf?: string | null;
}

export type FitOutcome =
  | "high_confidence"
  | "moderate_confidence"
  | "low_confidence"
  | "contraindicated"
  | "outside_validated_range";

export interface FitAssessment {
  outcome: FitOutcome;
  /** Null for `contraindicated` / `low_confidence` / out-of-range. */
  primary: FitCandidate | null;
  alternatives: FitCandidate[];
  excluded: ExclusionRecord[];
  recommendationConfidence: number;
  safetyFlags: string[];
  guidance: string;
  disclaimer: string;
  provenance: {
    rulesEngineVersion: string;
    formularyId: string | null;
    formularyName: string;
    formularyVersion: number;
    catalogSnapshotVersion: number;
    formularyRulesMatched: Record<string, string[]>;
    degraded: boolean;
  };
}

export interface FitEngineInput {
  measurements: FitMeasurements;
  profile: FitProfile;
  scan: ScanSignals;
  catalog: CatalogMask[];
  formulary: Formulary;
  context: FitContext;
  safetyScreen: SafetyScreen | null;
  safetyResponses: SafetyResponse[];
  /** Per-mask availability, keyed by mask slug. */
  availability: Record<string, MaskAvailability>;
  /**
   * Empirical outcome multipliers from `computeFitAdjustments()`, keyed by
   * mask slug. Bounded [0.85, 1.15]; a missing key is neutral.
   */
  fitAdjustments: Record<string, number>;
  /** True when the tenant catalog could not be loaded and we fell back. */
  degraded: boolean;
  /** True when confidence gating + strict pressure filtering are enabled. */
  confidenceGating: boolean;
  /** True when the magnetic safety screen is enabled. */
  magnetScreening: boolean;
}
