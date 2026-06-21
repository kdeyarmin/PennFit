// Payer-modifier rule evaluation.
//
// The pure rules engine now lives in @workspace/resupply-domain (ADR 008)
// so the claim builder, the manual-claim line editor's "what modifiers
// does this payer require?" endpoint, and a future SPA preview share one
// tested source of truth. This module re-exports it so existing importers
// (claim-builder, the payer-modifier-rules route, tests) keep their
// `./modifier-rules` import path unchanged.

import type { Database } from "@workspace/resupply-db";
import type { PayerModifierCondition } from "@workspace/resupply-domain";

export {
  ruleApplies,
  resolveModifiersFromRules,
  buildAbnScope,
  abnCoversHcpcs,
  MODIFIER_CONDITIONS,
} from "@workspace/resupply-domain";
export type {
  PayerModifierCondition,
  ModifierRuleContext,
  ModifierRuleRow,
  AbnScope,
} from "@workspace/resupply-domain";

// Compile-time guard: the domain `PayerModifierCondition` union must stay
// in sync with the DB `payer_modifier_rules.condition` enum (the column is
// the source of truth). If either side adds/removes a value without the
// other, one of these assignments stops type-checking.
type DbCondition =
  Database["resupply"]["Tables"]["payer_modifier_rules"]["Row"]["condition"];
type AssertExtends<A, B> = A extends B ? true : false;
const _dbMatchesDomain: AssertExtends<DbCondition, PayerModifierCondition> =
  true;
const _domainMatchesDb: AssertExtends<PayerModifierCondition, DbCondition> =
  true;
void _dbMatchesDomain;
void _domainMatchesDb;
