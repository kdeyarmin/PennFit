// Canonical denial-rate definitions, shared by the billing dashboards
// (billing-reports, billing-director, billing-benchmarks) so the
// numerator/denominator can't silently drift between them.
//
//   denominator — a "decision": a claim that has reached a terminal
//     adjudication status (paid / denied / closed / appealed) with its
//     decision_at inside the window.
//   numerator — a "denial": a denied OR appealed claim.
//
// The canonical operational window is 90 days. billing-benchmarks pulls a
// longer 180-day population for its DISTRIBUTION percentiles (stable history),
// but computes the headline denial rate over this same 90-day window so the
// number it shows matches the reports/director dashboards.
//
// The SQL `resupply.billing_denial_rate` RPC (migration 0164) keeps its own
// copy of these two status sets — keep it in sync with this file.

export const DECISIONED_CLAIM_STATUSES = [
  "paid",
  "denied",
  "closed",
  "appealed",
] as const;

export const DENIAL_CLAIM_STATUSES = ["denied", "appealed"] as const;

export const DENIAL_RATE_WINDOW_DAYS = 90;

/** True when a claim status counts as a denial (numerator). */
export function isDenialStatus(status: string): boolean {
  return status === "denied" || status === "appealed";
}

/** ISO cutoff for the canonical 90-day denial-rate window. */
export function denialRateWindowCutoffIso(now: number = Date.now()): string {
  return new Date(
    now - DENIAL_RATE_WINDOW_DAYS * 24 * 3600 * 1000,
  ).toISOString();
}
