// Formulary resolution precedence.
//
// Multi-axis precedence is the part of this feature a human operator
// cannot hold in their head, so it is specified as a table here: one case
// per rule of the algorithm, each named after the behaviour it pins.

import { describe, expect, it } from "vitest";

import {
  formularyMultiplier,
  isManufacturerHidden,
  resolveCatalogVisibility,
  resolveFormulary,
  ruleApplies,
  scopeSpecificity,
  targetSpecificity,
} from "./formulary";
import type {
  CatalogMask,
  FitContext,
  Formulary,
  FormularyRule,
  SizeVariant,
} from "./types";

const VARIANT: SizeVariant = {
  id: "variant-1",
  component: "cushion",
  sizeCode: "M",
  sizeLabel: "Medium",
  manufacturerPartNumber: null,
  sortOrder: 0,
  noseWidthMin: 30,
  noseWidthMax: 38,
  noseHeightMin: null,
  noseHeightMax: null,
  noseToChinMin: null,
  noseToChinMax: null,
  mouthWidthMin: null,
  mouthWidthMax: null,
  faceWidthMin: null,
  faceWidthMax: null,
  isDefault: true,
  hcpcsCode: null,
  status: "current",
  fitDataSource: "manufacturer",
  needsClinicalReview: false,
};

const MASK: CatalogMask = {
  id: "model-1",
  slug: "acme-mask",
  manufacturer: "Acme",
  modelName: "Acme Mask",
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
  variants: [VARIANT],
  contraindications: [],
};

const CONTEXT: FitContext = {
  locationId: "loc-1",
  payerProfileId: "payer-1",
  contractRef: "CON-9",
  population: "adult",
  therapyMode: "pap",
  asOf: "2026-08-17",
};

