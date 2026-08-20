// Demo fixtures for the tenant admin FITTING surfaces:
//
//   /admin/mask-catalog     GET/PATCH /admin/fitter/catalog*
//   /admin/formulary        GET/PATCH/POST/DELETE /admin/fitter/formulary*
//   /admin/fit-sessions     GET/POST /admin/fit-sessions*
//   /admin/safety-screens   GET/POST/PUT/PATCH/DELETE /admin/fitter/safety-screens*
//
// These four pages previously had NO demo coverage at all — every request
// fell through to the router's empty fallback, so each rendered its empty
// state and none of its actions could be exercised. Shapes mirror
// `src/lib/admin/fitting-api.ts`, which is what the pages actually parse.
//
// Writes go through the session-scoped store below, so the demo is
// interactive: sign off a size band and the "needs review" count drops;
// add a formulary rule and the simulator's verdict changes; approve a fit
// session and it leaves the review queue.
//
// Clinical-review posture (matches the real rule): `needsClinicalReview`
// records PROVENANCE — whether this tenant has signed the platform's
// measurement band off — and does NOT gate recommendation confidence.
// Only a per-tenant sign-off clears it, which is exactly what the
// review/review-batch handlers below do; nothing else in these fixtures
// touches the flag.

import { daysAgo, hoursAgo, NOW_ISO } from "./dates";

const DEMO_REVIEWER = "demo.admin@caremetric.example";

// ── Types (mirrors of `src/lib/admin/fitting-api.ts`) ───────────────

type InterfaceType =
  | "nasal"
  | "nasal_pillow"
  | "nasal_cradle"
  | "hybrid"
  | "full_face"
  | "total_face"
  | "oral";

interface DemoMaskModel {
  id: string;
  isPlatformRow: boolean;
  slug: string;
  manufacturer: string;
  modelName: string;
  productLine: string | null;
  interfaceType: InterfaceType;
  serviceLine: "adult" | "pediatric" | "both";
  therapyModes: string[];
  vented: "vented" | "non_vented" | "both";
  hasMagneticComponents: boolean;
  magneticComponentNotes: string | null;
  pressureMinCmH2O: number | null;
  pressureMaxCmH2O: number | null;
  minimalContact: boolean;
  avoidsNasalBridge: boolean;
  facialHairTolerance: string | null;
  sideSleepingTolerance: string | null;
  claustrophobiaTolerance: string | null;
  glassesCompatible: boolean | null;
  cushionMaterial: string | null;
  weightGrams: number | null;
  description: string | null;
  status: "current" | "discontinued" | "pre_release";
  fitDataSource: "manufacturer" | "measured" | "estimated";
  needsClinicalReview: boolean;
  catalogVersion: number;
  magnetFreeVariantSlug: string | null;
  fittingInstructionsUrl: string | null;
  fittingInstructionsVersion: string | null;
}

type ReviewSourceKind =
  | "manufacturer_fit_guide"
  | "manufacturer_spec_sheet"
  | "physical_measurement"
  | "clinical_judgment";

interface DemoVariant {
  id: string;
  modelId: string;
  component: string;
  sizeCode: string;
  sizeLabel: string;
  sortOrder: number;
  noseWidthMinMm: number | null;
  noseWidthMaxMm: number | null;
  noseHeightMinMm: number | null;
  noseHeightMaxMm: number | null;
  noseToChinMinMm: number | null;
  noseToChinMaxMm: number | null;
  mouthWidthMinMm: number | null;
  mouthWidthMaxMm: number | null;
  isDefault: boolean;
  hcpcsCode: string | null;
  manufacturerPartNumber: string | null;
  fitDataSource: string;
  fitDataSourceRef: string | null;
  fitDataSourceDate: string | null;
  needsClinicalReview: boolean;
  reviewedByEmail: string | null;
  reviewedAt: string | null;
  reviewSourceKind: ReviewSourceKind | null;
  reviewSourceRef: string | null;
}

interface DemoFormularyRule {
  id: string;
  locationId: string | null;
  payerProfileId: string | null;
  contractRef: string | null;
  serviceLine: "adult" | "pediatric" | null;
  therapyMode: "pap" | "niv" | null;
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
  reasonNote: string | null;
  effectiveFrom: string | null;
  effectiveTo: string | null;
  createdByEmail: string | null;
  createdAt: string;
}

interface DemoFormulary {
  id: string;
  name: string;
  status: string;
  defaultPosture: "open" | "closed";
  version: number;
  publishedAt: string | null;
  publishedByEmail: string | null;
  notes: string | null;
}

type FitOutcome =
  | "high_confidence"
  | "moderate_confidence"
  | "low_confidence"
  | "contraindicated"
  | "outside_validated_range";

interface DemoFitSession {
  id: string;
  createdAt: string;
  patientId: string | null;
  status: string;
  outcome: FitOutcome | null;
  recommendationConfidence: number | null;
  measurementConfidenceBand: "high" | "moderate" | "low" | null;
  scanQualityGrade: "good" | "marginal" | "poor" | null;
  reviewStatus: string;
  reviewedByEmail: string | null;
  reviewedAt: string | null;
  population: string;
  serviceLine: string;
  degraded: boolean;
  recommendedMask: string | null;
  supersededBySessionId: string | null;
  /** Demo-only: measurements the detail drawer renders. */
  measurements: Record<string, number>;
}

