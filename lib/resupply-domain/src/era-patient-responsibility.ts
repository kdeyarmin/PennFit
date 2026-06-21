// 835 ERA patient-responsibility breakdown — pure CARC bucketing
// (ADR 008: no I/O).
//
// An 835 remittance reports patient cost-share inside the PR (Patient
// Responsibility) CAS adjustment group, itemized by CARC reason code:
//   CARC 1 → deductible, CARC 2 → coinsurance, CARC 3 → copay.
// The payer may itemize at the claim level, the service-line level, or
// both, so we sum across every CAS. Only the three named CARCs are
// bucketed; any other PR reason stays folded into the authoritative
// patient-responsibility total upstream and is intentionally not
// double-counted here.
//
// Factored into the pure domain layer so the ERA reconciler, the
// patient-statement builder, and any "what does the patient owe and why?"
// UI compute the split one tested way.

/** Minimal CAS adjustment shape this rule reads (the ERA parser's row
 *  carries more fields; only these three matter for the split). */
export interface EraAdjustment {
  /** CAS group code — "PR", "CO", "PI", "OA". */
  groupCode: string;
  /** CARC reason code as a string ("1", "2", "3", …). */
  reasonCode: string;
  /** Adjustment amount in integer cents. */
  amountCents: number;
}

/** Claim-shaped input: claim-level CAS plus each service line's CAS. */
export interface EraClaimAdjustments {
  adjustments: EraAdjustment[];
  serviceLines: { adjustments: EraAdjustment[] }[];
}

/** Itemized patient-responsibility components, in cents. */
export interface PatientRespBreakdown {
  deductibleCents: number;
  coinsuranceCents: number;
  copayCents: number;
}

// CARC reason codes inside the PR adjustment group that map to a named
// cost-share bucket.
export const PR_DEDUCTIBLE_CARC = "1";
export const PR_COINSURANCE_CARC = "2";
export const PR_COPAY_CARC = "3";

/**
 * Sum the 835 PR-group CAS adjustments into deductible / coinsurance /
 * copay, across BOTH the claim-level CAS and every service line's CAS.
 * Negative amounts (reversals) are floored at 0 per bucket. Pure + total.
 */
export function patientRespBreakdown(
  eraClaim: EraClaimAdjustments,
): PatientRespBreakdown {
  const all: EraAdjustment[] = [
    ...eraClaim.adjustments,
    ...eraClaim.serviceLines.flatMap((l) => l.adjustments),
  ];
  const sumByReason = (reason: string) =>
    all
      .filter((a) => a.groupCode === "PR" && a.reasonCode === reason)
      .reduce((s, a) => s + Math.max(0, a.amountCents), 0);
  return {
    deductibleCents: sumByReason(PR_DEDUCTIBLE_CARC),
    coinsuranceCents: sumByReason(PR_COINSURANCE_CARC),
    copayCents: sumByReason(PR_COPAY_CARC),
  };
}
