// Tests for the tiered clinical fitting pipeline.
//
// The tier ORDER is the contract this whole feature rests on, so most of
// these assert an ordering invariant rather than a scalar. The headline
// one — a safety exclusion survives a maximal commercial push — is the
// mechanical statement of "financial margin must never override a clinical
// or safety exclusion", and it is the test to read first.

import { describe, expect, it } from "vitest";

import { assess } from "./index";
import { emptyProfile } from "./profile";
import {
  applySafetyExclusions,
  applyTherapyCompatibility,
  resolveSafetyFlags,
  scoreFacialFit,
  scoreVariant,
  supplyMultiplier,
} from "./tiers";
import { OPEN_FORMULARY } from "./formulary";
import type {
  CatalogMask,
  FitContext,
  FitEngineInput,
  FitMeasurements,
  Formulary,
  FormularyRule,
  SafetyScreen,
  SizeVariant,
} from "./types";

// ── Fixtures ─────────────────────────────────────────────────────────

const MEASUREMENTS: FitMeasurements = {
  noseWidth: 34,
  noseHeight: 45,
  noseToChin: 66,
  mouthWidth: 50,
  faceWidthAtCheekbones: 142,
};

function variant(over: Partial<SizeVariant> = {}): SizeVariant {
  return {
    id: "v1",
    component: "cushion",
    sizeCode: "M",
    sizeLabel: "Medium",
    manufacturerPartNumber: null,
    sortOrder: 0,
    noseWidthMin: 30,
    noseWidthMax: 38,
    noseHeightMin: null,
    noseHeightMax: null,
    noseToChinMin: 60,
    noseToChinMax: 72,
    mouthWidthMin: null,
    mouthWidthMax: null,
    faceWidthMin: null,
    faceWidthMax: null,
    isDefault: true,
    hcpcsCode: "A7031",
    status: "current",
    fitDataSource: "manufacturer",
    needsClinicalReview: false,
    ...over,
  };
}

function mask(over: Partial<CatalogMask> = {}): CatalogMask {
  return {
    id: over.slug ?? "mask-1",
    slug: over.slug ?? "mask-1",
    manufacturer: "ResMed",
    modelName: "Test Mask",
    productLine: null,
    interfaceType: "full_face",
    serviceLine: "adult",
    therapyModes: ["pap"],
    vented: "vented",
    hasMagneticComponents: false,
    magnetFreeVariantSlug: null,
    pressureMin: 4,
    pressureMax: 25,
    supportsSupplementalOxygen: null,
    minimalContact: false,
    avoidsNasalBridge: false,
    hosePosition: "front",
    facialHairTolerance: "fair",
    sideSleepingTolerance: "fair",
    claustrophobiaTolerance: "fair",
    glassesCompatible: false,
    cushionMaterial: "Silicone",
    headgearStyle: "Fabric",
    weightGrams: 120,
    description: null,
    imageUrl: null,
    status: "current",
    fitDataSource: "manufacturer",
    needsClinicalReview: false,
    catalogVersion: 1,
    variants: [variant({ id: `${over.slug ?? "mask-1"}:M` })],
    contraindications: [],
    ...over,
  };
}

const CONTEXT: FitContext = {
  locationId: null,
  payerProfileId: null,
  contractRef: null,
  population: "adult",
  therapyMode: "pap",
  asOf: "2026-08-17",
};

function rule(over: Partial<FormularyRule> = {}): FormularyRule {
  return {
    id: "r1",
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
    effectiveFrom: null,
    effectiveTo: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    ...over,
  };
}

const PERFECT_SCAN = {
  frameCount: 3,
  quality: { lighting: 1, distance: 1, pose: 1, occlusion: 1, motion: 1 },
  agreement: {},
  measurementConfidence: 1,
  band: "high" as const,
};

/**
 * A fully-answered profile.
 *
 * Most tests need one, because `emptyProfile()` legitimately resolves to
 * `low_confidence` — an unanswered questionnaire means the engine is
 * recommending on geometry alone, and it is supposed to say so rather than
 * hand back a confident-looking answer. Tests that want to exercise
 * ranking therefore have to give the engine something to rank on.
 */