interface DemoScreenQuestion {
  id: string;
  questionKey: string;
  prompt: string;
  helpText: string | null;
  subject: "patient" | "household";
  sortOrder: number;
  riskFlag: string;
  disqualifiesAttribute: "has_magnetic_components" | null;
  severity: "exclude" | "warn";
  unsureBehavesAs: "exclude" | "warn" | "ignore";
}

interface DemoScreenVersion {
  id: string;
  isPlatform: boolean;
  slug: string;
  version: string;
  scope: string;
  manufacturer: string | null;
  status: "draft" | "active" | "retired";
  title: string;
  introCopy: string | null;
  attestationCopy: string;
  sourceUrl: string | null;
  sourceVersionDate: string | null;
  effectiveFrom: string | null;
  retiredOn: string | null;
  updatedAt: string | null;
  questions: DemoScreenQuestion[];
}

// ── Mask catalog seed ───────────────────────────────────────────────

function model(
  n: number,
  slug: string,
  manufacturer: string,
  modelName: string,
  interfaceType: InterfaceType,
  opts: Partial<DemoMaskModel> = {},
): DemoMaskModel {
  return {
    id: `demo-mask-${n}`,
    isPlatformRow: true,
    slug,
    manufacturer,
    modelName,
    productLine: null,
    interfaceType,
    serviceLine: "adult",
    therapyModes: ["pap"],
    vented: "vented",
    hasMagneticComponents: false,
    magneticComponentNotes: null,
    pressureMinCmH2O: 4,
    pressureMaxCmH2O: 20,
    minimalContact: interfaceType === "nasal_pillow",
    avoidsNasalBridge:
      interfaceType === "nasal_pillow" || interfaceType === "nasal_cradle",
    facialHairTolerance: interfaceType === "nasal_pillow" ? "good" : "fair",
    sideSleepingTolerance: "good",
    claustrophobiaTolerance: interfaceType === "full_face" ? "fair" : "good",
    glassesCompatible: interfaceType !== "full_face",
    cushionMaterial: "silicone",
    weightGrams: 78,
    description: null,
    status: "current",
    fitDataSource: "manufacturer",
    needsClinicalReview: false,
    catalogVersion: 12,
    magnetFreeVariantSlug: null,
    fittingInstructionsUrl: null,
    fittingInstructionsVersion: null,
    ...opts,
  };
}

function seedModels(): DemoMaskModel[] {
  return [
    model(1, "airfit-n30i", "ResMed", "AirFit N30i", "nasal_cradle", {
      productLine: "AirFit",
      weightGrams: 66,
      description:
        "Top-of-head tube nasal cradle. Popular with side and stomach sleepers.",
      fittingInstructionsUrl: "https://example.com/fitting/n30i.pdf",
      fittingInstructionsVersion: "2025-08",
    }),
    model(2, "airfit-p10", "ResMed", "AirFit P10", "nasal_pillow", {
      productLine: "AirFit",
      weightGrams: 51,
      description: "Ultra-light nasal pillow. Quietest in the range.",
    }),
    model(3, "airfit-f20", "ResMed", "AirFit F20", "full_face", {
      productLine: "AirFit",
      weightGrams: 112,
      hasMagneticComponents: true,
      magneticComponentNotes:
        "Magnetic headgear clips. Contraindicated with implanted metallic or electronic devices.",
      magnetFreeVariantSlug: "airfit-f20-magnet-free",
      claustrophobiaTolerance: "poor",
    }),
    model(
      4,
      "dreamwear-nasal",
      "Philips Respironics",
      "DreamWear Nasal",
      "nasal",
      {
        productLine: "DreamWear",
        weightGrams: 74,
        description: "Under-the-nose cushion with hollow frame airflow.",
        needsClinicalReview: true,
        fitDataSource: "estimated",
      },
    ),
    model(5, "dreamwisp", "Philips Respironics", "DreamWisp", "nasal", {
      productLine: "DreamWisp",
      weightGrams: 82,
    }),
    model(
      6,
      "evora-full-face",
      "Fisher & Paykel",
      "Evora Full Face",
      "full_face",
      {
        weightGrams: 104,
        claustrophobiaTolerance: "fair",
      },
    ),
    model(7, "brevida", "Fisher & Paykel", "Brevida", "nasal_pillow", {
      weightGrams: 58,
      facialHairTolerance: "good",
    }),
    model(8, "vitera", "Fisher & Paykel", "Vitera", "full_face", {
      weightGrams: 118,
      status: "discontinued",
    }),
    model(9, "resmed-airfit-f30i", "ResMed", "AirFit F30i", "full_face", {
      productLine: "AirFit",
      weightGrams: 108,
      needsClinicalReview: true,
      fitDataSource: "estimated",
    }),
    model(10, "3b-lumin-nasal", "3B Medical", "Lumin Nasal", "nasal", {
      weightGrams: 88,
      status: "pre_release",
      serviceLine: "both",
    }),
  ];
}

