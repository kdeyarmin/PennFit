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

  // ── Availability: the highest tier at which any allow/deny exists,
  //    with deny winning inside that tier. ──
  const availabilityRules = applicable.filter(
    (r) => r.effect === "allow" || r.effect === "deny",
  );

  let allowed: boolean;
  let deniedByRule = false;
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
    // Ties resolve conservatively: within one tier, deny beats allow.
    const deny = sameTier.find((r) => r.effect === "deny");
    if (deny) {
      allowed = false;
      deniedByRule = true;
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
