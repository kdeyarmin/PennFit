// GET /admin/billing/director-summary
//
// Single round-trip the billing director (or AR lead) loads every
// morning. Consolidates the 7+ separate fetches the existing per-
// surface endpoints would force the SPA to make:
//
//   * "today" counts: stale drafts, fresh denials, ERAs awaiting
//     review, fulfillments awaiting claim.
//   * AI queue: blocking scrubs, fixable scrubs, denials needing
//     analysis, auto-resubmit-ready.
//   * Money in flight: total billed in submitted-no-ack, total in
//     denied-needs-work, total in patient-responsibility unpaid.
//   * 30 / 60 / 90 day denial-rate trend (decisions in each bucket).
//   * Top-5 payers by open dollars.
//   * Webhook delivery health: queued / exhausted counts in last 24h.
//
// All values are aggregate; no PHI in the response.

import { Router, type IRouter } from "express";

import { getSupabaseServiceRoleClient } from "@workspace/resupply-db";

import { requirePermission } from "../../middlewares/requireAdmin";

const router: IRouter = Router();

router.get(
  "/admin/billing/director-summary",
  requirePermission("reports.read"),
  async (_req, res) => {
    const supabase = getSupabaseServiceRoleClient();
    const now = Date.now();
    const t24h = new Date(now - 24 * 3600 * 1000).toISOString();
    const t48h = new Date(now - 48 * 3600 * 1000).toISOString();
    const t14d = new Date(now - 14 * 24 * 3600 * 1000).toISOString();
    const t30d = new Date(now - 30 * 24 * 3600 * 1000).toISOString();
    const t60d = new Date(now - 60 * 24 * 3600 * 1000).toISOString();
    const t90d = new Date(now - 90 * 24 * 3600 * 1000).toISOString();
    const t7d = new Date(now - 7 * 24 * 3600 * 1000).toISOString();

    const [
      { data: staleDrafts },
      { data: freshDenials },
      { data: stuckSubmitted },
      { data: partialEras },
      { data: scrubBlocking },
      { data: scrubFixable },
      { data: deniedNoAnalysis },
      { data: autoResubmitReady },
      { data: openPatientResp },
      { count: webhooksQueued },
      { count: webhooksExhausted24h },
      { data: denialRateRows },
    ] = await Promise.all([
      supabase
        .schema("resupply")
        .from("insurance_claims")
        .select("id, total_billed_cents", { count: "exact" })
        .eq("status", "draft")
        .lte("created_at", t24h),
      supabase
        .schema("resupply")
        .from("insurance_claims")
        .select("id, total_billed_cents, payer_name", { count: "exact" })
        .eq("status", "denied")
        .gte("decision_at", t14d),
      supabase
        .schema("resupply")
        .from("insurance_claims")
        .select("id, total_billed_cents")
        .eq("status", "submitted")
        .lte("submitted_at", t48h),
      supabase
        .schema("resupply")
        .from("era_files")
        .select("id")
        .eq("status", "partial")
        .gte("ingested_at", t30d),
      supabase
        .schema("resupply")
        .from("insurance_claims")
        .select("id")
        .eq("status", "draft")
        .eq("latest_scrub_verdict", "blocking"),
      supabase
        .schema("resupply")
        .from("insurance_claims")
        .select("id")
        .eq("status", "draft")
        .eq("latest_scrub_verdict", "fixable"),
      supabase
        .schema("resupply")
        .from("insurance_claims")
        .select("id")
        .eq("status", "denied")
        .is("latest_denial_analysis_id", null),
      supabase
        .schema("resupply")
        .from("claim_denial_analyses")
        .select("id")
        .eq("can_auto_resubmit", true)
        .eq("review_status", "pending"),
      supabase
        .schema("resupply")
        .from("insurance_claims")
        .select("payer_name, patient_responsibility_cents")
        .gt("patient_responsibility_cents", 0)
        .in("status", ["paid", "denied", "appealed", "closed"]),
      supabase
        .schema("resupply")
        .from("webhook_deliveries")
        .select("id", { count: "exact", head: true })
        .eq("status", "queued"),
      supabase
        .schema("resupply")
        .from("webhook_deliveries")
        .select("id", { count: "exact", head: true })
        .eq("status", "exhausted")
        .gte("updated_at", t24h),
      supabase
        .schema("resupply")
        .from("insurance_claims")
        .select("status, decision_at")
        .gte("decision_at", t90d)
        .in("status", ["paid", "denied", "appealed", "closed"])
        .limit(20000),
    ]);

    // Money rollups.
    const dollarsInStuckSubmitted = (stuckSubmitted ?? []).reduce(
      (s, c) => s + (c.total_billed_cents ?? 0),
      0,
    );
    const dollarsInDeniedFresh = (freshDenials ?? []).reduce(
      (s, c) => s + (c.total_billed_cents ?? 0),
      0,
    );
    const dollarsInPatientResp = (openPatientResp ?? []).reduce(
      (s, c) => s + (c.patient_responsibility_cents ?? 0),
      0,
    );

    // Top 5 payers by open patient_responsibility.
    const perPayer = new Map<string, number>();
    for (const c of openPatientResp ?? []) {
      const cur = perPayer.get(c.payer_name) ?? 0;
      perPayer.set(c.payer_name, cur + (c.patient_responsibility_cents ?? 0));
    }
    const topPayersByOpenDollars = [...perPayer.entries()]
      .map(([payer, openCents]) => ({ payerName: payer, openCents }))
      .sort((a, b) => b.openCents - a.openCents)
      .slice(0, 5);

    // Denial-rate trend across 0-30/30-60/60-90 day buckets.
    const buckets = {
      d0_30: { dec: 0, den: 0 },
      d30_60: { dec: 0, den: 0 },
      d60_90: { dec: 0, den: 0 },
    };
    for (const c of denialRateRows ?? []) {
      if (!c.decision_at) continue;
      const ageDays =
        (now - new Date(c.decision_at).getTime()) / (24 * 3600 * 1000);
      const bucket =
        ageDays <= 30 ? "d0_30" : ageDays <= 60 ? "d30_60" : "d60_90";
      buckets[bucket].dec += 1;
      if (c.status === "denied" || c.status === "appealed") {
        buckets[bucket].den += 1;
      }
    }
    const trend = Object.entries(buckets).map(([k, v]) => ({
      window: k,
      decisions: v.dec,
      denials: v.den,
      denialRate: v.dec > 0 ? v.den / v.dec : null,
    }));

    res.json({
      counts: {
        staleDrafts: staleDrafts?.length ?? 0,
        freshDenials: freshDenials?.length ?? 0,
        stuckSubmittedNoAck: stuckSubmitted?.length ?? 0,
        partialEras: partialEras?.length ?? 0,
        scrubBlocking: scrubBlocking?.length ?? 0,
        scrubFixable: scrubFixable?.length ?? 0,
        deniedNeedsAnalysis: deniedNoAnalysis?.length ?? 0,
        autoResubmitReady: autoResubmitReady?.length ?? 0,
        webhooksQueued: webhooksQueued ?? 0,
        webhooksExhausted24h: webhooksExhausted24h ?? 0,
      },
      dollars: {
        stuckSubmittedCents: dollarsInStuckSubmitted,
        deniedFreshCents: dollarsInDeniedFresh,
        patientResponsibilityCents: dollarsInPatientResp,
      },
      denialRateTrend: trend,
      topPayersByOpenDollars,
      windowReferences: { t7d, t14d, t30d, t60d, t90d },
      generatedAt: new Date().toISOString(),
    });
  },
);

export default router;
