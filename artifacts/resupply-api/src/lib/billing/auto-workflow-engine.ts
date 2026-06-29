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
//      generate one complete patient statement with real line items and
//      a persisted PDF before publishing the due events.
//
//   4. DRAFT secondary / COB claims  (flag: billing.auto_secondary_claims)
//      For each PAID primary claim that carries a secondary coverage + a
//      patient-responsibility balance and hasn't yet spawned a secondary,
//      draft the secondary claim (snapshotting the primary's adjudication
//      for the 837 2320/2330 COB loop). Status 'draft' — a biller reviews
//      + submits through the normal batch path; we never auto-SUBMIT. Opt-
//      in: seeded OFF, fail-soft when the flag is unset/disabled.
//
// Each pass is independently bounded — a slow OpenAI call in pass 1
// doesn't block pass 2's denials from being analyzed.
//
// PHI posture: counts + ids only in the log lines.

import {
  type Json,
  getOrgScopedClient,
  resolveSeedOrgId,
  type OrgScopedClient,
} from "@workspace/resupply-db";

import { analyzeDenial } from "./ai-denial-analyzer";
import { scrubClaim, SCRUB_PROMPT_VERSION } from "./ai-claim-scrubber";
import {
  generatePatientBillingStatement,
  StatementGenerationError,
} from "./statement-generation";
import { scoreAndPersist } from "./heuristic-denial-scorer";
import {
  filterSecondaryEligible,
  generateSecondaryClaimDraft,
  SECONDARY_CLAIM_SELECT,
  type EligibleCandidate,
} from "./secondary-claim-generator";
import { isFeatureEnabled } from "../feature-flags";
import { logger } from "../logger";
import { publishEvent } from "../webhooks/publisher";

type SupabaseClient = OrgScopedClient;

const SCRUB_TRIGGER_THRESHOLD = 0.5;
const STATEMENT_COOLDOWN_DAYS = 30;
const DRAFT_LOOKBACK_HOURS = 24;
const MAX_PER_PASS = 50;
// PostgREST per-response row cap. Used to offset-page the statement-pass
// candidate scan so it isn't bounded to a fixed top-N (which would starve
// every open-balance patient past that cutoff — the cooldown skip doesn't
// change WHICH rows are read).
const SCAN_PAGE = 1000;

export interface AutoWorkflowStats {
  scrubsTriggered: number;
  denialAnalysesTriggered: number;
  statementsQueued: number;
  secondaryClaimsDrafted: number;
  errors: number;
}

/**
 * Run one auto-workflow pass for a single tenant. `orgId` defaults to the
 * seed org when omitted (back-compat for direct callers / tests); the worker
 * fans out per active tenant. Every pass scopes its reads/writes — and its
 * per-pass feature-flag checks — to this org via the scoped client's
 * `.orgId`, so one tenant's run never touches another tenant's claims.
 */
