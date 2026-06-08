// Shared coverage-eligibility decision — the single source of truth for
// every "check eligibility before X" gate (resupply order-confirm, claim
// batch submit, …). Centralizing the decision matrix + freshness window
// here keeps all the gates behaving identically and lets new integration
// points reuse one helper instead of re-deriving the rules.
//
// FAIL-OPEN by construction: a `CoverageBlock` is returned ONLY on an
// explicit negative signal from a recent parsed 271 (`is_active === false`
// or `requires_prior_auth === true`). A missing/stale result, a null
// field, or anything positive returns null → no opinion → the action
// proceeds. We never strand a legitimate order/claim on our own
// eligibility plumbing.

import { getCachedEligibility } from "./eligibility-verifier";

/** A 271-derived reason to hold an order/claim for CSR review. */
export interface CoverageBlock {
  reason: "inactive" | "prior_auth_required";
  payerName: string;
  /** The eligibility_checks row that produced the signal. */
  eligibilityCheckId: string;
}

/**
 * Cached 270/271 older than this is ignored (treated as "no opinion").
 * 45 days balances "recent enough to trust" against how often eligibility
 * is actually re-run today.
 */
export const COVERAGE_FRESHNESS_MS = 45 * 24 * 60 * 60 * 1000;

/**
 * Pure coverage decision from a parsed 271 row. Exported for unit testing
 * the matrix independently of the DB read. Returns a `CoverageBlock` ONLY
 * on an explicit negative; null otherwise (fail open).
 */
export function decideCoverageBlock(
  elig: {
    id: string;
    is_active: boolean | null;
    requires_prior_auth: boolean | null;
  } | null,
  payerName: string,
): CoverageBlock | null {
  if (!elig) return null;
  if (elig.is_active === false) {
    return { reason: "inactive", payerName, eligibilityCheckId: elig.id };
  }
  if (elig.requires_prior_auth === true) {
    return {
      reason: "prior_auth_required",
      payerName,
      eligibilityCheckId: elig.id,
    };
  }
  return null;
}

/**
 * Consult the most recent parsed 270/271 for a SPECIFIC coverage and
 * decide whether it blocks. Returns null (no opinion) when there's no
 * fresh parsed result. A thrown DB error propagates to the caller's
 * fail-open catch.
 */
export async function consultCoverageEligibilityForCoverage(
  coverageId: string,
  payerName: string,
  freshnessMs: number = COVERAGE_FRESHNESS_MS,
): Promise<CoverageBlock | null> {
  const elig = await getCachedEligibility(coverageId, freshnessMs);
  return decideCoverageBlock(elig, payerName);
}