function variantsFor(m: DemoMaskModel): DemoVariant[] {
  // Nose-width bands widen by size; the full-face models also carry a
  // nose-to-chin band, which is what actually drives their sizing.
  const sizes: Array<[string, string, number, number]> =
    m.interfaceType === "nasal_pillow"
      ? [
          ["XS", "Extra small", 10, 13],
          ["S", "Small", 13, 16],
          ["M", "Medium", 16, 19],
          ["L", "Large", 19, 23],
        ]
      : [
          ["S", "Small", 24, 30],
          ["M", "Medium", 30, 36],
          ["W", "Wide", 36, 43],
        ];
  const fullFace =
    m.interfaceType === "full_face" || m.interfaceType === "total_face";
  return sizes.map(([code, label, min, max], i) => ({
    id: `${m.id}-v${i + 1}`,
    modelId: m.id,
    component: "cushion",
    sizeCode: code,
    sizeLabel: label,
    sortOrder: i,
    noseWidthMinMm: min,
    noseWidthMaxMm: max,
    noseHeightMinMm: fullFace ? null : Math.round(min * 1.4),
    noseHeightMaxMm: fullFace ? null : Math.round(max * 1.4),
    noseToChinMinMm: fullFace ? 58 + i * 8 : null,
    noseToChinMaxMm: fullFace ? 66 + i * 8 : null,
    mouthWidthMinMm: fullFace ? 38 + i * 4 : null,
    mouthWidthMaxMm: fullFace ? 46 + i * 4 : null,
    isDefault: code === "M",
    hcpcsCode: "A7034",
    manufacturerPartNumber: `${m.slug.toUpperCase().replace(/-/g, "")}-${code}`,
    fitDataSource: m.fitDataSource,
    fitDataSourceRef:
      m.fitDataSource === "manufacturer"
        ? `${m.manufacturer} fitting guide rev. 2025-08`
        : null,
    fitDataSourceDate: m.fitDataSource === "manufacturer" ? daysAgo(220) : null,
    // Estimated bands start unsigned — that's the review queue the page exists
    // to work through.
    needsClinicalReview: m.fitDataSource === "estimated",
    reviewedByEmail: m.fitDataSource === "estimated" ? null : DEMO_REVIEWER,
    reviewedAt: m.fitDataSource === "estimated" ? null : daysAgo(60),
    reviewSourceKind:
      m.fitDataSource === "estimated" ? null : "manufacturer_fit_guide",
    reviewSourceRef:
      m.fitDataSource === "estimated"
        ? null
        : `${m.manufacturer} fitting guide rev. 2025-08`,
  }));
}

// ── Fit sessions seed ───────────────────────────────────────────────

function seedFitSessions(models: DemoMaskModel[]): DemoFitSession[] {
  const spec: Array<{
    outcome: FitOutcome;
    reviewStatus: string;
    confidence: number;
    band: "high" | "moderate" | "low";
    quality: "good" | "marginal" | "poor";
    maskIdx: number;
    degraded?: boolean;
  }> = [
    {
      outcome: "high_confidence",
      reviewStatus: "not_required",
      confidence: 0.94,
      band: "high",
      quality: "good",
      maskIdx: 0,
    },
    {
      outcome: "high_confidence",
      reviewStatus: "not_required",
      confidence: 0.91,
      band: "high",
      quality: "good",
      maskIdx: 1,
    },
    {
      outcome: "moderate_confidence",
      reviewStatus: "pending_review",
      confidence: 0.72,
      band: "moderate",
      quality: "marginal",
      maskIdx: 3,
    },
    {
      outcome: "low_confidence",
      reviewStatus: "pending_review",
      confidence: 0.48,
      band: "low",
      quality: "marginal",
      maskIdx: 4,
      degraded: true,
    },
    {
      outcome: "contraindicated",
      reviewStatus: "pending_review",
      confidence: 0.66,
      band: "moderate",
      quality: "good",
      maskIdx: 2,
    },
    {
      outcome: "outside_validated_range",
      reviewStatus: "pending_review",
      confidence: 0.39,
      band: "low",
      quality: "poor",
      maskIdx: 8,
      degraded: true,
    },
    {
      outcome: "high_confidence",
      reviewStatus: "approved",
      confidence: 0.88,
      band: "high",
      quality: "good",
      maskIdx: 6,
    },
    {
      outcome: "moderate_confidence",
      reviewStatus: "approved",
      confidence: 0.79,
      band: "moderate",
      quality: "good",
      maskIdx: 5,
    },
  ];
  return spec.map((s, i) => {
    const m = models[s.maskIdx];
    return {
      id: `demo-fit-${i + 1}`,
      createdAt: hoursAgo(4 + i * 9),
      patientId: `demo-patient-${(i % 4) + 1}`,
      status: "complete",
      outcome: s.outcome,
      recommendationConfidence: s.confidence,
      measurementConfidenceBand: s.band,
      scanQualityGrade: s.quality,
      reviewStatus: s.reviewStatus,
      reviewedByEmail: s.reviewStatus === "approved" ? DEMO_REVIEWER : null,
      reviewedAt: s.reviewStatus === "approved" ? hoursAgo(2 + i * 6) : null,
      population: "adult",
      serviceLine: "adult",
      degraded: s.degraded ?? false,
      recommendedMask: `${m.manufacturer} ${m.modelName}`,
      supersededBySessionId: null,
      measurements: {
        noseWidthMm: 30 + (i % 5) * 2,
        noseHeightMm: 44 + (i % 4) * 3,
        noseToChinMm: 62 + (i % 6) * 2,
        mouthWidthMm: 42 + (i % 3) * 3,
      },
    };
  });
}