function rule(over: Partial<FormularyRule> = {}): FormularyRule {
  return {
    id: "r",
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

function formulary(
  rules: FormularyRule[],
  posture: "open" | "closed" = "open",
): Formulary {
  return {
    id: "f1",
    name: "Test",
    version: 1,
    defaultPosture: posture,
    rules,
  };
}

const resolve = (
  rules: FormularyRule[],
  posture: "open" | "closed" = "open",
  context: FitContext = CONTEXT,
) => resolveFormulary(formulary(rules, posture), MASK, VARIANT, context);

describe("scope specificity ordering", () => {
  it("ranks contract > payer > location > therapy mode > population", () => {
    const contract = scopeSpecificity(rule({ contractRef: "CON-9" }));
    const payer = scopeSpecificity(rule({ payerProfileId: "payer-1" }));
    const location = scopeSpecificity(rule({ locationId: "loc-1" }));
    const therapy = scopeSpecificity(rule({ therapyMode: "pap" }));
    const population = scopeSpecificity(rule({ serviceLine: "adult" }));
    expect(contract).toBeGreaterThan(payer);
    expect(payer).toBeGreaterThan(location);
    expect(location).toBeGreaterThan(therapy);
    expect(therapy).toBeGreaterThan(population);
  });

  it("makes a single higher axis outweigh every lower axis combined", () => {
    // The powers-of-two weighting exists precisely so this holds: a payer
    // rule is never out-voted by an accumulation of weaker scopes.
    const payerOnly = scopeSpecificity(rule({ payerProfileId: "p" }));
    const everythingBelow = scopeSpecificity(
      rule({ locationId: "l", therapyMode: "pap", serviceLine: "adult" }),
    );
    expect(payerOnly).toBeGreaterThan(everythingBelow);
  });

  it("ranks target specificity variant > model > interface > manufacturer > all", () => {
    expect(targetSpecificity(rule({ targetKind: "size_variant" }))).toBe(4);
    expect(targetSpecificity(rule({ targetKind: "mask_model" }))).toBe(3);
    expect(targetSpecificity(rule({ targetKind: "interface_type" }))).toBe(2);
    expect(targetSpecificity(rule({ targetKind: "manufacturer" }))).toBe(1);
    expect(targetSpecificity(rule({ targetKind: "all" }))).toBe(0);
  });
});

describe("applicability", () => {
  it("never fires a payer-scoped rule when the payer is unknown", () => {
    // We do not deny on an assumption. This is the case that keeps a
    // missing insurance record from silently narrowing someone's options.
    const unknownPayer: FitContext = { ...CONTEXT, payerProfileId: null };
    const denyForPayer = rule({
      payerProfileId: "payer-1",
      effect: "deny",
      reasonCode: "not_contracted",
    });
    expect(ruleApplies(denyForPayer, unknownPayer)).toBe(false);
    expect(resolve([denyForPayer], "open", unknownPayer).allowed).toBe(true);
  });

  it("ignores a rule whose effective window has closed", () => {
    const expired = rule({
      effect: "deny",
      effectiveTo: "2026-01-31",
    });
    expect(resolve([expired]).allowed).toBe(true);
  });

  it("ignores a rule whose effective window has not opened", () => {
    const future = rule({ effect: "deny", effectiveFrom: "2027-01-01" });
    expect(resolve([future]).allowed).toBe(true);
  });
});

describe("allow / deny precedence", () => {
  it("lets a payer-scoped allow punch through an org-wide manufacturer deny", () => {
    const decision = resolve([
      rule({
        id: "org-deny",
        targetKind: "manufacturer",
        targetManufacturer: "Acme",
        effect: "deny",
        reasonCode: "not_stocked",
      }),
      rule({
        id: "payer-allow",
        payerProfileId: "payer-1",
        targetKind: "mask_model",
        targetMaskModelId: "model-1",
        effect: "allow",
      }),
    ]);
    expect(decision.allowed).toBe(true);
  });

  it("resolves an exact tie conservatively — deny beats allow", () => {
    const decision = resolve([
      rule({
        id: "allow",
        targetKind: "mask_model",
        targetMaskModelId: "model-1",
        effect: "allow",
      }),
      rule({
        id: "deny",
        targetKind: "mask_model",
        targetMaskModelId: "model-1",
        effect: "deny",
        reasonCode: "recall",
      }),
    ]);
    expect(decision.allowed).toBe(false);
    expect(decision.deniedByRule).toBe(true);
    expect(decision.denyReasonCode).toBe("recall");
  });

  it("lets a more specific target win inside the same scope tier", () => {
    const decision = resolve([
      rule({
        id: "mfr-deny",
        targetKind: "manufacturer",
        targetManufacturer: "Acme",
        effect: "deny",
      }),
      rule({
        id: "variant-allow",
        targetKind: "size_variant",
        targetSizeVariantId: "variant-1",
        effect: "allow",
      }),
    ]);
    expect(decision.allowed).toBe(true);
  });

  it("denies everything unmatched under a closed posture", () => {
    expect(resolve([], "closed").allowed).toBe(false);
    expect(resolve([], "closed").denyReasonCode).toBe(
      "not_in_closed_formulary",
    );
  });

  it("expresses a whole single-vendor formulary as closed posture plus one allow", () => {
    const allowAcme = rule({
      targetKind: "manufacturer",
      targetManufacturer: "Acme",
      effect: "allow",
    });
    expect(resolve([allowAcme], "closed").allowed).toBe(true);

    const otherMask = { ...MASK, manufacturer: "Other" };
    expect(
      resolveFormulary(
        formulary([allowAcme], "closed"),
        otherMask,
        VARIANT,
        CONTEXT,
      ).allowed,
    ).toBe(false);
  });

  it("allows everything when the tenant has no rules at all", () => {
    expect(resolve([]).allowed).toBe(true);
    expect(resolve([]).preferenceRank).toBeNull();
  });
});

describe("preference", () => {
  it("counts exactly one preference rule, so preference cannot stack", () => {
    const decision = resolve([
      rule({
        id: "p1",
        targetKind: "manufacturer",
        targetManufacturer: "Acme",
        effect: "prefer",
        preferenceRank: 3,
      }),
      rule({
        id: "p2",
        payerProfileId: "payer-1",
        targetKind: "mask_model",
        targetMaskModelId: "model-1",
        effect: "prefer",
        preferenceRank: 1,
      }),
    ]);
    // The payer-scoped, model-targeted rule is strictly more specific.
    expect(decision.preferenceRank).toBe(1);
    expect(formularyMultiplier(decision)).toBeCloseTo(1.1);
  });

  it("lets a deprioritize rule beat a broader prefer rule", () => {
    const decision = resolve([
      rule({
        id: "prefer-broad",
        targetKind: "manufacturer",
        targetManufacturer: "Acme",
        effect: "prefer",
        preferenceRank: 1,
      }),
      rule({
        id: "deprioritize-specific",
        targetKind: "mask_model",
        targetMaskModelId: "model-1",
        effect: "deprioritize",
      }),
    ]);
    expect(decision.deprioritized).toBe(true);
    expect(decision.preferenceRank).toBeNull();
    expect(formularyMultiplier(decision)).toBeLessThan(1);
  });

  it("keeps the multiplier inside its declared bound at every rank", () => {
    for (const rank of [1, 2, 3, 4, 10]) {
      const m = formularyMultiplier({
        allowed: true,
        deniedByRule: false,
        excluded: false,
        denyReasonCode: null,
        denyReasonNote: null,
        preferenceRank: rank,
        deprioritized: false,
        matchedRuleIds: [],
      });
      expect(m).toBeGreaterThanOrEqual(0.9);
      expect(m).toBeLessThanOrEqual(1.1);
    }
  });
});

describe("provenance", () => {
  it("reports every rule that matched, for the fit report", () => {
    const decision = resolve([
      rule({ id: "a", targetKind: "manufacturer", targetManufacturer: "Acme" }),
      rule({
        id: "b",
        targetKind: "mask_model",
        targetMaskModelId: "model-1",
        effect: "prefer",
        preferenceRank: 2,
      }),
    ]);
    expect(decision.matchedRuleIds.sort()).toEqual(["a", "b"]);
  });

  it("keeps a staff-only reason note out of the machine-readable code", () => {
    const decision = resolve([
      rule({
        targetKind: "mask_model",
        targetMaskModelId: "model-1",
        effect: "deny",
        reasonCode: "margin",
        reasonNote: "Low margin — steer to the house brand.",
      }),
    ]);
    expect(decision.denyReasonCode).toBe("margin");
    // The note is carried for staff surfaces; the redaction that keeps it
    // off patient-facing output lives in the report layer.
    expect(decision.denyReasonNote).toContain("house brand");
  });
});

// ── Hard exclusion (migration 0516) ──────────────────────────────────
//
// `exclude` is the effect that HIDES rather than demotes, so the cases
// worth pinning are the boundaries between the two: that a deny never
// becomes a hide, that a hide beats a same-tier deny or allow, and that a
// narrower allow still rescues one model of an otherwise-hidden brand.

describe("exclude vs deny", () => {
  it("hides on exclude and only demotes on deny", () => {
    const hidden = resolve([
      rule({
        targetKind: "manufacturer",
        targetManufacturer: "Acme",
        effect: "exclude",
      }),
    ]);
    expect(hidden.allowed).toBe(false);
    expect(hidden.excluded).toBe(true);

    const demoted = resolve([
      rule({
        targetKind: "manufacturer",
        targetManufacturer: "Acme",
        effect: "deny",
      }),
    ]);
    expect(demoted.allowed).toBe(false);
    // The safety net: a deny must NEVER read as a hide, or the engine
    // starts dropping candidates it is supposed to keep for a clinician.
    expect(demoted.excluded).toBe(false);
  });

  it("leaves a mask nothing targets untouched", () => {
    const decision = resolve([
      rule({
        targetKind: "manufacturer",
        targetManufacturer: "Globex",
        effect: "exclude",
      }),
    ]);
    expect(decision.allowed).toBe(true);
    expect(decision.excluded).toBe(false);
  });

  it("never hides on a closed posture alone", () => {
    // A closed formulary DENIES what it doesn't name. Hiding the entire
    // catalog is not something a posture default may do silently.
    const decision = resolve([], "closed");
    expect(decision.allowed).toBe(false);
    expect(decision.excluded).toBe(false);
    expect(decision.denyReasonCode).toBe("not_in_closed_formulary");
  });

  it("beats an allow and a deny sitting in the same tier", () => {
    const decision = resolve([
      rule({
        id: "a",
        targetKind: "manufacturer",
        targetManufacturer: "Acme",
        effect: "allow",
      }),
      rule({
        id: "d",
        targetKind: "manufacturer",
        targetManufacturer: "Acme",
        effect: "deny",
      }),
      rule({
        id: "x",
        targetKind: "manufacturer",
        targetManufacturer: "Acme",
        effect: "exclude",
      }),
    ]);
    expect(decision.excluded).toBe(true);
    expect(decision.denyReasonCode).toBeNull();
  });

  it("loses to a MORE SPECIFIC allow, so one model of a dropped line survives", () => {
    // "We dropped Acme except the one model we still stock." Target
    // specificity (mask_model 3 > manufacturer 1) is what expresses it.
    const decision = resolve([
      rule({
        id: "brand",
        targetKind: "manufacturer",
        targetManufacturer: "Acme",
        effect: "exclude",
      }),
      rule({
        id: "keep",
        targetKind: "mask_model",
        targetMaskModelId: "model-1",
        effect: "allow",
      }),
    ]);
    expect(decision.allowed).toBe(true);
    expect(decision.excluded).toBe(false);
  });

  it("still applies when a BROADER allow sits below it", () => {
    const decision = resolve([
      rule({ id: "all", targetKind: "all", effect: "allow" }),
      rule({
        id: "brand",
        targetKind: "manufacturer",
        targetManufacturer: "Acme",
        effect: "exclude",
      }),
    ]);
    expect(decision.excluded).toBe(true);
  });

  it("does not fire on an unknown scope axis, exactly as a deny does not", () => {
    // We never hide on an assumption: a payer-scoped exclusion cannot
    // fire when the payer is unknown.
    const decision = resolve([
      rule({
        payerProfileId: "payer-9",
        targetKind: "manufacturer",
        targetManufacturer: "Acme",
        effect: "exclude",
      }),
    ]);
    expect(decision.excluded).toBe(false);
    expect(decision.allowed).toBe(true);
  });

  it("respects the effective-date window", () => {
    const expired = resolve([
      rule({
        targetKind: "manufacturer",
        targetManufacturer: "Acme",
        effect: "exclude",
        effectiveTo: "2020-01-01",
      }),
    ]);
    expect(expired.excluded).toBe(false);
  });
});

describe("resolveCatalogVisibility", () => {
  const OTHER: CatalogMask = {
    ...MASK,
    id: "model-2",
    slug: "globex-mask",
    manufacturer: "Globex",
    modelName: "Globex Mask",
  };
  const SECOND_ACME: CatalogMask = {
    ...MASK,
    id: "model-3",
    slug: "acme-mask-two",
    modelName: "Acme Mask Two",
  };
  const ASOF = CONTEXT.asOf;

  it("hides every mask of an excluded manufacturer, and the brand with them", () => {
    const v = resolveCatalogVisibility(
      formulary([
        rule({
          targetKind: "manufacturer",
          targetManufacturer: "Acme",
          effect: "exclude",
        }),
      ]),
      [MASK, SECOND_ACME, OTHER],
      ASOF,
    );
    expect([...v.hiddenSlugs].sort()).toEqual(["acme-mask", "acme-mask-two"]);
    expect(v.hiddenManufacturers.has("acme")).toBe(true);
    expect(v.hiddenManufacturers.has("globex")).toBe(false);
  });

  it("does not report a brand hidden while one of its models survives", () => {
    // The operator kept something of theirs, so the brand has not been
    // dropped — and a brand-keyed surface (the shop) must not act as if
    // it had.
    const v = resolveCatalogVisibility(
      formulary([
        rule({
          id: "brand",
          targetKind: "manufacturer",
          targetManufacturer: "Acme",
          effect: "exclude",
        }),
        rule({
          id: "keep",
          targetKind: "mask_model",
          targetMaskModelId: "model-1",
          effect: "allow",
        }),
      ]),
      [MASK, SECOND_ACME],
      ASOF,
    );
    expect(v.hiddenSlugs.has("acme-mask")).toBe(false);
    expect(v.hiddenSlugs.has("acme-mask-two")).toBe(true);
    expect(v.hiddenManufacturers.size).toBe(0);
  });

  it("ignores a scoped rule, because this surface has no context to match", () => {
    const v = resolveCatalogVisibility(
      formulary([
        rule({
          locationId: "loc-1",
          targetKind: "manufacturer",
          targetManufacturer: "Acme",
          effect: "exclude",
        }),
      ]),
      [MASK, OTHER],
      ASOF,
    );
    expect(v.hiddenSlugs.size).toBe(0);
    expect(v.hiddenManufacturers.size).toBe(0);
  });

  it("hides nothing for a deny, a preference, or an empty formulary", () => {
    for (const effect of ["deny", "deprioritize"] as const) {
      const v = resolveCatalogVisibility(
        formulary([
          rule({
            targetKind: "manufacturer",
            targetManufacturer: "Acme",
            effect,
          }),
        ]),
        [MASK, OTHER],
        ASOF,
      );
      expect(v.hiddenSlugs.size).toBe(0);
    }
    expect(
      resolveCatalogVisibility(formulary([]), [MASK], ASOF).hiddenSlugs.size,
    ).toBe(0);
  });

  it("does not hide a brand the mask catalog has never heard of", () => {
    // The vacuous-truth trap: a brand with NO masks trivially satisfies
    // "nothing of theirs survived". Without an explicit catalog-membership
    // check, a rule naming a mask-less brand — a typo, a stale rule, or an
    // accessories-only line — would pull that brand's stock off the shop.
    const v = resolveCatalogVisibility(
      formulary([
        rule({
          targetKind: "manufacturer",
          targetManufacturer: "Accessories Only Co",
          effect: "exclude",
        }),
      ]),
      [MASK, OTHER],
      ASOF,
    );
    expect(v.hiddenManufacturers.size).toBe(0);
    expect(isManufacturerHidden(v, "Accessories Only Co")).toBe(false);
    // And the masks that ARE in the catalog are untouched by it.
    expect(v.hiddenSlugs.size).toBe(0);
  });

  it("hides nothing at all when the catalog is empty", () => {
    // Same trap at the limit: an empty catalog makes EVERY exclude rule
    // vacuously satisfied.
    const v = resolveCatalogVisibility(
      formulary([
        rule({
          targetKind: "manufacturer",
          targetManufacturer: "Acme",
          effect: "exclude",
        }),
      ]),
      [],
      ASOF,
    );
    expect(v.hiddenManufacturers.size).toBe(0);
    expect(v.hiddenSlugs.size).toBe(0);
  });

  it("matches a manufacturer case- and whitespace-insensitively", () => {
    const v = resolveCatalogVisibility(
      formulary([
        rule({
          targetKind: "manufacturer",
          targetManufacturer: "Acme",
          effect: "exclude",
        }),
      ]),
      [MASK],
      ASOF,
    );
    expect(isManufacturerHidden(v, "  aCmE ")).toBe(true);
    expect(isManufacturerHidden(v, "Globex")).toBe(false);
    // A product with no manufacturer metadata is never hidden on a guess.
    expect(isManufacturerHidden(v, null)).toBe(false);
  });
});
