// Secondary / coordination-of-benefits claim generation.
//
// Shared by:
//   * the manual biller route (POST /admin/claims/:id/generate-secondary),
//     which maps the result to an HTTP status, and
//   * the auto-workflow engine's secondary-claim pass, which drafts
//     secondaries automatically when the primary 835 posts (gated behind
//     the `billing.auto_secondary_claims` feature flag).
//
// Rolling the balance the primary payer left to the secondary means
// creating a NEW 'secondary' claim (same services / line items) carrying a
// SNAPSHOT of the primary's adjudication (paid / contractual / patient
// responsibility) for the 837 2320/2330 COB loop. The new claim lands in
// 'draft' — a human reviews + submits through the normal batch path; we
// never auto-SUBMIT a secondary.
//
// The COB math (`deriveSecondaryCob`) is pure and unit-tested. PHI posture:
// money + ids only — never patient detail.

import type { OrgScopedClient } from "@workspace/resupply-db";
import {
  deriveSecondaryCob,
  filterSecondaryEligible,
  type CobDerivation,
  type CobIneligibleReason,
  type EligibleCandidate,
  type EligibleItem,
  type PrimaryClaimTotals,
  type SecondaryCob,
} from "@workspace/resupply-domain";

// The pure COB math (`deriveSecondaryCob` / `filterSecondaryEligible`) +
// its value types now live in @workspace/resupply-domain (ADR 008). Re-export
// the locally-imported bindings so existing importers — including
// routes/admin/secondary-claims.ts, which re-exports them in turn — keep
// their `./secondary-claim-generator` import path unchanged. The
// DB-touching claim-row builder below imports `deriveSecondaryCob` directly.
// Values and types are split into separate clauses (a `type` modifier inside
// a value `export {}` can make some transpilers elide the whole clause as
// type-only, dropping the runtime binding).
export { deriveSecondaryCob, filterSecondaryEligible };
export type {
  CobDerivation,
  CobIneligibleReason,
  EligibleCandidate,
  EligibleItem,
  PrimaryClaimTotals,
  SecondaryCob,
};

type SupabaseClient = OrgScopedClient;

export const SECONDARY_CLAIM_SELECT =
  "id, patient_id, payer_name, status, payer_sequence, secondary_coverage_id, " +
  "total_billed_cents, total_allowed_cents, total_paid_cents, patient_responsibility_cents, " +
  "date_of_service, fulfillment_id";

export type GenerateSecondaryResult =
  | {
      status: "created";
      secondaryClaimId: string;
      cob: SecondaryCob;
      lineCount: number;
    }
  | { status: "exists"; secondaryClaimId: string | null }
  | { status: "not_eligible"; reason: CobIneligibleReason }
  | { status: "not_found" }
  | { status: "query_failed"; message: string }
  | { status: "create_failed" }
  | { status: "line_copy_failed"; secondaryClaimId: string; message: string };

/**
 * Create the draft secondary claim for a paid primary, snapshotting the
 * COB amounts and copying the line items. Idempotent: a primary that
 * already spawned a secondary returns `{ status: "exists" }` (the unique
 * constraint `insurance_claims_secondary_per_primary_unique` from migration
 * 0304 also guards the concurrent-generate race). Performs no HTTP / audit
 * side effects — the caller owns logging + status mapping.
 */