// ── Safety screens seed ─────────────────────────────────────────────

function screenQuestions(prefix: string): DemoScreenQuestion[] {
  const rows: Array<
    [
      string,
      string,
      string | null,
      "patient" | "household",
      string,
      "exclude" | "warn",
    ]
  > = [
    [
      "implanted_device",
      "Do you have an implanted medical device — a pacemaker, defibrillator, neurostimulator, insulin pump, or cochlear implant?",
      "Magnetic mask components can interfere with implanted devices.",
      "patient",
      "magnetic_interference",
      "exclude",
    ],
    [
      "metallic_implant",
      "Do you have any metallic implants, clips, or shunts in your head or neck?",
      "Includes aneurysm clips and metallic stents.",
      "patient",
      "magnetic_interference",
      "exclude",
    ],
    [
      "household_device",
      "Does anyone who shares your bed or bedroom have an implanted medical device?",
      "Magnetic clips can affect a bed partner at close range.",
      "household",
      "magnetic_interference",
      "exclude",
    ],
    [
      "recent_facial_surgery",
      "Have you had facial or nasal surgery in the last 90 days?",
      null,
      "patient",
      "skin_integrity",
      "warn",
    ],
    [
      "skin_breakdown",
      "Do you currently have sores, rashes, or broken skin where a mask would sit?",
      null,
      "patient",
      "skin_integrity",
      "warn",
    ],
    [
      "claustrophobia",
      "Do you feel anxious or panicky with something covering your face?",
      "This steers the recommendation toward a minimal-contact interface.",
      "patient",
      "tolerance",
      "warn",
    ],
  ];
  return rows.map(([key, prompt, help, subject, risk, severity], i) => ({
    id: `${prefix}-q${i + 1}`,
    questionKey: key,
    prompt,
    helpText: help,
    subject,
    sortOrder: i,
    riskFlag: risk,
    disqualifiesAttribute:
      risk === "magnetic_interference" ? "has_magnetic_components" : null,
    severity,
    unsureBehavesAs: severity === "exclude" ? "exclude" : "warn",
  }));
}

function seedScreens(): DemoScreenVersion[] {
  return [
    {
      id: "demo-screen-platform",
      isPlatform: true,
      slug: "platform-magnet-safety",
      version: "2026.1",
      scope: "all_masks",
      manufacturer: null,
      status: "active",
      title: "Magnet & skin safety screen",
      introCopy:
        "A few quick safety questions before we recommend a mask. Answer for yourself and anyone who shares your bedroom.",
      attestationCopy:
        "I confirm these answers are accurate to the best of my knowledge.",
      sourceUrl: "https://example.com/safety/magnet-guidance",
      sourceVersionDate: daysAgo(120),
      effectiveFrom: daysAgo(120),
      retiredOn: null,
      updatedAt: daysAgo(120),
      questions: screenQuestions("demo-screen-platform"),
    },
    {
      id: "demo-screen-draft",
      isPlatform: false,
      slug: "tenant-safety-draft",
      version: "draft-2",
      scope: "all_masks",
      manufacturer: null,
      status: "draft",
      title: "Our safety screen (draft)",
      introCopy:
        "Cloned from the platform screen — adds our own skin-check wording.",
      attestationCopy:
        "I confirm these answers are accurate to the best of my knowledge.",
      sourceUrl: null,
      sourceVersionDate: null,
      effectiveFrom: null,
      retiredOn: null,
      updatedAt: daysAgo(3),
      questions: screenQuestions("demo-screen-draft"),
    },
  ];
}

// ── Session-scoped mutable store ────────────────────────────────────

interface FittingState {
  models: DemoMaskModel[];
  variants: DemoVariant[];
  formulary: DemoFormulary;
  rules: DemoFormularyRule[];
  sessions: DemoFitSession[];
  screens: DemoScreenVersion[];
  activeScreenId: string | null;
}

let state: FittingState | null = null;

