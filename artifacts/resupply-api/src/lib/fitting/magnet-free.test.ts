// Tests for the same-model magnet-free swap.
//
// The clinical point these defend: when the magnet safety screen removes
// a mask, the patient should be offered the MANUFACTURER'S magnet-free
// version of that same mask — same cushion, same size band, nothing new
// to learn — rather than being pushed to a structurally different mask.
//
// The test to read first is "never names a swap it did not offer". The
// engine is allowed to stay silent; it is not allowed to tell a patient
// a safe version exists and then not put it in front of them.

import { describe, expect, it } from "vitest";

import { annotateMagnetFreeSwaps, assess } from "./index";
import { emptyProfile } from "./profile";
import { OPEN_FORMULARY } from "./formulary";
import type {
  CatalogMask,
  ExclusionRecord,
  FitContext,
  FitEngineInput,
  FitMeasurements,
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

const PERFECT_SCAN = {
  frameCount: 3,
  quality: { lighting: 1, distance: 1, pose: 1, occlusion: 1, motion: 1 },
  agreement: {},
  measurementConfidence: 1,
  band: "high" as const,
};

const CONTEXT: FitContext = {
  locationId: null,
  payerProfileId: null,
  contractRef: null,
  population: "adult",
  therapyMode: "pap",
  asOf: "2026-08-18",
};

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
  };
}

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
  const slug = over.slug ?? "mask-1";
  return {
    id: slug,
    slug,
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
    variants: [variant({ id: `${slug}:M` })],
    contraindications: [],
    ...over,
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
  ],
};

/** The F20 / F20-non-magnetic pair, as 0493 seeds it. */
const MAGNETIC = mask({
  slug: "f20",
  modelName: "AirFit F20",
  hasMagneticComponents: true,
  magnetFreeVariantSlug: "f20-nm",
});
const TWIN = mask({
  slug: "f20-nm",
  modelName: "AirFit F20 Non-Magnetic",
  hasMagneticComponents: false,
});
/** A structurally different mask, so "any magnet-free option" can win. */
const OTHER = mask({
  slug: "nasal-a",
  modelName: "Some Nasal Mask",
  interfaceType: "nasal",
});

const IMPLANT_YES = [
  { questionKey: "patient_cardiac_device", answer: "yes" as const },
];

// ── Tests ────────────────────────────────────────────────────────────

