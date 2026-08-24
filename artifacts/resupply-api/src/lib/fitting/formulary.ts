/**
 * Formulary resolution — pure.
 *
 * Answers, for one mask (or one size variant) in one clinical context:
 * is it in this DME's formulary, and how strongly do they prefer it?
 *
 * THE RULE, IN ONE SENTENCE
 * ------------------------
 * The most specific applicable scope wins; within equally-specific scopes
 * the most specific target wins; within an identical tier, deny beats
 * allow.
 *
 * WHY THE OUTPUT IS ADVISORY, NOT A FILTER
 * ----------------------------------------
 * A formulary decision is a PROVIDER-PREFERENCE signal evaluated at tier 5
 * of the recommendation hierarchy — strictly below safety (1), therapy
 * compatibility (2), facial fit (3), and patient characteristics (4). Two
 * structural consequences, both deliberate:
 *
 *   * `resolveFormulary` is only ever called with candidates that already
 *     survived tiers 1-2, so an `allow` or `prefer` can never resurrect a
 *     clinical or safety exclusion. That is enforced by what the caller
 *     passes in, not by a convention someone can forget.
 *   * A `deny` returns `allowed: false` but the ranking pipeline does not
 *     drop the candidate. It demotes and tags it, so that when the
 *     clinical tiers leave only out-of-formulary options the engine still
 *     surfaces the best one — flagged, with the reason — for a clinician
 *     to decide.
 *
 * Together those are the mechanical implementation of "financial margin
 * must never override a clinical or safety exclusion".
 *
 * `deny` VS `exclude` — THE ONE DISTINCTION TO GET RIGHT
 * -----------------------------------------------------
 * `deny` above answers "we would rather not dispense this". It is NOT the
 * answer to "we do not carry this at all", and using it for that was the
 * gap 0516 closed. A provider that has dropped a manufacturer on price
 * does not want a demoted, flagged ResMed mask at the bottom of a
 * patient's list — showing a patient something the provider cannot
 * actually dispense sets an expectation somebody then has to walk back.
 *
 *   deny    — demote and tag.   `allowed: false`, `excluded: false`.
 *                               Ranking keeps it. Safety net intact.
 *   exclude — hard hide.        `allowed: false`, `excluded: true`.
 *                               Dropped from the pool and from every
 *                               patient-facing catalog and search surface.
 *
 * Consumers that FILTER must branch on `excluded`, never on `!allowed`, or
 * a deny quietly becomes a hide and the safety net disappears.
 *
 * The safety posture is unchanged in the direction that matters: `exclude`
 * only ever REMOVES candidates, so it still cannot resurrect anything the
 * clinical tiers threw out. The new failure mode runs the other way —
 * hiding so much that a patient is left with nothing — and that is guarded
 * in the app rather than here: the publish pre-flight and the
 * manufacturer-visibility endpoint both refuse a configuration that
 * empties the synthetic panel, and an empty candidate set still resolves
 * to the existing withheld outcome rather than a blank page.
 */

import type {
  CatalogMask,
  FitContext,
  Formulary,
  FormularyDecision,
  FormularyRule,
  SizeVariant,
} from "./types.js";

/**
 * Scope-axis weights. Powers of two, so the sum over a rule's non-null
 * axes is a unique total ordering rather than a bag of ties.
 *
 * The ranking is a clinical/commercial judgement, not an arbitrary one:
 * a contract term is a legal obligation, so it outranks everything; payer
 * coverage outranks a DME's internal stocking preference; a branch's shelf
 * outranks an org-wide therapy or population default.
 */
const SCOPE_WEIGHTS = {
  contractRef: 16,
  payerProfileId: 8,
  locationId: 4,
  therapyMode: 2,
  serviceLine: 1,
} as const;

const TARGET_SPECIFICITY = {
  size_variant: 4,
  mask_model: 3,
  interface_type: 2,
  manufacturer: 1,
  all: 0,
} as const;

/**
 * Whether `rule` applies in `context`.
 *
 * The important half is the negative case: a rule with a non-null axis does
 * NOT apply when the corresponding context value is unknown. If we do not
 * know the payer, a payer-specific deny does not fire — we never deny on an
 * assumption.
 */
export function ruleApplies(rule: FormularyRule, context: FitContext): boolean {
  if (rule.locationId !== null && rule.locationId !== context.locationId) {
    return false;
  }
  if (
    rule.payerProfileId !== null &&
    rule.payerProfileId !== context.payerProfileId
  ) {
    return false;
  }
  if (rule.contractRef !== null && rule.contractRef !== context.contractRef) {
    return false;
  }
  if (rule.serviceLine !== null && rule.serviceLine !== context.population) {
    return false;
  }
  if (rule.therapyMode !== null && rule.therapyMode !== context.therapyMode) {
    return false;
  }
  if (rule.effectiveFrom !== null && context.asOf < rule.effectiveFrom) {
    return false;
  }
  if (rule.effectiveTo !== null && context.asOf > rule.effectiveTo) {
    return false;
  }
  return true;
}