function completeProfile(): ReturnType<typeof emptyProfile> {
  return {
    ...emptyProfile(),
    mouthBreather: false,
    nasalObstruction: "none",
    frequentCongestion: false,
    dryMouth: false,
    sleepPositions: ["back"],
    claustrophobia: "none",
    minimalContactPreference: "no_preference",
    facialHair: "none",
    dentures: false,
    facialStructureChange: false,
    skinIrritation: "none",
    sensitiveSkin: false,
    siliconeSensitivity: false,
    wearsGlasses: false,
    priorMaskExperience: "none",
    headgearDifficulty: false,
    handDexterity: "normal",
    visionOrCognitiveLimitation: false,
    pressureCmH2O: 10,
    pressureBand: "medium",
    supplementalOxygen: false,
  };
}

function input(over: Partial<FitEngineInput> = {}): FitEngineInput {
  return {
    measurements: MEASUREMENTS,
    profile: completeProfile(),
    scan: PERFECT_SCAN,
    catalog: [mask()],
    formulary: OPEN_FORMULARY,
    context: CONTEXT,
    safetyScreen: null,
    safetyResponses: [],
    availability: {},
    fitAdjustments: {},
    degraded: false,
    confidenceGating: true,
    magnetScreening: true,
    ...over,
  };
}

const MAGNET_SCREEN: SafetyScreen = {
  slug: "magnetic_implant",
  version: "2026-08.v1",
  title: "Magnetic component safety check",
  introCopy: null,
  attestationCopy: "I confirm...",
  questions: [
    {
      questionKey: "patient_cardiac_device",
      prompt: "Do you have a pacemaker?",
      helpText: null,
      subject: "patient",
      sortOrder: 10,
      riskFlag: "magnet_implant_patient",
      disqualifiesAttribute: "has_magnetic_components",
      severity: "exclude",
      unsureBehavesAs: "exclude",
    },
    {
      questionKey: "household_cardiac_device",
      prompt: "Does anyone you live with have a pacemaker?",
      helpText: null,
      subject: "household",
      sortOrder: 50,
      riskFlag: "magnet_implant_household",
      disqualifiesAttribute: "has_magnetic_components",
      severity: "exclude",
      unsureBehavesAs: "exclude",
    },
  ],
};

// ── The headline invariant ───────────────────────────────────────────

describe("safety outranks every commercial signal", () => {
  it("keeps a magnet-contraindicated mask excluded under a maximal formulary preference, in-stock status, top margin, and the best possible outcome history", () => {
    const magnetic = mask({
      slug: "magnetic-mask",
      hasMagneticComponents: true,
      manufacturer: "PreferredCo",
    });
    const plain = mask({ slug: "plain-mask", manufacturer: "OtherCo" });

    // Push every commercial lever as hard as the system allows.
    const formulary: Formulary = {
      id: "f1",
      name: "Stacked",
      version: 3,
      defaultPosture: "open",
      rules: [
        rule({
          id: "prefer-magnetic",
          targetKind: "manufacturer",
          targetManufacturer: "PreferredCo",
          effect: "prefer",
          preferenceRank: 1,
        }),
        rule({
          id: "deprioritize-plain",
          targetKind: "manufacturer",
          targetManufacturer: "OtherCo",
          effect: "deprioritize",
        }),
      ],
    };

    const result = assess(
      input({
        catalog: [magnetic, plain],
        formulary,
        safetyScreen: MAGNET_SCREEN,
        safetyResponses: [
          { questionKey: "patient_cardiac_device", answer: "yes" },
        ],
        availability: {
          "magnetic-mask": { availability: "in_stock", marginRank: 5 },
          "plain-mask": { availability: "out", marginRank: 1 },
        },
        fitAdjustments: { "magnetic-mask": 1.15, "plain-mask": 0.85 },
      }),
    );

    const surfaced = [result.primary, ...result.alternatives].filter(Boolean);
    expect(surfaced.map((c) => c!.maskSlug)).not.toContain("magnetic-mask");
    expect(
      result.excluded.some(
        (e) =>
          e.maskSlug === "magnetic-mask" &&
          e.code === "magnetic_component_contraindicated",
      ),
    ).toBe(true);
    expect(result.primary?.maskSlug).toBe("plain-mask");
  });

  it("does not let a formulary preference change the patient-facing confidence", () => {
    const a = mask({ slug: "a", manufacturer: "PreferredCo" });
    const b = mask({ slug: "b", manufacturer: "OtherCo" });

    const neutral = assess(input({ catalog: [a, b] }));
    const preferred = assess(
      input({
        catalog: [a, b],
        formulary: {
          id: "f1",
          name: "Preferred",
          version: 1,
          defaultPosture: "open",
          rules: [
            rule({
              targetKind: "manufacturer",
              targetManufacturer: "PreferredCo",
              effect: "prefer",
              preferenceRank: 1,
            }),
          ],
        },
      }),
    );

    const neutralA = [neutral.primary, ...neutral.alternatives].find(
      (c) => c?.maskSlug === "a",
    );
    const preferredA = [preferred.primary, ...preferred.alternatives].find(
      (c) => c?.maskSlug === "a",
    );
    expect(preferredA!.confidence).toBeCloseTo(neutralA!.confidence, 10);
    // ...but it DID move the ranking score, which is the point.
    expect(preferredA!.rankScore).toBeGreaterThan(neutralA!.rankScore);
  });

  it("still surfaces the only clinically viable mask when the formulary denies it", () => {
    const only = mask({ slug: "only-option", manufacturer: "DeniedCo" });
    const result = assess(
      input({
        catalog: [only],
        formulary: {
          id: "f1",
          name: "Restrictive",
          version: 1,
          defaultPosture: "closed",
          rules: [],
        },
      }),
    );

    // Demoted and tagged, never removed: a clinician has to be able to see
    // that the only appropriate mask is off-formulary.
    expect(result.primary?.maskSlug).toBe("only-option");
    expect(result.primary?.outsideFormulary).toBe(true);
    expect(result.primary?.outsideFormularyReason).toBeTruthy();
  });
});

