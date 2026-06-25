// Shared AI denial-analysis runner.
//
// A denied claim from an ERA (835) gets an AI denial analysis row
// (`claim_denial_analyses`) that powers the denials worklist's
// win-probability, recommendation, and appeal sketch. This used to live
// only inside the Office Ally inbound poller, so a CSR-uploaded 835 (the
// manual `/admin/billing/era-ingest` route) reconciled the money but left
// every denial permanently unanalyzed. Both ERA entry points now call this
// one implementation so they can't diverge again.
//
// Non-throwing by contract: a flaky model call or a write error degrades to
// "no analysis row" (logged), it never fails the surrounding ERA ingest.

import { type Json, type OrgScopedClient } from "@workspace/resupply-db";

import { analyzeDenial } from "./ai-denial-analyzer";
import { logger } from "../logger";

/**
 * Run the AI denial analyzer for one denied claim and persist the
 * `claim_denial_analyses` row, linking it back onto the claim. Resolves
 * cleanly on every path (errors are logged, never thrown) so callers can
 * either `await` it (the manual upload, which reports results inline) or
 * fire it `void` (the poller tick, which must not stall on a slow model).
 */
export async function runDenialAnalysis(
  supabase: OrgScopedClient,
  claimId: string,
  eraFileId: string,
): Promise<void> {
  try {
    const output = await analyzeDenial({ claimId, eraFileId });
    const { data: row, error } = await supabase
      .from("claim_denial_analyses")
      .insert({
        claim_id: claimId,
        era_file_id: eraFileId,
        model: "gpt-4.1-mini",
        prompt_version: "denial-1.0",
        confidence: output.confidence,
        root_cause_summary: output.rootCauseSummary,
        recommendation: output.recommendation,
        analysis_json: {
          mappedCodes: output.mappedCodes,
          fixSteps: output.fixSteps,
          appealLetterSketch: output.appealLetterSketch,
          droppedPatches: output.droppedPatches,
        } as unknown as Json,
        suggested_patches_json: output.suggestedPatches as unknown as Json,
        can_auto_resubmit: output.canAutoResubmit,
        review_status: output.errorMessage ? "errored" : "pending",
        latency_ms: output.latencyMs,
        prompt_tokens: output.promptTokens,
        completion_tokens: output.completionTokens,
        error_message: output.errorMessage,
      })
      .select("id")
      .single();
    if (error) throw error;
    if (row) {
      const { error: analysisLinkErr } = await supabase
        .from("insurance_claims")
        .update({
          latest_denial_analysis_id: row.id,
          updated_at: new Date().toISOString(),
        })
        .eq("id", claimId);
      if (analysisLinkErr) {
        // Log the error object (not just .message) so the logger's err.*
        // redaction applies, consistent with the outer catch below.
        logger.warn(
          { err: analysisLinkErr, claimId, analysisId: row.id },
          "denial-analysis: link update failed (non-fatal)",
        );
      }
    }
  } catch (err) {
    logger.warn(
      { err, claimId },
      "denial-analysis: AI analysis failed (non-fatal)",
    );
  }
}
