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

import { getOrgScopedClient } from "@workspace/resupply-db";

import {
  DECISIONED_CLAIM_STATUSES,
  denialRateWindowCutoffIso,
  isDenialStatus,
} from "../../lib/billing/denial-rate";
import { requirePermission } from "../../middlewares/requireAdmin";

const router: IRouter = Router();

// PostgREST caps a single response at ~1000 rows. The dollar rollups and the
// denial-rate trend below aggregate EVERY matching row, so an unpaginated
// read silently understates AR / denied / submitted dollars and skews the
// trend the moment a tenant exceeds ~1000 claims in a bucket. Offset-page
// past the cap. `page(lo, hi)` must return a query already `.order()`ed +
// `.range(lo, hi)`d. (Pure count tiles use head:true exact counts instead,
// which never transfer rows and so never truncate.)
const DIRECTOR_PAGE = 1000;
async function collectAllRows<T>(
  page: (
    lo: number,
    hi: number,
  ) => PromiseLike<{ data: T[] | null; error: unknown }>,
): Promise<T[]> {
  const out: T[] = [];
  for (let lo = 0; ; lo += DIRECTOR_PAGE) {
    const { data, error } = await page(lo, lo + DIRECTOR_PAGE - 1);
    if (error) throw error;
    if (!data || data.length === 0) break;
    out.push(...data);
    if (data.length < DIRECTOR_PAGE) break;
  }
  return out;
}