function seed(): FittingState {
  const models = seedModels();
  return {
    models,
    variants: models.flatMap(variantsFor),
    formulary: {
      id: "demo-formulary-1",
      name: "Standard adult PAP formulary",
      status: "published",
      defaultPosture: "open",
      version: 4,
      publishedAt: daysAgo(16),
      publishedByEmail: DEMO_REVIEWER,
      notes:
        "Open posture: everything in the catalog is allowed unless a rule denies it.",
    },
    rules: [
      {
        id: "demo-rule-1",
        locationId: null,
        payerProfileId: null,
        contractRef: null,
        serviceLine: "adult",
        therapyMode: "pap",
        targetKind: "manufacturer",
        targetManufacturer: "ResMed",
        targetInterfaceType: null,
        targetMaskModelId: null,
        targetSizeVariantId: null,
        effect: "prefer",
        preferenceRank: 1,
        reasonCode: "contract_pricing",
        reasonNote: "Best net cost under the current purchasing agreement.",
        effectiveFrom: daysAgo(120),
        effectiveTo: null,
        createdByEmail: DEMO_REVIEWER,
        createdAt: daysAgo(120),
      },
      {
        id: "demo-rule-2",
        locationId: null,
        payerProfileId: null,
        contractRef: null,
        serviceLine: null,
        therapyMode: null,
        targetKind: "mask_model",
        targetManufacturer: null,
        targetInterfaceType: null,
        targetMaskModelId: "demo-mask-8",
        targetSizeVariantId: null,
        effect: "deny",
        preferenceRank: null,
        reasonCode: "discontinued",
        reasonNote: "Discontinued by the manufacturer; no resupply path.",
        effectiveFrom: daysAgo(45),
        effectiveTo: null,
        createdByEmail: DEMO_REVIEWER,
        createdAt: daysAgo(45),
      },
      {
        id: "demo-rule-3",
        locationId: null,
        payerProfileId: null,
        contractRef: null,
        serviceLine: "pediatric",
        therapyMode: null,
        targetKind: "interface_type",
        targetManufacturer: null,
        targetInterfaceType: "full_face",
        targetMaskModelId: null,
        targetSizeVariantId: null,
        effect: "deny",
        preferenceRank: null,
        reasonCode: "clinical_policy",
        reasonNote: "Pediatric fits are nasal-first by policy.",
        effectiveFrom: daysAgo(200),
        effectiveTo: null,
        createdByEmail: DEMO_REVIEWER,
        createdAt: daysAgo(200),
      },
    ],
    sessions: seedFitSessions(models),
    screens: seedScreens(),
    activeScreenId: "demo-screen-platform",
  };
}

function get(): FittingState {
  if (!state) state = seed();
  return state;
}

function newId(prefix: string): string {
  return `${prefix}-${crypto.randomUUID().replace(/-/g, "").slice(0, 8)}`;
}

// ── Mask catalog ────────────────────────────────────────────────────

/** GET /admin/fitter/catalog */
export function demoMaskCatalog(query: URLSearchParams) {
  const s = get();
  const manufacturer = query.get("manufacturer");
  const interfaceType = query.get("interfaceType");
  const serviceLine = query.get("serviceLine");
  const status = query.get("status");
  const needsReview = query.get("needsReview");
  const search = query.get("search")?.toLowerCase();
  const limit = Number(query.get("limit")) || 50;
  const offset = Number(query.get("offset")) || 0;

  // A model "needs review" when any of its bands is still unsigned — the
  // same roll-up the real route reports.
  const unsigned = new Set(
    s.variants.filter((v) => v.needsClinicalReview).map((v) => v.modelId),
  );

  let models = s.models;
  if (manufacturer)
    models = models.filter((m) => m.manufacturer === manufacturer);
  if (interfaceType)
    models = models.filter((m) => m.interfaceType === interfaceType);
  if (serviceLine) models = models.filter((m) => m.serviceLine === serviceLine);
  if (status) models = models.filter((m) => m.status === status);
  if (needsReview === "true") models = models.filter((m) => unsigned.has(m.id));
  if (search) {
    models = models.filter(
      (m) =>
        m.modelName.toLowerCase().includes(search) ||
        m.manufacturer.toLowerCase().includes(search) ||
        m.slug.includes(search),
    );
  }

  const page = models.slice(offset, offset + limit).map((m) => ({
    ...m,
    needsClinicalReview: unsigned.has(m.id),
  }));
  const body: Record<string, unknown> = { models: page, limit, offset };
  if (query.get("dispensedOnly") === "true") body.dispensingConfigured = true;
  return body;
}

/** GET /admin/fitter/catalog/:id */
export function demoMaskModel(id: string) {
  const s = get();
  const model = s.models.find((m) => m.id === id || m.slug === id);
  if (!model) return null;
  const variants = s.variants.filter((v) => v.modelId === model.id);
  return {
    model: {
      ...model,
      needsClinicalReview: variants.some((v) => v.needsClinicalReview),
    },
    variants,
    components: [
      {
        id: `${model.id}-c1`,
        kind: "cushion",
        label: "Cushion",
        replaceEveryDays: 30,
      },
      {
        id: `${model.id}-c2`,
        kind: "headgear",
        label: "Headgear",
        replaceEveryDays: 180,
      },
      {
        id: `${model.id}-c3`,
        kind: "frame",
        label: "Frame",
        replaceEveryDays: 90,
      },
    ],
    contraindications: model.hasMagneticComponents
      ? [
          {
            factor: "implanted_device",
            severity: "exclude" as const,
            rationale:
              "Magnetic headgear clips can interfere with pacemakers, defibrillators, neurostimulators and other implanted devices — for the patient and for a bed partner.",
          },
          {
            factor: "metallic_implant",
            severity: "exclude" as const,
            rationale:
              "Metallic cranial implants, clips and shunts are a contraindication.",
          },
        ]
      : model.interfaceType === "full_face"
        ? [
            {
              factor: "claustrophobia",
              severity: "caution" as const,
              rationale:
                "Full-face coverage is poorly tolerated by claustrophobic patients.",
            },
          ]
        : [],
    // Platform rows carry shared facts: sign-off is available, editing is not.
    editable: !model.isPlatformRow,
  };
}

