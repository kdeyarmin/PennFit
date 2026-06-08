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

import {
  getCachedEligibility,
  verifyEligibility,
} from "./eligibility-verifier";

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

export interface CoverageGateResult {
  block: CoverageBlock | null;
  /** True when a fresh real-time 270 was run because the cache was stale. */
  refreshed: boolean;
}

/**
 * Like `consultCoverageEligibilityForCoverage`, but when the cache is
 * stale/missing AND `refreshIfStale` is set, runs a fresh 270 first
 * (`verifyEligibility`) and decides on the result.
 *
 * IMPORTANT: the caller must only set `refreshIfStale` when the real-time
 * service is actually configured. Without it `verifyEligibility` falls
 * back to an SFTP 270, which produces no inline answer (the re-read still
 * misses) — so we'd pay a useless SFTP submission per coverage. Callers
 * resolve `clearinghouse.realtimeConfig` first and pass that through.
 */
export async function gateCoverageEligibility(
  coverageId: string,
  patientId: string,
  payerName: string,
  opts: {
    refreshIfStale: boolean;
    requestedByEmail: string;
    freshnessMs?: number;
  },
): Promise<CoverageGateResult> {
  const freshnessMs = opts.freshnessMs ?? COVERAGE_FRESHNESS_MS;
  let cached = await getCachedEligibility(coverageId, freshnessMs);
  let refreshed = false;
  if (!cached && opts.refreshIfStale) {
    await verifyEligibility({
      insuranceCoverageId: coverageId,
      patientId,
      requestedByEmail: opts.requestedByEmail,
    });
    refreshed = true;
    cached = await getCachedEligibility(coverageId, freshnessMs);
  }
  return { block: decideCoverageBlock(cached, payerName), refreshed };
}
