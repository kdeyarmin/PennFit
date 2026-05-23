// Auto-workflow engine — closes the loop on AI billing automation.
//
// Three idempotent passes that run every 5 minutes:
//
//   1. SCORE + SCRUB risky drafts
//      For each draft insurance_claims row not scored in the last
//      24 hours, run the heuristic scorer. If predicted_denial_probability
//      lands >= 0.5, ALSO fire the AI scrubber so the CSR sees the
//      LLM verdict alongside the heuristic.
//
//   2. ANALYZE fresh denials
//      For each denied claim with no AI denial analysis on file,
//      fire analyzeDenial. The poller already does this for
//      denials that land via ERA; this pass catches denials
//      created by manual PATCH or 277CA dispatch.
//
//   3. STATEMENT closed-with-balance claims
//      For each closed/paid claim with patient_responsibility_cents > 0
//      and no statement generated in the last 30 days (per patient),
//      queue a statement-generation event. We DON'T auto-render the
//      PDF here (the route does that, and we'd need a delivery
//      channel); we publish a webhook event the CSR queue / external
//      systems can consume.
//
// Each pass is independently bounded — a slow OpenAI call in pass 1
// doesn't block pass 2's denials from being analyzed.
//
// PHI posture: counts + ids only in the log lines.

import {
  type Json,
  getSupabaseServiceRoleClient,
} from "@workspace/resupply-db";

import { analyzeDenial } from "./ai-denial-analyzer";
import { scrubClaim, SCRUB_PROMPT_VERSION } from "./ai-claim-scrubber";
import { scoreAndPersist } from "./heuristic-denial-scorer";
import { logger } from "../logger";
import { publishEvent } from "../webhooks/publisher";

type SupabaseClient = ReturnType<typeof getSupabaseServiceRoleClient>;

const SCRUB_TRIGGER_THRESHOLD = 0.5;
const STATEMENT_COOLDOWN_DAYS = 30;
const DRAFT_LOOKBACK_HOURS = 24;
const MAX_PER_PASS = 50;

export interface AutoWorkflowStats {
  scrubsTriggered: number;
  denialAnalysesTriggered: number;
  statementsQueued: number;
  errors: number;
}

export async function runAutoWorkflowPass(): Promise<AutoWorkflowStats> {
  const stats: AutoWorkflowStats = {
    scrubsTriggered: 0,
    denialAnalysesTriggered: 0,
    statementsQueued: 0,
    errors: 0,
  };
  const supabase = getSupabaseServiceRoleClient();
  await runScrubPass(supabase, stats);
  await runDenialAnalysisPass(supabase, stats);
  await runStatementPass(supabase, stats);
  return stats;
}

// ── Pass 1: score + (conditionally) scrub draft claims ──────────────

async function runScrubPass(
  supabase: SupabaseClient,
  stats: AutoWorkflowStats,
): Promise<void> {
  const staleCutoff = new Date(
    Date.now() - DRAFT_LOOKBACK_HOURS * 3600 * 1000,
  ).toISOString();
  // Pull draft claims that either have never been scored OR were
  // scored more than 24h ago. The `or` clause is PostgREST-style.
  const { data: claims } = await supabase
    .schema("resupply")
    .from("insurance_claims")
    .select("id, predicted_denial_scored_at, latest_scrub_at, patient_id")
    .eq("status", "draft")
    .or(
      `predicted_denial_scored_at.is.null,predicted_denial_scored_at.lte.${staleCutoff}`,
    )
    .order("created_at", { ascending: false })
    .limit(MAX_PER_PASS);
  for (const claim of claims ?? []) {
    try {
      const score = await scoreAndPersist(claim.id);
      if (!score) continue;
      if (score.probability < SCRUB_TRIGGER_THRESHOLD) continue;
      // Only fire LLM scrub when (a) probability >= threshold AND
      // (b) no scrub in the last 24h. The latest_scrub_at column
      // is denormalised, set in the scrub route's success path.
      if (
        claim.latest_scrub_at &&
        new Date(claim.latest_scrub_at).getTime() >
          Date.now() - DRAFT_LOOKBACK_HOURS * 3600 * 1000
      ) {
        continue;
      }
      const output = await scrubClaim({ claimId: claim.id });
      const { data: row } = await supabase
        .schema("resupply")
        .from("claim_scrub_results")
        .insert({
          claim_id: claim.id,
          verdict: output.verdict,
          model: "gpt-4o-mini",
          prompt_version: SCRUB_PROMPT_VERSION,
          confidence: output.confidence,
          findings_json: {
            summary: output.summary,
            findings: output.findings,
          } as unknown as Json,
          suggested_patches_json: output.suggestedPatches as unknown as Json,
          review_status: "pending",
          latency_ms: output.latencyMs,
          prompt_tokens: output.promptTokens,
          completion_tokens: output.completionTokens,
          error_message: output.errorMessage,
        })
        .select("id")
        .single();
      if (row) {
        await supabase
          .schema("resupply")
          .from("insurance_claims")
          .update({
            latest_scrub_verdict: output.verdict,
            latest_scrub_at: new Date().toISOString(),
            latest_scrub_result_id: row.id,
            updated_at: new Date().toISOString(),
          })
          .eq("id", claim.id);
        void publishEvent({
          eventType: "claim.auto_scrubbed",
          payload: {
            claim_id: claim.id,
            verdict: output.verdict,
            probability: score.probability,
            finding_count: output.findings.length,
          },
        });
      }
      stats.scrubsTriggered += 1;
    } catch (err) {
      stats.errors += 1;
      logger.warn(
        {
          err: err instanceof Error ? err.message : String(err),
          claimId: claim.id,
        },
        "auto-workflow.scrub: per-claim failure",
      );
    }
  }
}

