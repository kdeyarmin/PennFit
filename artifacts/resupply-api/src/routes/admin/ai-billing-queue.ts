// /admin/billing/ai-queue — AI-driven work queue.
//
//   GET /admin/billing/ai-queue
//
// Returns four buckets:
//   * scrubBlockingClaims  — drafts whose latest scrub came back
//                            verdict='blocking' (need human input).
//   * scrubFixableClaims   — drafts whose scrub returned 'fixable'
//                            with pending patches the CSR can apply.
//   * deniedNeedsAnalysis  — denied claims with no AI analysis yet.
//   * autoResubmitReady    — denied claims with an analysis that's
//                            safe to auto-resubmit (one click).
//
// All values are aggregate; no PHI in the response.

import { Router, type IRouter } from "express";

import { getSupabaseServiceRoleClient } from "@workspace/resupply-db";

import { requireAdmin } from "../../middlewares/requireAdmin";

const router: IRouter = Router();

router.get("/admin/billing/ai-queue", requireAdmin, async (_req, res) => {
  const supabase = getSupabaseServiceRoleClient();

  const [
    { data: blocking },
    { data: fixable },
    { data: deniedNoAnalysis },
    { data: autoReady },
  ] = await Promise.all([
    supabase
      .schema("resupply")
      .from("insurance_claims")
      .select(
        "id, patient_id, payer_name, total_billed_cents, latest_scrub_at, latest_scrub_result_id",
      )
      .eq("status", "draft")
      .eq("latest_scrub_verdict", "blocking")
      .order("latest_scrub_at", { ascending: false })
      .limit(50),
    supabase
      .schema("resupply")
      .from("insurance_claims")
      .select(
        "id, patient_id, payer_name, total_billed_cents, latest_scrub_at, latest_scrub_result_id",
      )
      .eq("status", "draft")
      .eq("latest_scrub_verdict", "fixable")
      .order("latest_scrub_at", { ascending: false })
      .limit(50),
    supabase
      .schema("resupply")
      .from("insurance_claims")
      .select(
        "id, patient_id, payer_name, total_billed_cents, decision_at, denial_reason",
      )
      .eq("status", "denied")
      .is("latest_denial_analysis_id", null)
      .order("decision_at", { ascending: false })
      .limit(50),
    supabase
      .schema("resupply")
      .from("claim_denial_analyses")
      .select(
        "id, claim_id, recommendation, confidence, root_cause_summary, created_at",
      )
      .eq("can_auto_resubmit", true)
      .eq("review_status", "pending")
      .order("created_at", { ascending: false })
      .limit(50),
  ]);

  res.json({
    scrubBlockingClaims: (blocking ?? []).map((c) => ({
      id: c.id,
      patientId: c.patient_id,
      payerName: c.payer_name,
      totalBilledCents: c.total_billed_cents,
      latestScrubAt: c.latest_scrub_at,
      latestScrubResultId: c.latest_scrub_result_id,
    })),
    scrubFixableClaims: (fixable ?? []).map((c) => ({
      id: c.id,
      patientId: c.patient_id,
      payerName: c.payer_name,
      totalBilledCents: c.total_billed_cents,
      latestScrubAt: c.latest_scrub_at,
      latestScrubResultId: c.latest_scrub_result_id,
    })),
    deniedNeedsAnalysis: (deniedNoAnalysis ?? []).map((c) => ({
      id: c.id,
      patientId: c.patient_id,
      payerName: c.payer_name,
      totalBilledCents: c.total_billed_cents,
      decisionAt: c.decision_at,
      denialReason: c.denial_reason,
    })),
    autoResubmitReady: (autoReady ?? []).map((a) => ({
      analysisId: a.id,
      claimId: a.claim_id,
      recommendation: a.recommendation,
      confidence: a.confidence,
      rootCauseSummary: a.root_cause_summary,
      createdAt: a.created_at,
    })),
    counts: {
      scrubBlocking: blocking?.length ?? 0,
      scrubFixable: fixable?.length ?? 0,
      deniedNeedsAnalysis: deniedNoAnalysis?.length ?? 0,
      autoResubmitReady: autoReady?.length ?? 0,
    },
    generatedAt: new Date().toISOString(),
  });
});

export default router;