// ── Tier 1: safety ───────────────────────────────────────────────────

describe("tier 1 — safety", () => {
  it("treats 'unsure' exactly like 'yes' when the question says so", () => {
    const yes = resolveSafetyFlags(MAGNET_SCREEN, [
      { questionKey: "patient_cardiac_device", answer: "yes" },
    ]);
    const unsure = resolveSafetyFlags(MAGNET_SCREEN, [
      { questionKey: "patient_cardiac_device", answer: "unsure" },
    ]);
    expect(unsure.disqualifiedAttributes).toEqual(yes.disqualifiedAttributes);
    expect([...unsure.flags]).toEqual([...yes.flags]);
  });

  it("excludes magnetic masks on a household answer alone", () => {
    const result = applySafetyExclusions(
      [mask({ slug: "m", hasMagneticComponents: true })],
      emptyProfile(),
      MAGNET_SCREEN,
      [{ questionKey: "household_cardiac_device", answer: "yes" }],
      true,
    );
    expect(result.survivors).toHaveLength(0);
    expect(result.excluded[0]!.patientReason).toContain("someone in your home");
  });

  it("does nothing when magnet screening is disabled", () => {
    const result = applySafetyExclusions(
      [mask({ slug: "m", hasMagneticComponents: true })],
      emptyProfile(),
      MAGNET_SCREEN,
      [{ questionKey: "patient_cardiac_device", answer: "yes" }],
      false,
    );
    expect(result.survivors).toHaveLength(1);
  });

  it("keeps a pediatric interface away from an adult session and vice versa", () => {
    const pediatric = mask({ slug: "ped", serviceLine: "pediatric" });
    const adult = mask({ slug: "adult", serviceLine: "adult" });
    const catalog = [pediatric, adult];

    const asAdult = applySafetyExclusions(
      catalog,
      { ...emptyProfile(), population: "adult" },
      null,
      [],
      true,
    );
    expect(asAdult.survivors.map((m) => m.slug)).toEqual(["adult"]);

    const asChild = applySafetyExclusions(
      catalog,
      { ...emptyProfile(), population: "pediatric" },
      null,
      [],
      true,
    );
    expect(asChild.survivors.map((m) => m.slug)).toEqual(["ped"]);
  });

  it("hard-excludes on a catalog contraindication rather than scoring it down", () => {
    const m = mask({
      slug: "m",
      contraindications: [
        {
          factor: "mouth_breathing",
          severity: "exclude",
          rationale: "Nasal only.",
        },
      ],
    });
    const result = applySafetyExclusions(
      [m],
      { ...emptyProfile(), mouthBreather: true },
      null,
      [],
      true,
    );
    expect(result.survivors).toHaveLength(0);
  });

  it("leaves a 'caution' contraindication in the running", () => {
    const m = mask({
      slug: "m",
      contraindications: [
        {
          factor: "mouth_breathing",
          severity: "caution",
          rationale: "Nasal only.",
        },
      ],
    });
    const result = applySafetyExclusions(
      [m],
      { ...emptyProfile(), mouthBreather: true },
      null,
      [],
      true,
    );
    expect(result.survivors).toHaveLength(1);
  });
});

