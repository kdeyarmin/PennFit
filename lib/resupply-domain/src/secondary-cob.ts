// Secondary / coordination-of-benefits COB math — pure value logic
// (ADR 008: no I/O, no Supabase/pg, defensive clamps on every cents field).
//
// What this is
// ------------
// When a primary payer adjudicates a claim it leaves a balance — the
// patient-responsibility amount the secondary payer may cover. Rolling that
// balance to the secondary means creating a NEW 'secondary' claim carrying a
// SNAPSHOT of the primary's adjudication (paid / contractual / patient
// responsibility) for the 837 2320/2330 COB loop.
//
// This module owns the PURE arithmetic + eligibility gating only:
//
//   * deriveSecondaryCob   — from one primary's adjudicated totals, decide
//                            whether a secondary is warranted and, if so,
//                            compute the COB amounts.
//   * filterSecondaryEligible — rank a list of candidate primaries to those
//                            eligible AND not already carrying a secondary.
//
// Slice 1 handles the canonical case: the primary reached an adjudicated
// paid state (`paid` or `partially_paid`) and left a patient-responsibility
// balance. Denied-primary COB (full balance forwarded) is a follow-up.
//
// Why it lives in @workspace/resupply-domain
// -------------------------------------------
// The DB-touching claim-row builder (`generateSecondaryClaimDraft`) stays in
// the API's `secondary-claim-generator.ts` and imports these helpers. Keeping
// the math here (ADR 008) means the auto-workflow engine, the manual biller
// route, AND the SPA all compute COB the one tested way. Local interfaces
// only — never a DB row type. PHI posture: money + ids only, never patient
// detail.

/**
 * The adjudicated totals the COB math reads off a primary claim — a LOCAL
 * projection, not a DB row type. All cents fields are clamped defensively
 * (a stray negative from upstream never produces a negative COB amount).
 */
export interface PrimaryClaimTotals {
  status: string;
  payer_sequence?: string | null;
  total_billed_cents: number;
  total_allowed_cents: number;
  total_paid_cents: number;
  patient_responsibility_cents: number;
  secondary_coverage_id: string | null;
}

export interface SecondaryCob {
  primaryPaidCents: number;
  contractualCents: number;
  patientRespCents: number;
  /** What the primary left for the secondary to consider. */
  billableToSecondaryCents: number;
}

export type CobIneligibleReason =
  | "not_primary"
  | "no_secondary_coverage"
  | "primary_not_paid"
  | "no_balance";

export type CobDerivation =
  | { eligible: true; cob: SecondaryCob }
  | { eligible: false; reason: CobIneligibleReason };

/**
 * Pure: derive the COB amounts a secondary claim needs from the primary's
 * adjudicated totals. Slice 1 handles the canonical case — the primary
 * PAID part of the claim and left a patient-responsibility balance the
 * secondary may cover. Denied-primary COB (full balance forwarded) is a
 * follow-up. No I/O — unit-tested directly.
 */
export function deriveSecondaryCob(p: PrimaryClaimTotals): CobDerivation {
  if ((p.payer_sequence ?? "primary") !== "primary") {
    return { eligible: false, reason: "not_primary" };
  }
  if (!p.secondary_coverage_id) {
    return { eligible: false, reason: "no_secondary_coverage" };
  }
  // ERA outcomes after migration 0430 are often `partially_paid` (paid <
  // allowed / PR balance remaining). The secondary worklist and auto-
  // workflow already select both statuses — reject only when the primary
  // has not reached an adjudicated paid state at all.
  if (p.status !== "paid" && p.status !== "partially_paid") {
    return { eligible: false, reason: "primary_not_paid" };
  }
  const contractualCents = Math.max(
    0,
    p.total_billed_cents - p.total_allowed_cents,
  );
  const patientRespCents = Math.max(0, p.patient_responsibility_cents);
  if (patientRespCents <= 0) {
    return { eligible: false, reason: "no_balance" };
  }
  return {
    eligible: true,
    cob: {
      // Clamp like every other cents field: a stray negative paid amount
      // upstream must not emit a negative COB value.
      primaryPaidCents: Math.max(0, p.total_paid_cents),
      contractualCents,
      patientRespCents,
      billableToSecondaryCents: patientRespCents,
    },
  };
}

/**
 * One candidate primary claim the COB worklist may roll to a secondary — a
 * LOCAL projection, not a DB row type.
 */
export interface EligibleCandidate {
  id: string;
  patient_id: string;
  payer_name: string;
  total_billed_cents: number;
  total_paid_cents: number;
  patient_responsibility_cents: number;
  status: string;
  payer_sequence?: string | null;
  secondary_coverage_id: string | null;
  total_allowed_cents: number;
}

export interface EligibleItem {
  claimId: string;
  patientId: string;
  primaryPayerName: string;
  billedCents: number;
  primaryPaidCents: number;
  patientResponsibilityCents: number;
}

/**
 * Pure: filter the candidate primaries to those eligible for a secondary
 * claim AND not already having one. `existingSecondaryPrimaryIds` is the
 * set of primary-claim ids that already spawned a secondary. Sorted biggest
 * outstanding balance first — most recoverable.
 */
export function filterSecondaryEligible(
  candidates: EligibleCandidate[],
  existingSecondaryPrimaryIds: ReadonlySet<string>,
): EligibleItem[] {
  const out: EligibleItem[] = [];
  for (const c of candidates) {
    if (existingSecondaryPrimaryIds.has(c.id)) continue;
    const d = deriveSecondaryCob(c);
    if (!d.eligible) continue;
    out.push({
      claimId: c.id,
      patientId: c.patient_id,
      primaryPayerName: c.payer_name,
      billedCents: c.total_billed_cents,
      primaryPaidCents: d.cob.primaryPaidCents,
      patientResponsibilityCents: d.cob.patientRespCents,
    });
  }
  // Biggest outstanding balance first — most recoverable.
  return out.sort(
    (a, b) => b.patientResponsibilityCents - a.patientResponsibilityCents,
  );
}