describe("same-model magnet-free swap", () => {
  it("offers the twin when the screen excludes the magnetic parent", () => {
    const result = assess(
      input({
        catalog: [MAGNETIC, TWIN, OTHER],
        safetyScreen: MAGNET_SCREEN,
        safetyResponses: IMPLANT_YES,
      }),
    );

    const slugs = [
      result.primary?.maskSlug,
      ...result.alternatives.map((a) => a.maskSlug),
    ];
    expect(slugs).toContain("f20-nm");
    expect(slugs).not.toContain("f20");

    const ruledOut = result.excluded.find((e) => e.maskSlug === "f20");
    expect(ruledOut?.magnetFreeAlternativeSlug).toBe("f20-nm");
    expect(ruledOut?.magnetFreeAlternativeName).toBe("AirFit F20 Non-Magnetic");
    expect(ruledOut?.patientReason).toContain("magnet-free version");
  });

  it("prefers the twin over any other alternative when the primary has magnets", () => {
    // Screen not answered, so the magnetic F20 still wins on fit and the
    // twin has to earn its place as an ALTERNATIVE rather than by default.
    const result = assess(input({ catalog: [MAGNETIC, TWIN, OTHER] }));

    expect(result.primary?.maskSlug).toBe("f20");
    expect(result.alternatives[0]?.maskSlug).toBe("f20-nm");
    expect(result.alternatives[0]?.rankedBelowBecause).toContain(
      "same mask as the one recommended above",
    );
  });

  it("never names a swap it did not offer", () => {
    // The twin exists in the catalog but is ruled out too — here by being
    // a pediatric-only model against an adult session. Staying silent is
    // the required behaviour; naming it would send the patient after a
    // mask this engine is not going to show them.
    const pediatricTwin = mask({
      ...TWIN,
      slug: "f20-nm",
      serviceLine: "pediatric",
    });
    const result = assess(
      input({
        catalog: [MAGNETIC, pediatricTwin, OTHER],
        safetyScreen: MAGNET_SCREEN,
        safetyResponses: IMPLANT_YES,
      }),
    );

    const ruledOut = result.excluded.find((e) => e.maskSlug === "f20");
    expect(ruledOut).toBeDefined();
    expect(ruledOut?.magnetFreeAlternativeSlug ?? null).toBeNull();
    expect(ruledOut?.patientReason).not.toContain("magnet-free version");
  });

  it("ignores a pointer at a mask that is itself magnetic", () => {
    // A mis-seeded magnet_free_variant_slug must be inert, never a safety
    // claim. This is the guard that keeps a data error from becoming a
    // clinical assertion.
    const badTwin = mask({
      slug: "f20-nm",
      modelName: "Not Actually Magnet Free",
      hasMagneticComponents: true,
    });
    const result = assess(
      input({
        catalog: [MAGNETIC, badTwin, OTHER],
        safetyScreen: MAGNET_SCREEN,
        safetyResponses: IMPLANT_YES,
      }),
    );

    const ruledOut = result.excluded.find((e) => e.maskSlug === "f20");
    expect(ruledOut?.magnetFreeAlternativeSlug ?? null).toBeNull();
    // Both magnetic masks are gone; only the unrelated mask survives.
    expect(result.excluded.map((e) => e.maskSlug).sort()).toEqual([
      "f20",
      "f20-nm",
    ]);
  });

  it("falls back to the generic magnet-free pick when there is no twin", () => {
    const noTwin = mask({
      slug: "f20",
      modelName: "AirFit F20",
      hasMagneticComponents: true,
    });
    const result = assess(input({ catalog: [noTwin, OTHER] }));

    expect(result.primary?.maskSlug).toBe("f20");
    expect(result.alternatives.map((a) => a.maskSlug)).toContain("nasal-a");
  });

  it("inserts at most one twin of an excluded mask", () => {
    // Three magnetic masks screened out, each with a twin. Without the cap
    // the alternatives list becomes near-duplicates and crowds out the
    // different-category option a patient actually needs to compare.
    const catalog: CatalogMask[] = [];
    for (const n of ["a", "b", "c"]) {
      catalog.push(
        mask({
          slug: `mag-${n}`,
          hasMagneticComponents: true,
          magnetFreeVariantSlug: `mag-${n}-nm`,
        }),
        mask({ slug: `mag-${n}-nm` }),
      );
    }
    catalog.push(OTHER);

    const result = assess(
      input({
        catalog,
        safetyScreen: MAGNET_SCREEN,
        safetyResponses: IMPLANT_YES,
      }),
    );

    const shown = [
      result.primary?.maskSlug,
      ...result.alternatives.map((a) => a.maskSlug),
    ].filter(Boolean);
    // A different interface category still survives the cap.
    expect(shown).toContain("nasal-a");
  });
});