// ── Tier 2: therapy compatibility ────────────────────────────────────

describe("tier 2 — therapy compatibility", () => {
  it("rejects a vented mask on an NIV circuit and a non-vented mask on CPAP", () => {
    const vented = mask({
      slug: "vented",
      vented: "vented",
      therapyModes: ["pap", "niv"],
    });
    const nonVented = mask({
      slug: "non-vented",
      vented: "non_vented",
      therapyModes: ["pap", "niv"],
    });

    const onPap = applyTherapyCompatibility(
      [vented, nonVented],
      { ...emptyProfile(), therapyMode: "pap" },
      true,
    );
    expect(onPap.survivors.map((m) => m.slug)).toEqual(["vented"]);
    expect(onPap.excluded[0]!.code).toBe("vent_incompatible");

    const onNiv = applyTherapyCompatibility(
      [vented, nonVented],
      { ...emptyProfile(), therapyMode: "niv" },
      true,
    );
    expect(onNiv.survivors.map((m) => m.slug)).toEqual(["non-vented"]);
  });

  it("excludes a mask rated below the prescribed pressure — a filter, not a penalty", () => {
    const lowRated = mask({ slug: "low", pressureMax: 20 });
    const highRated = mask({ slug: "high", pressureMax: 30 });
    const profile = { ...emptyProfile(), pressureCmH2O: 25 };

    const strict = applyTherapyCompatibility(
      [lowRated, highRated],
      profile,
      true,
    );
    expect(strict.survivors.map((m) => m.slug)).toEqual(["high"]);
    expect(strict.excluded[0]!.code).toBe("pressure_rating_exceeded");

    // With gating off the legacy soft behaviour is preserved.
    const lenient = applyTherapyCompatibility(
      [lowRated, highRated],
      profile,
      false,
    );
    expect(lenient.survivors).toHaveLength(2);
  });

  it("rejects a mask that cannot take supplemental oxygen when the patient uses it", () => {
    const result = applyTherapyCompatibility(
      [mask({ slug: "m", supportsSupplementalOxygen: false })],
      { ...emptyProfile(), supplementalOxygen: true },
      true,
    );
    expect(result.survivors).toHaveLength(0);
    expect(result.excluded[0]!.code).toBe("oxygen_entrainment_unsupported");
  });
});

// ── Tier 3: facial fit ───────────────────────────────────────────────

