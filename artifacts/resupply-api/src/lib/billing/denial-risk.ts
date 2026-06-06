// Predictive denial-risk scoring for claim preflight (owner/biller #O3).
//
// Closes the loop the deterministic preflight checklist flies blind on:
// turn the historical (payer × HCPCS) denial counts produced by the
// resupply.billing_denial_risk RPC (migration 0228) into non-blocking
// "elevated denial risk" warnings the CSR sees BEFORE submitting — the
// thing the resupply market calls predictive denial scoring ("payer X
// denied 38% of recent E0601 claims").
//
// Pure — no I/O, unit-tested. The preflight engine sources the counts
// from the RPC and feeds them here; this is just the math + copy.
//
// Design guardrails:
//   * Warning-only — NEVER an "error". It can never block a submit the
//     deterministic checklist would have allowed; it only nudges.
//   * Neutral until proven — a (payer, HCPCS) pair needs `minSample`
//     decisioned claims before its rate is trustworthy (default 10).
//   * Thresholded — only surfaces at/above `warnRate` (default 0.20).

import type { PreflightItem } from "./claim-preflight";

/** Trailing window the preflight asks the RPC to aggregate over. */
export const DENIAL_RISK_WINDOW_DAYS = 180;

/** One historical (payer-scoped) denial-rate row for a single HCPCS. */
export interface DenialRiskStat {
  hcpcsCode: string;
  /** Decisioned claims to this payer that carried this HCPCS. */
  decisions: number;
  /** Of those, how many landed denied/appealed. */
  denials: number;
}

export interface DenialRiskOptions {
  /** Minimum decisioned claims before a rate is trustworthy. Default 10. */
  minSample?: number;
  /** Denial rate (0..1) at/above which we warn. Default 0.20. */
  warnRate?: number;
}

/**
 * Pure: map per-HCPCS historical denial stats (already scoped to the
 * claim's payer) to preflight warnings. Returns at most one item per
 * HCPCS, ordered highest-rate first (then HCPCS asc) for a deterministic
 * UI. HCPCS below `minSample` or under `warnRate` are omitted.
 */
export function scoreDenialRiskItems(
  payerName: string,
  stats: ReadonlyArray<DenialRiskStat>,
  opts: DenialRiskOptions = {},
): PreflightItem[] {
  const minSample = opts.minSample ?? 10;
  const warnRate = opts.warnRate ?? 0.2;

  return [...stats]
    .filter((s) => s.decisions >= minSample && s.decisions > 0)
    .map((s) => ({ ...s, rate: s.denials / s.decisions }))
    .filter((s) => s.rate >= warnRate)
    .sort((a, b) => b.rate - a.rate || a.hcpcsCode.localeCompare(b.hcpcsCode))
    .map((s) => {
      const pct = Math.round(s.rate * 100);
      return {
        key: `denial_risk:${s.hcpcsCode}`,
        severity: "warning" as const,
        label: `Elevated denial risk for ${s.hcpcsCode}`,
        detail: `${payerName} denied ${pct}% of recent ${s.hcpcsCode} claims (n=${s.decisions}). Re-check modifiers and documentation before submitting.`,
      };
    });
}