export async function generateSecondaryClaimDraft(
  supabase: SupabaseClient,
  primaryId: string,
): Promise<GenerateSecondaryResult> {
  const primaryRes = await supabase
    .from("insurance_claims")
    .select(SECONDARY_CLAIM_SELECT)
    .eq("id", primaryId)
    .maybeSingle();
  if (primaryRes.error) {
    return { status: "query_failed", message: primaryRes.error.message };
  }
  if (!primaryRes.data) {
    return { status: "not_found" };
  }
  const primary = primaryRes.data as unknown as PrimaryClaimTotals & {
    patient_id: string;
    secondary_coverage_id: string | null;
    date_of_service: string;
    fulfillment_id: string | null;
  };

  const derivation = deriveSecondaryCob(primary);
  if (!derivation.eligible) {
    return { status: "not_eligible", reason: derivation.reason };
  }
  const { cob } = derivation;

  // Already generated?
  const dupRes = await supabase
    .from("insurance_claims")
    .select("id")
    .eq("payer_sequence", "secondary")
    .eq("primary_claim_id", primaryId)
    .maybeSingle();
  if (dupRes.error) {
    return { status: "query_failed", message: dupRes.error.message };
  }
  if (dupRes.data) {
    return {
      status: "exists",
      secondaryClaimId: (dupRes.data as { id: string }).id,
    };
  }

  // Resolve the secondary payer name.
  const covRes = await supabase
    .from("insurance_coverages")
    .select("payer_name")
    .eq("id", primary.secondary_coverage_id ?? "")
    .maybeSingle();
  if (covRes.error) {
    return { status: "query_failed", message: covRes.error.message };
  }
  const secondaryPayerName =
    (covRes.data as { payer_name?: string | null } | null)?.payer_name ??
    "Secondary payer";

  // Resolve the SECONDARY payer's profile so the claim can be batch-
  // submitted (executeOfficeAllyBatchSubmit requires a payer_profile_id).
  // Best-effort by name — null if the payer has no profile yet, in which
  // case the biller sets it before submission. The primary's
  // payer_profile_id would be WRONG here (that's the primary payer).
  let secondaryPayerProfileId: string | null = null;
  if (covRes.data) {
    const escaped = secondaryPayerName.replace(
      /[\\%_]/g,
      (c: string) => `\\${c}`,
    );
    const profRes = await supabase
      .from("payer_profiles")
      .select("id")
      .ilike("display_name", escaped)
      .eq("is_active", true)
      .limit(1)
      .maybeSingle();
    secondaryPayerProfileId =
      (profRes.data as { id?: string } | null)?.id ?? null;
  }

  // Create the secondary claim header (snapshot the COB amounts).
  const insRes = await supabase
    .from("insurance_claims")
    .insert({
      patient_id: primary.patient_id,
      insurance_coverage_id: primary.secondary_coverage_id,
      payer_name: secondaryPayerName,
      payer_profile_id: secondaryPayerProfileId,
      date_of_service: primary.date_of_service,
      fulfillment_id: primary.fulfillment_id,
      status: "draft",
      total_billed_cents: primary.total_billed_cents,
      payer_sequence: "secondary",
      primary_claim_id: primaryId,
      entry_source: "adjustment",
      claim_frequency_code: "1",
      cob_primary_paid_cents: cob.primaryPaidCents,
      cob_contractual_cents: cob.contractualCents,
      cob_patient_resp_cents: cob.patientRespCents,
    } as unknown as Record<string, unknown>)
    .select("id")
    .maybeSingle();
  if (insRes.error || !insRes.data) {
    // 23505 on insurance_claims_secondary_per_primary_unique
    // (migration 0304): a concurrent generate won the race between
    // our SELECT dedupe and this INSERT. Surface "exists" instead of a
    // hard failure — the secondary exists either way.
    if (insRes.error?.code === "23505") {
      const winner = await supabase
        .from("insurance_claims")
        .select("id")
        .eq("payer_sequence", "secondary")
        .eq("primary_claim_id", primaryId)
        .maybeSingle();
      return {
        status: "exists",
        secondaryClaimId: (winner.data as { id: string } | null)?.id ?? null,
      };
    }
    return { status: "create_failed" };
  }
  const secondaryClaimId = (insRes.data as { id: string }).id;

  // Copy the line items so the secondary is a complete, submittable claim.
  const linesRes = await supabase
    .from("insurance_claim_line_items")
    .select("hcpcs_code, modifier, description, quantity, billed_cents")
    .eq("claim_id", primaryId);
  if (linesRes.error) {
    return {
      status: "line_copy_failed",
      secondaryClaimId,
      message: linesRes.error.message,
    };
  }
  const lines = (linesRes.data ?? []) as Array<Record<string, unknown>>;
  if (lines.length > 0) {
    const copyRes = await supabase.from("insurance_claim_line_items").insert(
      lines.map((l) => ({
        claim_id: secondaryClaimId,
        hcpcs_code: String(l.hcpcs_code ?? ""),
        modifier: (l.modifier as string | null) ?? null,
        description: (l.description as string | null) ?? null,
        quantity: typeof l.quantity === "number" ? l.quantity : 1,
        billed_cents: typeof l.billed_cents === "number" ? l.billed_cents : 0,
        status: "pending",
      })) as unknown as Record<string, unknown>[],
    );
    if (copyRes.error) {
      // The header exists; surface the partial failure honestly rather
      // than pretend success.
      return {
        status: "line_copy_failed",
        secondaryClaimId,
        message: copyRes.error.message,
      };
    }
  }

  return { status: "created", secondaryClaimId, cob, lineCount: lines.length };
}