describe("tier 3 — facial fit", () => {
  it("returns null for a variant with no usable bands rather than scoring it a perfect fit", () => {
    const bare = variant({
      noseWidthMin: null,
      noseWidthMax: null,
      noseToChinMin: null,
      noseToChinMax: null,
    });
    expect(scoreVariant(bare, MEASUREMENTS)).toBeNull();
  });

  it("scores a dead-centre measurement above an edge measurement", () => {
    const v = variant({
      noseWidthMin: 30,
      noseWidthMax: 38,
      noseToChinMin: null,
      noseToChinMax: null,
    });
    const centre = scoreVariant(v, { ...MEASUREMENTS, noseWidth: 34 })!;
    const edge = scoreVariant(v, { ...MEASUREMENTS, noseWidth: 30.1 })!;
    expect(centre.margin).toBeGreaterThan(edge.margin);
  });

  it("reports zero margin when the measurement falls outside the band", () => {
    const v = variant({
      noseWidthMin: 30,
      noseWidthMax: 38,
      noseToChinMin: null,
      noseToChinMax: null,
    });
    expect(scoreVariant(v, { ...MEASUREMENTS, noseWidth: 45 })!.margin).toBe(0);
  });

  it("names the measurements that actually drove the size", () => {
    const result = assess(input());
    expect(result.primary?.cushion?.measurementsUsed).toContain("noseWidth");
    expect(result.primary?.cushion?.rationale).toContain("Medium");
  });

  // The rationale is patient-facing copy. It used to append "based on
  // estimated sizing data pending clinical review" for a seeded band —
  // a hedge that was dropped with the RT sign-off gate it referred to.
  // Provenance is still recorded on `fit_data_source` and printed on the
  // clinical fit report; it just is not in the sentence the patient reads.
  it("cites a real source, and hedges nothing when there isn't one", () => {
    const rationaleFor = (over: Partial<SizeVariant>): string =>
      scoreFacialFit(mask({ variants: [variant(over)] }), MEASUREMENTS).cushion!
        .rationale;

    expect(rationaleFor({ fitDataSource: "manufacturer" })).toContain(
      "based on manufacturer fitting data",
    );
    expect(rationaleFor({ fitDataSource: "measured" })).toContain(
      "based on measured sample data",
    );

    const estimated = rationaleFor({
      fitDataSource: "estimated",
      needsClinicalReview: true,
    });
    expect(estimated).not.toMatch(/pending clinical review/i);
    expect(estimated).not.toMatch(/estimated/i);
    expect(estimated).not.toMatch(/based on/i);
    // The useful half survives: it still says which size and why.
    expect(estimated).toContain("Medium");
    expect(estimated).toContain("nose width");
  });
});

// ── Tier 6: supply ───────────────────────────────────────────────────

describe("tier 6 — supply is bounded and never excludes", () => {
  it("keeps the multiplier inside its declared band even at the extremes", () => {
    const best = supplyMultiplier({ availability: "in_stock", marginRank: 5 });
    const worst = supplyMultiplier({ availability: "out", marginRank: 1 });
    expect(best).toBeLessThanOrEqual(1.06);
    expect(worst).toBeGreaterThanOrEqual(0.94);
  });

  it("annotates an out-of-stock recommendation instead of dropping it", () => {
    const result = assess(
      input({
        availability: { "mask-1": { availability: "out", marginRank: null } },
      }),
    );
    expect(result.primary?.maskSlug).toBe("mask-1");
    expect(result.primary?.cautions.join(" ")).toContain("out of stock");
  });
});

// ── Alternatives ─────────────────────────────────────────────────────

describe("alternatives", () => {
  it("returns at least two, spanning more than one interface category, each with a reason", () => {
    const result = assess(
      input({
        catalog: [
          mask({ slug: "ff", interfaceType: "full_face" }),
          mask({ slug: "ff2", interfaceType: "full_face" }),
          mask({
            slug: "np",
            interfaceType: "nasal_pillow",
            variants: [variant({ id: "np:M", component: "pillow" })],
          }),
        ],
      }),
    );
    expect(result.alternatives.length).toBeGreaterThanOrEqual(2);
    const categories = new Set(result.alternatives.map((a) => a.interfaceType));
    expect(categories.size).toBeGreaterThanOrEqual(2);
    for (const alt of result.alternatives) {
      expect(alt.rankedBelowBecause).toBeTruthy();
    }
  });

  it("offers a non-magnetic option when the primary uses magnets", () => {
    const result = assess(
      input({
        catalog: [
          mask({ slug: "magnetic", hasMagneticComponents: true }),
          mask({ slug: "plain", hasMagneticComponents: false }),
        ],
        // No safety screen answers, so magnets are not excluded here.
        safetyScreen: MAGNET_SCREEN,
        safetyResponses: [],
        formulary: {
          id: "f",
          name: "f",
          version: 1,
          defaultPosture: "open",
          rules: [
            rule({
              targetKind: "mask_model",
              targetMaskModelId: "magnetic",
              effect: "prefer",
              preferenceRank: 1,
            }),
          ],
        },
      }),
    );
    expect(result.primary?.maskSlug).toBe("magnetic");
    expect(result.alternatives.some((a) => a.maskSlug === "plain")).toBe(true);
  });
});