describe("review findings — labeling stays honest", () => {
  it("a mis-seeded pointer at a magnetic twin never labels it magnet-free", () => {
    // Copilot's finding: tiers.ts used to stamp magnetFreeVariantOf from
    // the raw pointer. With no safety screen fired, both masks survive as
    // candidates, and the mis-seeded twin would have been described to
    // the patient as having "magnet-free headgear clips".
    const badTwin = mask({
      slug: "f20-nm",
      modelName: "Not Actually Magnet Free",
      hasMagneticComponents: true,
    });
    const result = assess(input({ catalog: [MAGNETIC, badTwin, OTHER] }));

    for (const c of [result.primary, ...result.alternatives]) {
      if (!c) continue;
      expect(c.magnetFreeVariantOf ?? null).toBeNull();
      expect(c.rankedBelowBecause ?? "").not.toContain("magnet-free");
    }
  });

  it("a pointer on a non-magnetic parent never marks its twin", () => {
    const nonMagParent = mask({
      slug: "f20",
      modelName: "AirFit F20",
      hasMagneticComponents: false,
      magnetFreeVariantSlug: "f20-nm",
    });
    const result = assess(input({ catalog: [nonMagParent, TWIN, OTHER] }));
    for (const c of [result.primary, ...result.alternatives]) {
      if (!c) continue;
      expect(c.magnetFreeVariantOf ?? null).toBeNull();
    }
  });

  it("never claims a mask was ruled out when nothing was excluded", () => {
    // Codex's finding: the twin can reach the alternatives through
    // ordinary ranking while its parent was never excluded — no implant
    // answer was ever given. "A mask we had to rule out because of the
    // implanted-device answers" would be a false clinical statement.
    const best = mask({ slug: "best-ff", modelName: "Best Full Face" });
    const result = assess(
      input({
        catalog: [best, MAGNETIC, TWIN, OTHER],
        fitAdjustments: { "best-ff": 1.15, f20: 0.9, "f20-nm": 1.1 },
      }),
    );

    expect(result.primary?.maskSlug).toBe("best-ff");
    const twinAlt = result.alternatives.find((a) => a.maskSlug === "f20-nm");
    expect(twinAlt).toBeDefined();
    expect(twinAlt?.rankedBelowBecause ?? "").not.toContain("rule out");
    expect(twinAlt?.rankedBelowBecause ?? "").not.toContain("magnet-free");
  });

  it("annotates only the twins the patient will actually see", () => {
    // Codex's finding: with several magnetic exclusions, pickAlternatives
    // returns at most one excluded mask's twin, so an exclusion record
    // must not promise "your options below" for a twin that was capped
    // out of the rendered list.
    const catalog: CatalogMask[] = [];
    for (const n of ["a", "b", "c"]) {
      catalog.push(
        mask({
          slug: `mag-${n}`,
          modelName: `Magnetic ${n.toUpperCase()}`,
          hasMagneticComponents: true,
          magnetFreeVariantSlug: `mag-${n}-nm`,
        }),
        mask({
          slug: `mag-${n}-nm`,
          modelName: `Magnet Free ${n.toUpperCase()}`,
        }),
      );
    }
    catalog.push(OTHER);

    const result = assess(
      input({
        catalog,
        safetyScreen: MAGNET_SCREEN,
        safetyResponses: IMPLANT_YES,
      }),
    );

    const rendered = new Set(
      [
        result.primary?.maskSlug,
        ...result.alternatives.map((a) => a.maskSlug),
      ].filter(Boolean),
    );
    for (const ex of result.excluded) {
      if (ex.code !== "magnetic_component_contraindicated") continue;
      const twinSlug = `${ex.maskSlug}-nm`;
      if (rendered.has(twinSlug)) {
        expect(ex.magnetFreeAlternativeSlug).toBe(twinSlug);
        expect(ex.patientReason).toContain("options below");
      } else {
        expect(ex.magnetFreeAlternativeSlug ?? null).toBeNull();
        expect(ex.patientReason).not.toContain("options below");
      }
    }
    // The cap must actually bite in this construction — at least one
    // excluded parent's twin is not rendered, or the test proves nothing.
    const unrendered = result.excluded.filter(
      (ex) =>
        ex.code === "magnetic_component_contraindicated" &&
        !rendered.has(`${ex.maskSlug}-nm`),
    );
    expect(unrendered.length).toBeGreaterThan(0);
  });
});

describe("annotateMagnetFreeSwaps", () => {
  const record: ExclusionRecord = {
    maskSlug: "f20",
    maskName: "AirFit F20",
    tier: 1,
    code: "magnetic_component_contraindicated",
    patientReason: "This mask uses magnets in the headgear.",
    clinicianReason: "Magnetic headgear clips excluded.",
  };

  it("leaves non-magnet exclusions untouched", () => {
    const other: ExclusionRecord = { ...record, code: "service_line_mismatch" };
    const [out] = annotateMagnetFreeSwaps(
      [other],
      [MAGNETIC, TWIN],
      new Set(["f20-nm"]),
    );
    expect(out).toBe(other);
  });

  it("is a no-op when the catalog has no pointer", () => {
    const [out] = annotateMagnetFreeSwaps(
      [record],
      [mask({ slug: "f20", hasMagneticComponents: true })],
      new Set(["f20-nm"]),
    );
    expect(out?.magnetFreeAlternativeSlug ?? null).toBeNull();
  });

  it("is a no-op when the twin is not in the rendered result", () => {
    // The twin cleared every filter but pickAlternatives capped it out.
    // "We've included it in your options below" about a mask that is not
    // below would be a false statement on the results page.
    const [out] = annotateMagnetFreeSwaps(
      [record],
      [MAGNETIC, TWIN],
      new Set<string>(),
    );
    expect(out?.magnetFreeAlternativeSlug ?? null).toBeNull();
  });

  it("tolerates stored records written before the fields existed", () => {
    // fit_sessions.excluded is jsonb and older rows carry neither key.
    // build-report.ts casts them straight back to ExclusionRecord[], so
    // round-tripping one must not throw or invent a swap.
    const legacy = JSON.parse(JSON.stringify(record)) as ExclusionRecord;
    expect(() =>
      annotateMagnetFreeSwaps([legacy], [MAGNETIC, TWIN], new Set<string>()),
    ).not.toThrow();
    const [out] = annotateMagnetFreeSwaps(
      [legacy],
      [MAGNETIC, TWIN],
      new Set<string>(),
    );
    expect(out?.magnetFreeAlternativeSlug ?? null).toBeNull();
  });
});
