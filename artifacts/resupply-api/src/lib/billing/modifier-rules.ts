// Pure payer-modifier rule evaluation.
//
// Extracted from claim-builder.ts so the same resolution logic backs
// both (a) automatic modifier attachment when a claim is built from a
// fulfillment and (b) the read-only "what modifiers does this payer
// require for this HCPCS?" endpoint the manual-claim line editor calls
// to pre-fill modifiers (so a hand-keyed/corrected claim isn't missing
// the KX/KH/KI rotation that drives a clean first pass).
//
// No I/O — the caller fetches the rule rows; this module decides which
// apply and merges their modifiers. Unit-tested directly.

import type { Database } from "@workspace/resupply-db";

export type PayerModifierCondition =
  Database["resupply"]["Tables"]["payer_modifier_rules"]["Row"]["condition"];

export interface ModifierRuleContext {
  /** Capped-rental month (1..13) if known, else null. */
  rentalMonth: number | null;
  isPurchased: boolean;
  isCompliant: boolean;
  isInitialDispense: boolean;
  hasPriorAuth: boolean;
}

export interface ModifierRuleRow {
  condition: PayerModifierCondition;
  modifiers_csv: string;
  priority?: number | null;
}

/** Whether a single rule's condition holds for the given context. */
export function ruleApplies(
  condition: PayerModifierCondition,
  ctx: ModifierRuleContext,
): boolean {
  switch (condition) {
    case "always":
      return true;
    case "if_rental_month_le_3":
      return ctx.rentalMonth !== null && ctx.rentalMonth <= 3;
    case "if_rental_month_ge_4":
      return ctx.rentalMonth !== null && ctx.rentalMonth >= 4;
    case "if_purchased":
      return ctx.isPurchased;
    case "if_compliant_90day":
      return ctx.isCompliant;
    case "if_initial_dispense":
      return ctx.isInitialDispense;
    case "if_abn_on_file":
      // ABN status isn't modelled today — surface as false so the rule
      // is opt-in once the data is wired.
      return false;
    case "if_pa_approved":
      return ctx.hasPriorAuth;
  }
}

/**
 * Resolve the merged modifier list from a set of payer modifier rules
 * given a context. Rules are evaluated in priority order (ascending);
 * each applicable rule contributes its 2-char modifiers, deduped in
 * first-seen order. The DB query already orders by priority, but we sort
 * defensively so callers passing unsorted rows get a stable result.
 */
export function resolveModifiersFromRules(
  rules: readonly ModifierRuleRow[],
  ctx: ModifierRuleContext,
): string[] {
  const sorted = [...rules].sort(
    (a, b) => (a.priority ?? 0) - (b.priority ?? 0),
  );
  const mods: string[] = [];
  for (const rule of sorted) {
    if (!ruleApplies(rule.condition, ctx)) continue;
    const parsed = rule.modifiers_csv
      .split(",")
      .map((m) => m.trim().toUpperCase())
      .filter((m) => m.length === 2);
    for (const m of parsed) if (!mods.includes(m)) mods.push(m);
  }
  return mods;
}
