// Shop return comfort-guarantee window + auto-approval rules.
//
// The pure policy (windows, the auto-approval decision, the note format)
// now lives in @workspace/resupply-domain (ADR 008) so the storefront SPA
// can show the same "within your guarantee / this will auto-approve" copy
// the API enforces. This module re-exports it so existing importers (the
// returns route, tests) keep their `./auto-approval-rules` import path.

import type { ShopReturnReason } from "@workspace/resupply-db";
import type { ShopReturnReason as DomainShopReturnReason } from "@workspace/resupply-domain";

export {
  COMFORT_GUARANTEE_DAYS,
  isWithinComfortGuarantee,
  evaluateAutoApprovalRules,
  formatAutoApprovalNote,
  AUTO_APPROVE_PRIOR_RETURN_CAP,
  AUTO_APPROVE_DEFECTIVE_MAX_AGE_DAYS,
  AUTO_APPROVE_WRONG_ITEM_MAX_AGE_DAYS,
  AUTO_APPROVE_ORDER_VALUE_CAP_CENTS,
} from "@workspace/resupply-domain";
export type {
  ShopReturnReason,
  AutoApprovalRule,
  AutoApprovalDecision,
  AutoApprovalInput,
} from "@workspace/resupply-domain";

// Compile-time guard: the domain `ShopReturnReason` union must stay in
// sync with the DB enum (the column is the source of truth). If either
// side adds/removes a value without the other, one assignment stops
// type-checking.
type AssertExtends<A, B> = A extends B ? true : false;
const _dbMatchesDomain: AssertExtends<
  ShopReturnReason,
  DomainShopReturnReason
> = true;
const _domainMatchesDb: AssertExtends<
  DomainShopReturnReason,
  ShopReturnReason
> = true;
void _dbMatchesDomain;
void _domainMatchesDb;
