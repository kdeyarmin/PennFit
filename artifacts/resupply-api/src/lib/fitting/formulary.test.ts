// Formulary resolution precedence.
//
// Multi-axis precedence is the part of this feature a human operator
// cannot hold in their head, so it is specified as a table here: one case
// per rule of the algorithm, each named after the behaviour it pins.

import { describe, expect, it } from "vitest";

import {
  formularyMultiplier,
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