export async function runAutoWorkflowPass(
  orgId?: string,
): Promise<AutoWorkflowStats> {
  const stats: AutoWorkflowStats = {
    scrubsTriggered: 0,
    denialAnalysesTriggered: 0,
    statementsQueued: 0,
    secondaryClaimsDrafted: 0,
    errors: 0,
  };
  const resolvedOrgId = orgId?.trim() || (await resolveSeedOrgId());
  if (!resolvedOrgId) {
    return stats;
  }
  const supabase = getOrgScopedClient(resolvedOrgId);
  await runScrubPass(supabase, stats);
  await runDenialAnalysisPass(supabase, stats);
  await runStatementPass(supabase, stats);
  await runSecondaryClaimPass(supabase, stats);
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
      const score = await scoreAndPersist(claim.id, supabase.orgId);
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
      const output = await scrubClaim({
        claimId: claim.id,
        orgId: supabase.orgId,
      });
      const { data: row } = await supabase
        .from("claim_scrub_results")
        .insert({
          claim_id: claim.id,
          verdict: output.verdict,
          model: "gpt-4.1-mini",
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
        const { error: scrubLinkErr } = await supabase
          .from("insurance_claims")
          .update({
            latest_scrub_verdict: output.verdict,
            latest_scrub_at: new Date().toISOString(),
            latest_scrub_result_id: row.id,
            updated_at: new Date().toISOString(),
          })
          .eq("id", claim.id);
        if (scrubLinkErr) {
          logger.warn(
            { err: scrubLinkErr.message, claimId: claim.id },
            "auto-workflow: scrub verdict link update failed (non-fatal)",
          );
        }
        void publishEvent({
          orgId: supabase.orgId,
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
          err,
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
    .from("insurance_claims")
    .select("id, patient_id, decision_at")
    .eq("status", "denied")
    .is("latest_denial_analysis_id", null)
    .order("decision_at", { ascending: false })
    .limit(MAX_PER_PASS);
  for (const claim of denied ?? []) {
    try {
      const output = await analyzeDenial({
        claimId: claim.id,
        orgId: supabase.orgId,
      });
      const { data: row } = await supabase
        .from("claim_denial_analyses")
        .insert({
          claim_id: claim.id,
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
      if (row) {
        const { error: analysisLinkErr } = await supabase
          .from("insurance_claims")
          .update({
            latest_denial_analysis_id: row.id,
            updated_at: new Date().toISOString(),
          })
          .eq("id", claim.id);
        if (analysisLinkErr) {
          logger.warn(
            { err: analysisLinkErr.message, claimId: claim.id },
            "auto-workflow: denial analysis link update failed (non-fatal)",
          );
        }
        void publishEvent({
          orgId: supabase.orgId,
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
          err,
          claimId: claim.id,
        },
        "auto-workflow.denial: per-claim failure",
      );
    }
  }
}

// ── Pass 3: queue statements for closed-with-balance claims ─────────

export async function runStatementPass(
  supabase: SupabaseClient,
  stats: AutoWorkflowStats,
): Promise<void> {
  // Group by patient: a single patient gets ONE statement covering
  // all their open balances, not one statement per claim. The
  // cooldown is per-patient so we don't spam.
  const cooldownCutoff = new Date(
    Date.now() - STATEMENT_COOLDOWN_DAYS * 24 * 3600 * 1000,
  ).toISOString();

  // The COMPLETE set of patients statemented inside the cooldown window.
  // This MUST be complete — a truncated set would re-statement (spam) a
  // patient already on cooldown — so page past the ~1000-row cap and throw
  // on error (a partial set is worse than retrying next tick).
  const onCooldown = new Set<string>();
  for (let from = 0; ; from += SCAN_PAGE) {
    const { data, error } = await supabase
      .from("patient_billing_statements")
      .select("patient_id")
      // Order by the unique `id` (not patient_id, which repeats across a
      // patient's statements) so offset paging has a total order and the
      // cooldown set can't drop a patient at a page boundary.
      .gte("created_at", cooldownCutoff)
      .order("id", { ascending: true })
      .range(from, from + SCAN_PAGE - 1);
    if (error) throw error;
    if (!data || data.length === 0) break;
    for (const r of data as Array<{ patient_id: string }>) {
      onCooldown.add(r.patient_id);
    }
    if (data.length < SCAN_PAGE) break;
  }

  // Scan open-balance claims (most-recent decision first), collecting
  // DISTINCT off-cooldown patients until we have a tickful (MAX_PER_PASS) or
  // exhaust the candidates. This caps statement GENERATION per tick (the
  // expensive PDF-render + publish work) the same way the other passes do,
  // while the paging guarantees coverage across ticks: each statemented
  // patient goes on cooldown and drops out of the pool, so the next tick
  // surfaces the next batch — no patient is permanently starved the way a
  // fixed `.limit(N)` would starve everyone past row N.
  const due: string[] = [];
  const seen = new Set<string>();
  for (let from = 0; due.length < MAX_PER_PASS; from += SCAN_PAGE) {
    const { data: claims, error } = await supabase
      .from("insurance_claims")
      .select("patient_id")
      .in("status", ["partially_paid", "paid", "closed"])
      .gt("patient_responsibility_cents", 0)
      .order("decision_at", { ascending: false })
      .order("id", { ascending: false })
      .range(from, from + SCAN_PAGE - 1);
    if (error) throw error;
    if (!claims || claims.length === 0) break;
    for (const c of claims as Array<{ patient_id: string }>) {
      if (seen.has(c.patient_id)) continue;
      seen.add(c.patient_id);
      if (!onCooldown.has(c.patient_id)) {
        due.push(c.patient_id);
        if (due.length >= MAX_PER_PASS) break;
      }
    }
    if (claims.length < SCAN_PAGE) break;
  }
  if (due.length === 0) return;

  for (const patientId of due) {
    // Generate a complete statement before publishing. The statement row is
    // the cooldown marker, and it is safe for send queues because it has
    // real line items plus a rendered PDF copy.
    try {
      const generated = await generatePatientBillingStatement({
        patientId,
        generatedByEmail: "system:auto_workflow",
        orgId: supabase.orgId,
      });
      void publishEvent({
        orgId: supabase.orgId,
        eventType: "billing_statement.generated",
        payload: {
          statement_id: generated.statementId,
          patient_id: patientId,
          total_cents: generated.totalPatientResponsibilityCents,
          claim_count: generated.claimCount,
          source: "auto_workflow",
        },
      });
      void publishEvent({
        orgId: supabase.orgId,
        eventType: "billing_statement.due",
        payload: {
          statement_id: generated.statementId,
          patient_id: patientId,
          total_cents: generated.totalPatientResponsibilityCents,
        },
      });
      stats.statementsQueued += 1;
      continue;
    } catch (err) {
      if (
        err instanceof StatementGenerationError &&
        err.code === "no_open_balance"
      ) {
        continue;
      }
      stats.errors += 1;
      logger.warn(
        {
          err,
          patientId,
        },
        "auto-workflow.statements: generation failed",
      );
      continue;
    }
  }
}

// ── Pass 4: draft secondary / COB claims for paid primaries ─────────

// Exported for focused unit testing; called by runAutoWorkflowPass above.
export async function runSecondaryClaimPass(
  supabase: SupabaseClient,
  stats: AutoWorkflowStats,
): Promise<void> {
  // Opt-in: auto-drafting claims is a billing action, so it stays behind
  // a flag that's seeded OFF. When disabled the biller still uses the
  // manual COB worklist (/admin/billing/secondary-eligible).
  if (
    !(await isFeatureEnabled("billing.auto_secondary_claims", supabase.orgId))
  )
    return;

  // Paid primaries that carry a secondary coverage — the COB candidates.
  // `filterSecondaryEligible` re-checks balance/sequence and drops any
  // primary that already spawned a secondary, so this is the same set the
  // manual worklist surfaces.
  const { data: candidates, error: candErr } = await supabase
    .from("insurance_claims")
    .select(SECONDARY_CLAIM_SELECT)
    .eq("payer_sequence", "primary")
    .in("status", ["paid", "partially_paid"])
    .not("secondary_coverage_id", "is", null)
    .order("patient_responsibility_cents", { ascending: false })
    .limit(MAX_PER_PASS);
  if (candErr) {
    stats.errors += 1;
    logger.warn(
      { err: candErr.message },
      "auto-workflow.secondary: candidate query failed",
    );
    return;
  }
  const rows = (candidates ?? []) as unknown as EligibleCandidate[];
  if (rows.length === 0) return;

  // Which of these already have a secondary? One query, then filter in
  // memory — mirrors the GET worklist's dedupe. A failed lookup must NOT
  // proceed with an empty `existing` set: that would attempt a duplicate
  // create for every candidate (caught only by the unique constraint).
  const ids = rows.map((c) => c.id);
  const existing = new Set<string>();
  const { data: secRows, error: secErr } = await supabase
    .from("insurance_claims")
    .select("primary_claim_id")
    .eq("payer_sequence", "secondary")
    .in("primary_claim_id", ids);
  if (secErr) {
    stats.errors += 1;
    logger.warn(
      { err: secErr.message },
      "auto-workflow.secondary: existing-secondary lookup failed",
    );
    return;
  }
  for (const r of (secRows ?? []) as Array<{
    primary_claim_id?: string | null;
  }>) {
    if (r.primary_claim_id) existing.add(r.primary_claim_id);
  }

  const eligible = filterSecondaryEligible(rows, existing);
  if (eligible.length === 0) return;
  // Draft under the SAME tenant as the candidates (the passed-in
  // org-scoped client), not the seed org — otherwise a non-seed tenant's
  // secondary claims would be created against the seed (Penn) tenant.
  for (const item of eligible) {
    try {
      const result = await generateSecondaryClaimDraft(supabase, item.claimId);
      if (result.status === "created") {
        stats.secondaryClaimsDrafted += 1;
        void publishEvent({
          orgId: supabase.orgId,
          eventType: "claim.secondary_drafted",
          payload: {
            claim_id: result.secondaryClaimId,
            primary_claim_id: item.claimId,
            patient_responsibility_cents: result.cob.patientRespCents,
            line_count: result.lineCount,
          },
        });
      } else if (
        result.status === "query_failed" ||
        result.status === "create_failed" ||
        result.status === "line_copy_failed"
      ) {
        // `exists` / `not_eligible` / `not_found` are benign no-ops (a
        // concurrent generate or a candidate that changed under us); only
        // real failures bump the error counter.
        stats.errors += 1;
        logger.warn(
          { status: result.status, primaryClaimId: item.claimId },
          "auto-workflow.secondary: draft failed",
        );
      }
    } catch (err) {
      stats.errors += 1;
      logger.warn(
        { err, primaryClaimId: item.claimId },
        "auto-workflow.secondary: per-claim failure",
      );
    }
  }
}