/** PATCH /admin/fitter/catalog/:id */
export function demoUpdateMaskModel(
  id: string,
  patch: Record<string, unknown>,
) {
  const model = get().models.find((m) => m.id === id || m.slug === id);
  if (!model) return null;
  // Platform rows are shared across every tenant — the real route refuses
  // to edit their facts here, so the demo does too.
  if (model.isPlatformRow) {
    return { error: "platform_row_not_editable" as const };
  }
  Object.assign(model, patch);
  return { model };
}

/** PATCH /admin/fitter/catalog/variants/:id — band edits. */
export function demoUpdateVariantBands(
  id: string,
  patch: Record<string, unknown>,
) {
  const variant = get().variants.find((v) => v.id === id);
  if (!variant) return null;
  Object.assign(variant, patch);
  return { variant };
}

/**
 * POST /admin/fitter/catalog/variants/:id/review — the per-tenant
 * sign-off. This is the ONLY thing that clears `needsClinicalReview`, and
 * it records the provenance the reviewer cited.
 */
export function demoReviewVariant(
  id: string,
  body:
    | { note?: string; sourceKind?: ReviewSourceKind; sourceRef?: string }
    | undefined,
) {
  const variant = get().variants.find((v) => v.id === id);
  if (!variant) return null;
  variant.needsClinicalReview = false;
  variant.reviewedByEmail = DEMO_REVIEWER;
  variant.reviewedAt = NOW_ISO();
  variant.reviewSourceKind = body?.sourceKind ?? "clinical_judgment";
  variant.reviewSourceRef = body?.sourceRef ?? body?.note ?? null;
  return { variant };
}

/** POST /admin/fitter/catalog/variants/review-batch */
export function demoReviewVariantsBatch(
  body:
    | {
        variantIds?: string[];
        approved?: boolean;
        sourceKind?: ReviewSourceKind;
        sourceRef?: string;
        note?: string;
      }
    | undefined,
) {
  // The client serializes the selection as `variantIds` (not `ids`) and
  // reads back `{ ok, approved, count }`. Reading the wrong key made the
  // bulk sign-off a silent no-op: it reported success and left every
  // variant still flagged after the refetch.
  const ids = body?.variantIds ?? [];
  const approved = body?.approved ?? true;
  let count = 0;
  for (const id of ids) {
    if (demoReviewVariant(id, body)) count += 1;
  }
  return { ok: true as const, approved, count };
}

// ── Formulary ───────────────────────────────────────────────────────

/** GET /admin/fitter/formulary */
export function demoFormulary() {
  const s = get();
  return { formulary: s.formulary, rules: s.rules };
}

/** PATCH /admin/fitter/formulary */
export function demoUpdateFormulary(
  patch:
    | Partial<Pick<DemoFormulary, "name" | "defaultPosture" | "notes">>
    | undefined,
) {
  const s = get();
  if (patch?.name !== undefined) s.formulary.name = patch.name;
  if (patch?.defaultPosture !== undefined)
    s.formulary.defaultPosture = patch.defaultPosture;
  if (patch?.notes !== undefined) s.formulary.notes = patch.notes;
  return { ok: true as const };
}

/** POST /admin/fitter/formulary/rules */
export function demoCreateFormularyRule(
  rule: Record<string, unknown> | undefined,
) {
  const s = get();
  const id = newId("demo-rule");
  const base: DemoFormularyRule = {
    id,
    locationId: null,
    payerProfileId: null,
    contractRef: null,
    serviceLine: null,
    therapyMode: null,
    targetKind: "all",
    targetManufacturer: null,
    targetInterfaceType: null,
    targetMaskModelId: null,
    targetSizeVariantId: null,
    effect: "allow",
    preferenceRank: null,
    reasonCode: null,
    reasonNote: null,
    effectiveFrom: NOW_ISO(),
    effectiveTo: null,
    createdByEmail: DEMO_REVIEWER,
    createdAt: NOW_ISO(),
  };
  // Caller fields override the defaults, but never the id — that is ours.
  s.rules.push({ ...base, ...(rule as Partial<DemoFormularyRule>), id });
  return { id };
}

/** DELETE /admin/fitter/formulary/rules/:id */
export function demoDeleteFormularyRule(id: string) {
  const s = get();
  s.rules = s.rules.filter((r) => r.id !== id);
  return { ok: true as const };
}

/**
 * POST /admin/fitter/formulary/simulate — dry-run the rules against a
 * synthetic panel. Computed from the CURRENT rule set, so adding or
 * deleting a rule visibly changes the verdict (which is the whole point
 * of the simulator).
 */