export function scopeSpecificity(rule: FormularyRule): number {
  let score = 0;
  if (rule.contractRef !== null) score += SCOPE_WEIGHTS.contractRef;
  if (rule.payerProfileId !== null) score += SCOPE_WEIGHTS.payerProfileId;
  if (rule.locationId !== null) score += SCOPE_WEIGHTS.locationId;
  if (rule.therapyMode !== null) score += SCOPE_WEIGHTS.therapyMode;
  if (rule.serviceLine !== null) score += SCOPE_WEIGHTS.serviceLine;
  return score;
}

export function targetSpecificity(rule: FormularyRule): number {
  return TARGET_SPECIFICITY[rule.targetKind];
}

/** Whether `rule`'s target names this mask (optionally this variant). */
export function ruleTargets(
  rule: FormularyRule,
  mask: CatalogMask,
  variant: SizeVariant | null,
): boolean {
  switch (rule.targetKind) {
    case "all":
      return true;
    case "manufacturer":
      return rule.targetManufacturer === mask.manufacturer;
    case "interface_type":
      return rule.targetInterfaceType === mask.interfaceType;
    case "mask_model":
      return rule.targetMaskModelId === mask.id;
    case "size_variant":
      return variant !== null && rule.targetSizeVariantId === variant.id;
    default:
      return false;
  }
}

/**
 * Rank two applicable rules. Higher wins: scope specificity first, then
 * target specificity, then most recently created.
 */
function compareRules(a: FormularyRule, b: FormularyRule): number {
  const scope = scopeSpecificity(b) - scopeSpecificity(a);
  if (scope !== 0) return scope;
  const target = targetSpecificity(b) - targetSpecificity(a);
  if (target !== 0) return target;
  return b.createdAt.localeCompare(a.createdAt);
}

const NEUTRAL_ALLOW: FormularyDecision = {
  allowed: true,
  deniedByRule: false,
  excluded: false,
  denyReasonCode: null,
  denyReasonNote: null,
  preferenceRank: null,
  deprioritized: false,
  matchedRuleIds: [],
};

/**
 * Resolve one candidate against the formulary.
 *
 * Fails OPEN: a formulary with no rules, or a tenant with no formulary at
 * all, allows everything with no preference. That matches
 * `resolveTenantProductScope`'s posture — a misconfigured tenant still gets
 * clinically valid recommendations, just unshaped — and it is what keeps
 * every pre-formulary tenant's behaviour identical after this ships.
 */
export function resolveFormulary(
  formulary: Formulary,
  mask: CatalogMask,
  variant: SizeVariant | null,
  context: FitContext,
): FormularyDecision {
  const applicable = formulary.rules.filter(
    (rule) => ruleApplies(rule, context) && ruleTargets(rule, mask, variant),
  );

  if (applicable.length === 0) {
    return formulary.defaultPosture === "closed"
      ? {
          ...NEUTRAL_ALLOW,
          allowed: false,
          denyReasonCode: "not_in_closed_formulary",
        }
      : NEUTRAL_ALLOW;
  }

  const matchedRuleIds = applicable.map((r) => r.id);

  // ── Availability: the highest tier at which any allow/deny/exclude
  //    exists, with exclude beating deny beating allow inside that tier. ──
  const availabilityRules = applicable.filter(
    (r) =>
      r.effect === "allow" || r.effect === "deny" || r.effect === "exclude",
  );

  let allowed: boolean;
  let deniedByRule = false;
  let excluded = false;
  let denyReasonCode: string | null = null;
  let denyReasonNote: string | null = null;

  if (availabilityRules.length === 0) {
    allowed = formulary.defaultPosture !== "closed";
    if (!allowed) denyReasonCode = "not_in_closed_formulary";
  } else {
    const sorted = [...availabilityRules].sort(compareRules);
    const top = sorted[0]!;
    const topScope = scopeSpecificity(top);
    const topTarget = targetSpecificity(top);
    const sameTier = sorted.filter(
      (r) =>
        scopeSpecificity(r) === topScope && targetSpecificity(r) === topTarget,
    );
    // Ties resolve conservatively: within one tier, the strongest negative
    // wins — exclude, then deny, then allow. A MORE SPECIFIC allow still
    // beats a broader exclude, because it lands in a higher tier and this
    // block never sees the broader rule; that is what makes
    // "exclude manufacturer=ResMed" + "allow mask_model=AirFit F20" read as
    // "we dropped ResMed except for the one model we still stock".
    const exclude = sameTier.find((r) => r.effect === "exclude");
    const deny = exclude ?? sameTier.find((r) => r.effect === "deny");
    if (deny) {
      allowed = false;
      deniedByRule = true;
      excluded = exclude !== undefined;
      denyReasonCode = deny.reasonCode;
      denyReasonNote = deny.reasonNote;
    } else {
      allowed = true;
    }
  }

  // ── Preference: exactly ONE rule contributes, so preference can never
  //    compound past its bound. ──
  const preferenceRules = applicable.filter(
    (r) => r.effect === "prefer" || r.effect === "deprioritize",
  );
  let preferenceRank: number | null = null;
  let deprioritized = false;
  if (preferenceRules.length > 0) {
    const top = [...preferenceRules].sort(compareRules)[0]!;
    if (top.effect === "prefer") {
      preferenceRank = top.preferenceRank;
    } else {
      deprioritized = true;
    }
  }

  return {
    allowed,
    deniedByRule,
    excluded,
    denyReasonCode,
    denyReasonNote,
    preferenceRank,
    deprioritized,
    matchedRuleIds,
  };
}

