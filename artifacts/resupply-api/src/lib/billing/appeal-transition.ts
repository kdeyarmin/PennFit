// Shared "appeal has actually left for the payer" side effects.
//
// Extracted from the appeal-fax route (routes/admin/claim-appeals.ts) so the
// fax path AND the manual "mark delivered" path (mail / email / portal) run the
// IDENTICAL transition and can't diverge: a currently-`denied` claim moves to
// `appealed`, a replayable `insurance_claim_events` row + a `claim.appealed`
// webhook are emitted, and the answering denial analysis is resolved
// (`review_status='accepted_appealed'`) so it drops off the denials worklist.
//
// Guarded + best-effort: only a `denied` claim transitions (the valid edge),
// the UPDATE re-asserts `status='denied'` so a concurrent mover can't be
// double-applied, and every step logs-and-continues rather than throwing — the
// delivery already happened, so a bookkeeping miss must not surface as an error.
//
// PHI posture: ids + status only; never logs patient identifiers.

import { type OrgScopedClient } from "@workspace/resupply-db";

import { logger } from "../logger";
import { publishEvent } from "../webhooks/publisher";

export interface MarkAppealSentInput {
  supabase: OrgScopedClient;
  claim: { id: string; patient_id: string; status: string };
  /** The answered denial analysis (the letter's link, else the latest is used). */
  letterDenialAnalysisId: string | null;
  actorEmail: string | null;
  /** Event-row note, e.g. "Appeal faxed to payer." / "Appeal mailed to payer." */
  note: string;
  /** Shared timestamp so the delivery stamp + transition agree. */
  nowIso?: string;
}

export async function markAppealSent(
  input: MarkAppealSentInput,
): Promise<void> {
  // Only a currently-denied claim transitions; any other status is left as-is.
  if (input.claim.status !== "denied") return;
  const nowIso = input.nowIso ?? new Date().toISOString();
  const { supabase, claim } = input;

  const { data: transitioned, error: claimErr } = await supabase
    .from("insurance_claims")
    .update({ status: "appealed", updated_at: nowIso })
    .eq("id", claim.id)
    .eq("status", "denied")
    .select("id");
  if (claimErr) {
    logger.warn(
      { event: "appeal_claim_transition_failed", claimId: claim.id },
      "markAppealSent: claim denied->appealed transition failed",
    );
    return;
  }

  // Mirror the canonical claim-status transition side effects
  // (routes/patients/insurance-claims.ts) — a replayable event row AND a
  // webhook — but only when THIS call actually performed the transition.
  if ((transitioned?.length ?? 0) > 0) {
    const { error: eventErr } = await supabase
      .from("insurance_claim_events")
      .insert({
        claim_id: claim.id,
        event_type: "appealed",
        note: input.note,
        actor_email: input.actorEmail ?? "unknown",
      });
    if (eventErr) {
      logger.warn(
        { event: "appeal_event_insert_failed", claimId: claim.id },
        "markAppealSent: appealed history event insert failed",
      );
    }
    void publishEvent({
      orgId: supabase.orgId,
      eventType: "claim.appealed",
      payload: { claim_id: claim.id, patient_id: claim.patient_id },
    });
  }

  // Resolve the denial analysis this appeal answers (the letter's linked
  // analysis, else the claim's latest) so the worklist's RESOLVED_REVIEW_STATES
  // filter drops it.
  let analysisId = input.letterDenialAnalysisId;
  if (!analysisId) {
    const { data: latest } = await supabase
      .from("claim_denial_analyses")
      .select("id")
      .eq("claim_id", claim.id)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    analysisId = latest?.id ?? null;
  }
  if (analysisId) {
    const { error: analysisErr } = await supabase
      .from("claim_denial_analyses")
      .update({ review_status: "accepted_appealed" })
      .eq("id", analysisId);
    if (analysisErr) {
      logger.warn(
        { event: "appeal_analysis_resolve_failed", analysisId },
        "markAppealSent: denial analysis accepted_appealed update failed",
      );
    }
  }
}