router.get(
  "/admin/billing/director-summary",
  requirePermission("reports.read"),
  async (req, res) => {
    const orgId = req.orgId;
    if (!orgId) {
      res.status(500).json({ error: "tenant_context_missing" });
      return;
    }
    const supabase = getOrgScopedClient(orgId);
    const now = Date.now();
    const t24h = new Date(now - 24 * 3600 * 1000).toISOString();
    const t48h = new Date(now - 48 * 3600 * 1000).toISOString();
    const t14d = new Date(now - 14 * 24 * 3600 * 1000).toISOString();
    const t30d = new Date(now - 30 * 24 * 3600 * 1000).toISOString();
    const t60d = new Date(now - 60 * 24 * 3600 * 1000).toISOString();
    const t90d = denialRateWindowCutoffIso(now); // canonical denial-rate window
    const t7d = new Date(now - 7 * 24 * 3600 * 1000).toISOString();

    // Count-only tiles use head:true exact counts (no rows transferred, so
    // they can't truncate at the ~1000-row cap). The three dollar rollups and
    // the denial-rate trend need the actual rows, so they offset-page past
    // the cap via collectAllRows.
    const [
      { count: staleDraftsCount, error: e0 },
      { count: partialErasCount, error: e1 },
      { data: fulfillmentsToBillRaw, error: e2 },
      { count: scrubBlockingCount, error: e3 },
      { count: scrubFixableCount, error: e4 },
      { count: deniedNoAnalysisCount, error: e5 },
      { count: autoResubmitReadyCount, error: e6 },
      { count: webhooksQueued, error: e7 },
      { count: webhooksExhausted24h, error: e8 },
      freshDenials,
      stuckSubmitted,
      openPatientResp,
      denialRateRows,
    ] = await Promise.all([
      supabase
        .from("insurance_claims")
        .select("id", { count: "exact", head: true })
        .eq("status", "draft")
        .lte("created_at", t24h),
      supabase
        .from("era_files")
        .select("id", { count: "exact", head: true })
        .eq("status", "partial")
        .gte("ingested_at", t30d),
      supabase
        .raw()
        .schema("resupply")
        .rpc("fulfillments_to_bill_count", { p_org_id: orgId, p_since: t7d }),
      supabase
        .from("insurance_claims")
        .select("id", { count: "exact", head: true })
        .eq("status", "draft")
        .eq("latest_scrub_verdict", "blocking"),
      supabase
        .from("insurance_claims")
        .select("id", { count: "exact", head: true })
        .eq("status", "draft")
        .eq("latest_scrub_verdict", "fixable"),
      supabase
        .from("insurance_claims")
        .select("id", { count: "exact", head: true })
        .eq("status", "denied")
        .is("latest_denial_analysis_id", null),
      supabase
        .from("claim_denial_analyses")
        .select("id", { count: "exact", head: true })
        .eq("can_auto_resubmit", true)
        .eq("review_status", "pending"),
      supabase
        .from("webhook_deliveries")
        .select("id", { count: "exact", head: true })
        .eq("status", "queued"),
      supabase
        .from("webhook_deliveries")
        .select("id", { count: "exact", head: true })
        .eq("status", "exhausted")
        .gte("updated_at", t24h),
      // Fresh denials — rows needed for the denied-dollars rollup (count is
      // the paginated row count).
      collectAllRows<{ total_billed_cents: number | null }>((lo, hi) =>
        supabase
          .from("insurance_claims")
          .select("id, total_billed_cents")
          .eq("status", "denied")
          .gte("decision_at", t14d)
          .order("id", { ascending: true })
          .range(lo, hi),
      ),
      // Submitted-no-ack — rows needed for the stuck-submitted dollars.
      collectAllRows<{ total_billed_cents: number | null }>((lo, hi) =>
        supabase
          .from("insurance_claims")
          .select("id, total_billed_cents")
          .eq("status", "submitted")
          .lte("submitted_at", t48h)
          .order("id", { ascending: true })
          .range(lo, hi),
      ),
      // Open patient responsibility — rows needed for the AR rollup + the
      // per-payer ranking.
      collectAllRows<{
        payer_name: string;
        patient_responsibility_cents: number | null;
      }>((lo, hi) =>
        supabase
          .from("insurance_claims")
          .select("payer_name, patient_responsibility_cents")
          .gt("patient_responsibility_cents", 0)
          .in("status", [
            "partially_paid",
            "paid",
            "denied",
            "appealed",
            "closed",
          ])
          .order("id", { ascending: true })
          .range(lo, hi),
      ),
      // Decisioned claims in the denial-rate window — every row is bucketed.
      collectAllRows<{ status: string; decision_at: string | null }>((lo, hi) =>
        supabase
          .from("insurance_claims")
          .select("status, decision_at")
          .gte("decision_at", t90d)
          .in("status", [...DECISIONED_CLAIM_STATUSES])
          .order("id", { ascending: true })
          .range(lo, hi),
      ),
    ]);
    // Surface query failures instead of rendering an "all clear" director
    // summary (same swallowed-`error` class fixed in ai-billing-queue /
    // inbox-counts / billing-dashboard). The collectAllRows reads throw on
    // error directly (rejecting the Promise.all above).
    const headCountErr = [e0, e1, e2, e3, e4, e5, e6, e7, e8].find(Boolean);
    if (headCountErr) throw headCountErr;

    // PostgREST serialises bigint as a string; coerce defensively.
    const fulfillmentsToBillCount = Number(fulfillmentsToBillRaw ?? 0);

    // Money rollups.
    const dollarsInStuckSubmitted = stuckSubmitted.reduce(
      (s: number, c: { total_billed_cents: number | null }) =>
        s + (c.total_billed_cents ?? 0),
      0,
    );
    const dollarsInDeniedFresh = freshDenials.reduce(
      (s: number, c: { total_billed_cents: number | null }) =>
        s + (c.total_billed_cents ?? 0),
      0,
    );
    const dollarsInPatientResp = openPatientResp.reduce(
      (s: number, c: { patient_responsibility_cents: number | null }) =>
        s + (c.patient_responsibility_cents ?? 0),
      0,
    );

    // Top 5 payers by open patient_responsibility.
    const perPayer = new Map<string, number>();
    for (const c of openPatientResp) {
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
    for (const c of denialRateRows) {
      if (!c.decision_at) continue;
      const ageDays =
        (now - new Date(c.decision_at).getTime()) / (24 * 3600 * 1000);
      const bucket =
        ageDays <= 30 ? "d0_30" : ageDays <= 60 ? "d30_60" : "d60_90";
      buckets[bucket].dec += 1;
      if (isDenialStatus(c.status)) {
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
        staleDrafts: staleDraftsCount ?? 0,
        freshDenials: freshDenials.length,
        stuckSubmittedNoAck: stuckSubmitted.length,
        partialEras: partialErasCount ?? 0,
        fulfillmentsToBill: fulfillmentsToBillCount,
        scrubBlocking: scrubBlockingCount ?? 0,
        scrubFixable: scrubFixableCount ?? 0,
        deniedNeedsAnalysis: deniedNoAnalysisCount ?? 0,
        autoResubmitReady: autoResubmitReadyCount ?? 0,
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