export function demoSimulateFormulary(
  context: Record<string, unknown> | undefined,
) {
  const s = get();
  const serviceLine = (context?.serviceLine as string) ?? "adult";

  const panels: Array<{ label: string; interfaceType: InterfaceType }> = [
    { label: "Narrow face, no facial hair", interfaceType: "nasal_pillow" },
    { label: "Average face, beard", interfaceType: "nasal_cradle" },
    { label: "Wide face, mouth breather", interfaceType: "full_face" },
    { label: "Claustrophobic, side sleeper", interfaceType: "nasal" },
  ];

  const applies = (r: DemoFormularyRule, m: DemoMaskModel) => {
    if (r.serviceLine && r.serviceLine !== serviceLine) return false;
    switch (r.targetKind) {
      case "manufacturer":
        return r.targetManufacturer === m.manufacturer;
      case "interface_type":
        return r.targetInterfaceType === m.interfaceType;
      case "mask_model":
        return r.targetMaskModelId === m.id;
      case "all":
        return true;
      default:
        return false;
    }
  };

  return {
    formulary: {
      name: s.formulary.name,
      version: s.formulary.version,
      defaultPosture: s.formulary.defaultPosture,
    },
    panel: panels.map((p) => {
      const candidates = s.models.filter(
        (m) => m.interfaceType === p.interfaceType && m.status === "current",
      );
      const denied: Array<{
        mask: string;
        reasonCode: string | null;
        ruleIds: string[];
      }> = [];
      const preferred: Array<{ mask: string; rank: number | null }> = [];
      let allowedCount = 0;

      for (const m of candidates) {
        const hits = s.rules.filter((r) => applies(r, m));
        const denyRule = hits.find((r) => r.effect === "deny");
        if (
          denyRule ||
          (s.formulary.defaultPosture === "closed" &&
            !hits.some((r) => r.effect === "allow" || r.effect === "prefer"))
        ) {
          denied.push({
            mask: `${m.manufacturer} ${m.modelName}`,
            reasonCode: denyRule?.reasonCode ?? "closed_formulary",
            ruleIds: denyRule ? [denyRule.id] : [],
          });
          continue;
        }
        allowedCount += 1;
        const preferRule = hits.find((r) => r.effect === "prefer");
        if (preferRule) {
          preferred.push({
            mask: `${m.manufacturer} ${m.modelName}`,
            rank: preferRule.preferenceRank,
          });
        }
      }
      preferred.sort((a, b) => (a.rank ?? 99) - (b.rank ?? 99));
      return {
        label: p.label,
        allowedCount,
        deniedCount: denied.length,
        preferred,
        denied,
      };
    }),
  };
}

/** POST /admin/fitter/formulary/publish */
export function demoPublishFormulary() {
  const s = get();
  s.formulary.version += 1;
  s.formulary.status = "published";
  s.formulary.publishedAt = NOW_ISO();
  s.formulary.publishedByEmail = DEMO_REVIEWER;
  return { ok: true as const, version: s.formulary.version };
}

// ── Fit sessions ────────────────────────────────────────────────────

function sessionSummary(s: DemoFitSession) {
  const { measurements: _m, ...summary } = s;
  return summary;
}

/** GET /admin/fit-sessions */
export function demoFitSessions(query: URLSearchParams) {
  const s = get();
  const reviewStatus = query.get("reviewStatus");
  const outcome = query.get("outcome");
  const patientId = query.get("patientId");
  const limit = Number(query.get("limit")) || 50;
  const offset = Number(query.get("offset")) || 0;

  let sessions = s.sessions;
  if (reviewStatus)
    sessions = sessions.filter((x) => x.reviewStatus === reviewStatus);
  if (outcome) sessions = sessions.filter((x) => x.outcome === outcome);
  if (patientId) sessions = sessions.filter((x) => x.patientId === patientId);

  return {
    sessions: sessions.slice(offset, offset + limit).map(sessionSummary),
    limit,
    offset,
  };
}

/** GET /admin/fit-sessions/:id */
export function demoFitSession(id: string) {
  const s = get().sessions.find((x) => x.id === id);
  if (!s) return null;
  const models = get().models;
  return {
    session: sessionSummary(s),
    measurements: s.measurements,
    // The ranked alternatives the detail drawer renders next to the pick.
    recommendations: models.slice(0, 3).map((m, i) => ({
      rank: i + 1,
      maskModelId: m.id,
      maskName: `${m.manufacturer} ${m.modelName}`,
      interfaceType: m.interfaceType,
      sizeLabel: i === 0 ? "Medium" : "Small",
      score: Math.round((0.95 - i * 0.12) * 100) / 100,
      rationale:
        i === 0
          ? "Nose width falls mid-band; no contraindications from the safety screen."
          : "Within band but a poorer match on the secondary measurements.",
    })),
    safetyScreen: {
      completedAt: s.createdAt,
      flags: s.outcome === "contraindicated" ? ["magnetic_interference"] : [],
    },
  };
}

/** POST /admin/fit-sessions/:id/approve */
export function demoApproveFitSession(id: string) {
  const s = get().sessions.find((x) => x.id === id);
  if (!s) return null;
  s.reviewStatus = "approved";
  s.reviewedByEmail = DEMO_REVIEWER;
  s.reviewedAt = NOW_ISO();
  return { ok: true as const };
}

/** POST /admin/fit-sessions/:id/override */
export function demoOverrideFitSession(
  id: string,
  body:
    | { maskModelId?: string; variantId?: string | null; reason?: string }
    | undefined,
) {
  const st = get();
  const s = st.sessions.find((x) => x.id === id);
  if (!s) return null;
  const m = st.models.find((x) => x.id === body?.maskModelId);
  s.reviewStatus = "overridden";
  s.reviewedByEmail = DEMO_REVIEWER;
  s.reviewedAt = NOW_ISO();
  if (m) s.recommendedMask = `${m.manufacturer} ${m.modelName}`;
  return { ok: true as const };
}