/**
 * Bounded ranking multiplier for a formulary decision.
 *
 * The bound is the point. Preference shifts near-ties inside a +/-10%
 * window; it cannot promote a mask past one with a meaningfully better
 * clinical score, and it is excluded from the patient-facing confidence
 * entirely (see `confidence.ts`).
 */
export const FORMULARY_MULTIPLIER_BOUNDS = { min: 0.9, max: 1.1 } as const;

export function formularyMultiplier(decision: FormularyDecision): number {
  if (!decision.allowed) return FORMULARY_MULTIPLIER_BOUNDS.min;
  if (decision.deprioritized) return 0.95;
  if (decision.preferenceRank === null) return 1;
  // rank 1 -> 1.10, rank 2 -> 1.07, rank 3 -> 1.05, rank >=4 -> 1.03
  const byRank = [1.1, 1.07, 1.05, 1.03];
  const idx = Math.min(Math.max(decision.preferenceRank, 1), byRank.length) - 1;
  return byRank[idx]!;
}

/** An empty, fully permissive formulary. Used as the degraded fallback. */
export const OPEN_FORMULARY: Formulary = {
  id: null,
  name: "Unrestricted",
  version: 0,
  defaultPosture: "open",
  rules: [],
};

// ── Context-free visibility ──────────────────────────────────────────
//
// The fitting path resolves the formulary per candidate with a full
// clinical context (location, payer, contract, population, therapy mode).
// The other mask-facing surfaces have none of that: the public catalog
// endpoint, the legacy `/api/masks` list, the storefront assistant, the
// shop. They still have to honour "we do not carry ResMed", so they need
// an answer without a context to resolve against.
//
// The rule is the same one `ruleApplies` already enforces, taken to its
// conclusion: a rule with a non-null scope axis does not apply when that
// context value is unknown. On a surface where EVERY axis is unknown, only
// a fully unscoped rule can fire. So these surfaces see exactly the
// org-wide, always-on rules — which is precisely what the manufacturer
// visibility toggle writes — and a location- or payer-scoped exclusion
// stays where it can actually be evaluated. Under-hiding on a surface that
// cannot know the context is the safe direction: showing a mask the
// provider does carry is a smaller harm than hiding one it does.

/**
 * Whether a rule can be honestly evaluated given what this surface knows.
 *
 * An axis the caller KNOWS may be matched against; an axis it does not know
 * must be null on the rule, exactly as `ruleApplies` treats an unknown
 * context value. So a surface that knows nothing sees only fully unscoped
 * rules, and one that knows the location and payer (the fitter's catalog
 * endpoint, which has them from the invite) also sees rules scoped to
 * those — which is what keeps that endpoint's answer consistent with the
 * assessment run from the same invite.
 */
function isResolvableHere(rule: FormularyRule, known: KnownScope): boolean {
  // Never known on any of these surfaces.
  if (rule.contractRef !== null) return false;
  if (rule.serviceLine !== null) return false;
  if (rule.therapyMode !== null) return false;
  if (
    rule.locationId !== null &&
    rule.locationId !== (known.locationId ?? null)
  ) {
    return false;
  }
  if (
    rule.payerProfileId !== null &&
    rule.payerProfileId !== (known.payerProfileId ?? null)
  ) {
    return false;
  }
  return true;
}

/** Scope axes a caller can supply when it genuinely knows them. */
export interface KnownScope {
  locationId?: string | null;
  payerProfileId?: string | null;
}