// ── Pass 2: AI denial analysis for fresh denials ────────────────────

async function runDenialAnalysisPass(
  supabase: SupabaseClient,
  stats: AutoWorkflowStats,
): Promise<void> {
  const { data: denied } = await supabase
    .schema("resupply")
    .from("insurance_claims")
    .select("id, patient_id, decision_at")
    .eq("status", "denied")
    .is("latest_denial_analysis_id", null)
    .order("decision_at", { ascending: false })
    .limit(MAX_PER_PASS);
  for (const claim of denied ?? []) {
    try {
      const output = await analyzeDenial({ claimId: claim.id });
      const { data: row } = await supabase
        .schema("resupply")
        .from("claim_denial_analyses")
        .insert({
          claim_id: claim.id,
          model: "gpt-4o-mini",
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
      if (row) {
        await supabase
          .schema("resupply")
          .from("insurance_claims")
          .update({
            latest_denial_analysis_id: row.id,
            updated_at: new Date().toISOString(),
          })
          .eq("id", claim.id);
        void publishEvent({
          eventType: "claim.denial_analyzed",
          payload: {
            claim_id: claim.id,
            recommendation: output.recommendation,
            confidence: output.confidence,
            can_auto_resubmit: output.canAutoResubmit,
          },
        });
      }
      stats.denialAnalysesTriggered += 1;
    } catch (err) {
      stats.errors += 1;
      logger.warn(
        {
          err: err instanceof Error ? err.message : String(err),
          claimId: claim.id,
        },
        "auto-workflow.denial: per-claim failure",
      );
    }
  }
}

// ── Pass 3: queue statements for closed-with-balance claims ─────────

async function runStatementPass(
  supabase: SupabaseClient,
  stats: AutoWorkflowStats,
): Promise<void> {
  // Group by patient: a single patient gets ONE statement covering
  // all their open balances, not one statement per claim. The
  // cooldown is per-patient so we don't spam.
  const cooldownCutoff = new Date(
    Date.now() - STATEMENT_COOLDOWN_DAYS * 24 * 3600 * 1000,
  ).toISOString();
  const { data: candidates } = await supabase
    .schema("resupply")
    .from("insurance_claims")
    .select("patient_id, patient_responsibility_cents")
    .in("status", ["paid", "closed"])
    .gt("patient_responsibility_cents", 0)
    .order("decision_at", { ascending: false })
    .limit(2000);
  const patientIds = [
    ...new Set((candidates ?? []).map((c) => c.patient_id)),
  ];
  if (patientIds.length === 0) return;

  // Sum patient_responsibility_cents per patient so the placeholder
  // statement row carries an informative total for the watching
  // worker / CSR queue.
  const totalByPatient = new Map<string, number>();
  for (const c of candidates ?? []) {
    totalByPatient.set(
      c.patient_id,
      (totalByPatient.get(c.patient_id) ?? 0) + c.patient_responsibility_cents,
    );
  }

  // Look up which patients had a statement generated in the cooldown window.
  const { data: recent } = await supabase
    .schema("resupply")
    .from("patient_billing_statements")
    .select("patient_id")
    .in("patient_id", patientIds)
    .gte("created_at", cooldownCutoff);
  const onCooldown = new Set((recent ?? []).map((r) => r.patient_id));

  for (const patientId of patientIds) {
    if (onCooldown.has(patientId)) continue;
    // Insert a placeholder `patient_billing_statements` row BEFORE
    // publishing — otherwise the cooldown above (which reads from
    // this table) is never armed and we'd re-emit
    // `billing_statement.due` every cron iteration. The placeholder
    // carries an empty line_items_json and no PDF / delivery method;
    // the watching worker fills those in when it renders.
    const { error: insertErr } = await supabase
      .schema("resupply")
      .from("patient_billing_statements")
      .insert({
        patient_id: patientId,
        line_items_json: [] as unknown as Json,
        total_patient_responsibility_cents:
          totalByPatient.get(patientId) ?? 0,
        delivery_method: null,
        generated_by_email: "system:auto_workflow",
      });
    if (insertErr) {
      // Don't publish the event if we couldn't arm the cooldown —
      // otherwise the next cron iteration would re-publish.
      continue;
    }
    void publishEvent({
      eventType: "billing_statement.due",
      payload: { patient_id: patientId },
    });
    stats.statementsQueued += 1;
  }
}