/** POST /admin/fit-sessions/:id/request-rescan */
export function demoRequestRescan(id: string) {
  const s = get().sessions.find((x) => x.id === id);
  if (!s) return null;
  s.reviewStatus = "rescan_requested";
  s.reviewedByEmail = DEMO_REVIEWER;
  s.reviewedAt = NOW_ISO();
  // RescanResult. Demo mode can't deliver anything, so this reports the
  // "nowhere to send it" branch and hands back a usable link — which is
  // also the branch worth demonstrating, since it's the one where staff
  // have to copy the link to the patient themselves.
  return {
    ok: true as const,
    patientNotified: false,
    notifyReason: "no_channel_config" as const,
    inviteLink: `https://cmbreathe.example/fit/rescan/${newId("demo-token")}`,
  };
}

// ── Safety screens ──────────────────────────────────────────────────

/** GET /admin/fitter/safety-screens */
export function demoSafetyScreens() {
  const s = get();
  const active = s.screens.find((v) => v.id === s.activeScreenId);
  return {
    activeVersionId: s.activeScreenId,
    usingPlatformDefault: Boolean(active?.isPlatform),
    versions: s.screens,
  };
}

/** POST /admin/fitter/safety-screens — clone the active set into a draft. */
export function demoCreateSafetyScreenDraft(
  input: { title?: string; version?: string } | undefined,
) {
  const s = get();
  const source =
    s.screens.find((v) => v.id === s.activeScreenId) ?? s.screens[0];
  const id = newId("demo-screen");
  const draft: DemoScreenVersion = {
    ...source,
    id,
    isPlatform: false,
    slug: `tenant-safety-${s.screens.length + 1}`,
    version: input?.version ?? `draft-${s.screens.length + 1}`,
    status: "draft",
    title: input?.title ?? `${source.title} (copy)`,
    effectiveFrom: null,
    retiredOn: null,
    updatedAt: NOW_ISO(),
    questions: source.questions.map((q, i) => ({
      ...q,
      id: `${id}-q${i + 1}`,
    })),
  };
  s.screens.push(draft);
  // `{ id, clonedFrom }` at the TOP level — the page immediately calls
  // setOpenId(r.id) to open the new draft for editing.
  return { id: draft.id, clonedFrom: source?.id ?? null };
}

/** PATCH /admin/fitter/safety-screens/:id */
export function demoUpdateSafetyScreenDraft(
  id: string,
  patch: Record<string, unknown> | undefined,
) {
  const v = get().screens.find((x) => x.id === id);
  if (!v) return null;
  if (v.isPlatform) return { error: "platform_screen_not_editable" as const };
  Object.assign(v, patch, { updatedAt: NOW_ISO() });
  return { version: v };
}

/** PUT /admin/fitter/safety-screens/:id/questions */
export function demoReplaceSafetyScreenQuestions(
  id: string,
  body: { questions?: Array<Partial<DemoScreenQuestion>> } | undefined,
) {
  const v = get().screens.find((x) => x.id === id);
  if (!v) return null;
  if (v.isPlatform) return { error: "platform_screen_not_editable" as const };
  const rows = body?.questions ?? [];
  v.questions = rows.map((q, i) => ({
    id: q.id ?? `${id}-q${i + 1}`,
    questionKey: q.questionKey ?? `question_${i + 1}`,
    prompt: q.prompt ?? "",
    helpText: q.helpText ?? null,
    subject: q.subject ?? "patient",
    sortOrder: i,
    riskFlag: q.riskFlag ?? "tolerance",
    disqualifiesAttribute: q.disqualifiesAttribute ?? null,
    severity: q.severity ?? "warn",
    unsureBehavesAs: q.unsureBehavesAs ?? "warn",
  }));
  v.updatedAt = NOW_ISO();
  return { version: v };
}

/** POST /admin/fitter/safety-screens/:id/publish */
export function demoPublishSafetyScreen(id: string) {
  const s = get();
  const v = s.screens.find((x) => x.id === id);
  if (!v) return null;
  // Publishing a tenant set retires whichever tenant set was active and
  // takes over from the platform default.
  for (const other of s.screens) {
    if (!other.isPlatform && other.status === "active" && other.id !== id) {
      other.status = "retired";
      other.retiredOn = NOW_ISO();
    }
  }
  v.status = "active";
  v.effectiveFrom = NOW_ISO();
  v.updatedAt = NOW_ISO();
  s.activeScreenId = v.id;
  return { version: v };
}

/** POST /admin/fitter/safety-screens/:id/retire */
export function demoRetireSafetyScreen(id: string) {
  const s = get();
  const v = s.screens.find((x) => x.id === id);
  if (!v) return null;
  v.status = "retired";
  v.retiredOn = NOW_ISO();
  v.updatedAt = NOW_ISO();
  if (s.activeScreenId === id) {
    // Fall back to the platform screen, exactly like the real route.
    s.activeScreenId = s.screens.find((x) => x.isPlatform)?.id ?? null;
  }
  return { version: v };
}

/** DELETE /admin/fitter/safety-screens/:id */
export function demoDeleteSafetyScreenDraft(id: string) {
  const s = get();
  s.screens = s.screens.filter(
    (x) => x.id !== id || x.isPlatform || x.status !== "draft",
  );
  return { ok: true as const };
}