export interface CatalogVisibility {
  /**
   * Slugs the provider does not carry. Resolved through the SAME
   * `resolveFormulary` precedence as the fitting path, so a narrower
   * `allow` (one model of an otherwise-excluded manufacturer) keeps that
   * model visible here too.
   */
  hiddenSlugs: Set<string>;
  /**
   * Manufacturer names, lowercased, that have nothing visible left.
   *
   * For surfaces keyed on a brand rather than a catalog slug — the Stripe
   * shop, whose products carry `metadata.manufacturer`. A manufacturer
   * with even one still-visible mask is NOT listed: the operator kept
   * something of theirs, so the brand has not been dropped.
   */
  hiddenManufacturers: Set<string>;
}

export const NO_HIDDEN_CATALOG: CatalogVisibility = {
  hiddenSlugs: new Set<string>(),
  hiddenManufacturers: new Set<string>(),
};

/**
 * What this tenant hides on surfaces with no clinical context.
 *
 * @param asOf - ISO date the effective-date windows are evaluated against.
 *   Injected rather than read from the clock, like every other date in the
 *   engine, so the result is a pure function of its inputs.
 * @param known - Scope axes the caller genuinely knows. Omit on a surface
 *   with no context (the shop, `/api/masks`, the assistant); pass the
 *   invite's location/payer on the fitter's catalog endpoint so it agrees
 *   with the assessment run from the same invite.
 */
export function resolveCatalogVisibility(
  formulary: Formulary,
  catalog: CatalogMask[],
  asOf: string,
  known: KnownScope = {},
): CatalogVisibility {
  const rules = formulary.rules.filter((r) => isResolvableHere(r, known));
  if (rules.length === 0) return NO_HIDDEN_CATALOG;

  // Every remaining rule is null on service line and therapy mode, so the
  // values below are inert; location and payer carry whatever the caller
  // actually knows, so scope specificity ranks correctly against them.
  const context: FitContext = {
    locationId: known.locationId ?? null,
    payerProfileId: known.payerProfileId ?? null,
    contractRef: null,
    population: "adult",
    therapyMode: "pap",
    asOf,
  };
  // `defaultPosture` is carried through unchanged. A `closed` posture
  // DENIES (demotes) rather than excludes, so it correctly contributes
  // nothing here — hiding the entire catalog is never something a posture
  // default should do silently.
  const unscoped: Formulary = { ...formulary, rules };

  // What the operator named EXPLICITLY in an exclude. This is how brand
  // intent is told apart from a brand that merely ended up empty: an
  // `interface_type` exclusion ("we don't do full face") can zero out a
  // vendor that only makes full-face masks, and pulling that vendor's
  // tubing off the shop would be an expensive thing to infer from a
  // rule about mask shapes.
  const brandNamed = new Set<string>();
  const modelNamed = new Set<string>();
  for (const rule of rules) {
    if (rule.effect !== "exclude" || !ruleApplies(rule, context)) continue;
    if (rule.targetKind === "manufacturer" && rule.targetManufacturer) {
      brandNamed.add(rule.targetManufacturer.trim().toLowerCase());
    } else if (rule.targetKind === "mask_model" && rule.targetMaskModelId) {
      modelNamed.add(rule.targetMaskModelId);
    }
  }

  const hiddenSlugs = new Set<string>();
  // Keyed by manufacturer, so a brand only ever appears here when the
  // catalog actually has masks by it — which is what stops a brand with NO
  // masks (a typo, a stale rule, an accessories-only line) from satisfying
  // "nothing of theirs survived" vacuously.
  const byManufacturer = new Map<
    string,
    { visible: number; everyModelNamed: boolean }
  >();
  for (const mask of catalog) {
    const key = mask.manufacturer.trim().toLowerCase();
    const excluded = resolveFormulary(unscoped, mask, null, context).excluded;
    if (excluded) hiddenSlugs.add(mask.slug);
    const entry = byManufacturer.get(key) ?? {
      visible: 0,
      everyModelNamed: true,
    };
    if (!excluded) entry.visible += 1;
    if (!modelNamed.has(mask.id)) entry.everyModelNamed = false;
    byManufacturer.set(key, entry);
  }

  const hiddenManufacturers = new Set<string>();
  for (const [name, entry] of byManufacturer) {
    // Something of theirs is still dispensable — the line was not dropped.
    if (entry.visible > 0) continue;
    // Empty AND deliberate. The operator either named the brand, or named
    // every one of its models one at a time; both are "we dropped this
    // vendor" said out loud. A brand emptied by a broader category rule
    // reaches neither, and keeps its shop listing.
    if (!brandNamed.has(name) && !entry.everyModelNamed) continue;
    hiddenManufacturers.add(name);
  }

  return { hiddenSlugs, hiddenManufacturers };
}

/** Whether `manufacturer` is hidden. Trim/case-insensitive. */
export function isManufacturerHidden(
  visibility: CatalogVisibility,
  manufacturer: string | null | undefined,
): boolean {
  if (!manufacturer) return false;
  return visibility.hiddenManufacturers.has(manufacturer.trim().toLowerCase());
}
