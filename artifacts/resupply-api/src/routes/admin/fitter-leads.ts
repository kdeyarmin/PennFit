// /admin/fitter-leads/* — visibility + light controls for the
// fitter-to-supply campaign funnel.
//
// Endpoints (all requireAdmin-gated):
//
//   GET   /admin/fitter-leads?stage=campaign_active
//                                  — paginated list with KPI tile counts.
//                                    Default sort: most-recently
//                                    completed first.
//   POST  /admin/fitter-leads/:id/unsubscribe
//                                  — manual force-unsubscribe (CSR-
//                                    operated; e.g. patient called in
//                                    asking off the list and we'd
//                                    rather not wait for them to
//                                    click the email link).
//
// PHI handling
// ------------
// The list returns email, phone, and the recommended mask. Every
// admin who can hit /admin/* has cleared the PHI-access policy gate
// (requireAdmin + the team allowlist). Counts-only audit line per
// list call mirrors the policy used by insurance-leads.

import { Router, type IRouter } from "express";
import { z } from "zod";

import { getSupabaseServiceRoleClient } from "@workspace/resupply-db";

import { adminRateLimit } from "../../middlewares/admin-rate-limit";
import { requirePermission } from "../../middlewares/requireAdmin";

const router: IRouter = Router();

const JOURNEY_STAGES = [
  "consent",
  "completed",
  "campaign_active",
  "reorder_active",
  "converted",
  "unsubscribed",
  "expired",
] as const;

const listQuery = z.object({
  stage: z
    .enum(["all", ...JOURNEY_STAGES] as [
      "all",
      ...typeof JOURNEY_STAGES,
    ])
    .optional()
    .default("all"),
  // Optional source filter (consent / sleep_apnea_quiz / insurance_quote).
  // 'all' returns every source.
  source: z
    .enum(["all", "consent", "sleep_apnea_quiz", "insurance_quote"])
    .optional()
    .default("all"),
  limit: z
    .string()
    .optional()
    .transform((v) => {
      const n = v ? Number.parseInt(v, 10) : 100;
      if (!Number.isFinite(n)) return 100;
      return Math.max(1, Math.min(200, n));
    }),
});

const ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Lookup gate: same admin scope as the insurance-leads queue. Both
// are top-of-funnel lead surfaces handled by the same CSR cohort.
router.get(
  "/admin/fitter-leads",
  requirePermission("conversations.manage"),
  async (req, res) => {
    const parsed = listQuery.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json({ error: "invalid_query" });
      return;
    }
    const { stage, source, limit } = parsed.data;
    const supabase = getSupabaseServiceRoleClient();

    let rowsQuery = supabase
      .schema("resupply")
      .from("fitter_leads")
      .select(
        "id, email, phone_e164, sms_opt_in, marketing_opt_in, source, journey_stage, recommended_mask_id, recommended_mask_name, recommended_mask_type, first_name, campaign_touch_count, last_campaign_touch_at, next_campaign_touch_at, first_order_id, first_order_placed_at, unsubscribed_at, completed_at, created_at",
      )
      // Most-recently-completed first when looking at the in-funnel
      // bucket; falls back to created_at for rows that never reached
      // /results.
      .order("completed_at", { ascending: false, nullsFirst: false })
      .order("created_at", { ascending: false })
      .limit(limit);
    if (stage !== "all") rowsQuery = rowsQuery.eq("journey_stage", stage);
    if (source !== "all") rowsQuery = rowsQuery.eq("source", source);

    const { data: rows, error: listErr } = await rowsQuery;
    if (listErr) throw listErr;

    // KPI tile counts. PostgREST has no GROUP BY, so parallel
    // count-only queries — same shape as the insurance-leads admin
    // route. Each is index-backed by the partial indexes on
    // journey_stage.
    const [
      consentCount,
      completedCount,
      campaignActiveCount,
      reorderActiveCount,
      convertedCount,
      unsubscribedCount,
      expiredCount,
    ] = await Promise.all([
      supabase
        .schema("resupply")
        .from("fitter_leads")
        .select("*", { count: "exact", head: true })
        .eq("journey_stage", "consent"),
      supabase
        .schema("resupply")
        .from("fitter_leads")
        .select("*", { count: "exact", head: true })
        .eq("journey_stage", "completed"),
      supabase
        .schema("resupply")
        .from("fitter_leads")
        .select("*", { count: "exact", head: true })
        .eq("journey_stage", "campaign_active"),
      supabase
        .schema("resupply")
        .from("fitter_leads")
        .select("*", { count: "exact", head: true })
        .eq("journey_stage", "reorder_active"),
      supabase
        .schema("resupply")
        .from("fitter_leads")
        .select("*", { count: "exact", head: true })
        .eq("journey_stage", "converted"),
      supabase
        .schema("resupply")
        .from("fitter_leads")
        .select("*", { count: "exact", head: true })
        .eq("journey_stage", "unsubscribed"),
      supabase
        .schema("resupply")
        .from("fitter_leads")
        .select("*", { count: "exact", head: true })
        .eq("journey_stage", "expired"),
    ]);

    for (const r of [
      consentCount,
      completedCount,
      campaignActiveCount,
      reorderActiveCount,
      convertedCount,
      unsubscribedCount,
      expiredCount,
    ]) {
      if (r.error) throw r.error;
    }

    const counts = {
      consent: consentCount.count ?? 0,
      completed: completedCount.count ?? 0,
      campaign_active: campaignActiveCount.count ?? 0,
      reorder_active: reorderActiveCount.count ?? 0,
      converted: convertedCount.count ?? 0,
      unsubscribed: unsubscribedCount.count ?? 0,
      expired: expiredCount.count ?? 0,
    };

    // Conversion rate: (reorder_active + converted) / completed-cohort.
    // The reorder_active stage IS a converted lead — they bought
    // their first mask; the campaign just keeps nurturing them
    // toward supply re-orders. Excludes 'consent' (pre-completion)
    // and 'unsubscribed' (terminal opt-out). Returned as a float
    // on [0..1]; UI formats as a percent.
    const convertedTotal = counts.converted + counts.reorder_active;
    const denominator =
      counts.completed +
      counts.campaign_active +
      counts.reorder_active +
      counts.converted +
      counts.expired;
    const conversionRate =
      denominator > 0 ? convertedTotal / denominator : 0;

    req.log?.info?.(
      {
        rowCount: rows?.length ?? 0,
        filter: { stage, source },
        counts,
      },
      "admin/fitter-leads: list",
    );

    res.json({
      rows: (rows ?? []).map((r) => ({
        id: r.id,
        email: r.email,
        phoneE164: r.phone_e164,
        smsOptIn: r.sms_opt_in,
        marketingOptIn: r.marketing_opt_in,
        source: r.source,
        journeyStage: r.journey_stage,
        recommendedMaskId: r.recommended_mask_id,
        recommendedMaskName: r.recommended_mask_name,
        recommendedMaskType: r.recommended_mask_type,
        firstName: r.first_name,
        campaignTouchCount: r.campaign_touch_count ?? 0,
        lastCampaignTouchAt: r.last_campaign_touch_at,
        nextCampaignTouchAt: r.next_campaign_touch_at,
        firstOrderId: r.first_order_id,
        firstOrderPlacedAt: r.first_order_placed_at,
        unsubscribedAt: r.unsubscribed_at,
        completedAt: r.completed_at,
        createdAt: r.created_at,
      })),
      counts,
      conversionRate,
    });
  },
);

router.post(
  "/admin/fitter-leads/:id/unsubscribe",
  requirePermission("conversations.manage"),
  adminRateLimit({ name: "fitter_leads.unsubscribe", preset: "mutation" }),
  async (req, res) => {
    const idParam = req.params.id;
    if (typeof idParam !== "string" || !ID_RE.test(idParam)) {
      res.status(400).json({ error: "invalid_id" });
      return;
    }

    const supabase = getSupabaseServiceRoleClient();
    const { data: row, error } = await supabase
      .schema("resupply")
      .from("fitter_leads")
      .update({
        journey_stage: "unsubscribed",
        unsubscribed_at: new Date().toISOString(),
        next_campaign_touch_at: null,
      })
      .eq("id", idParam)
      .select("id, journey_stage, unsubscribed_at")
      .maybeSingle();
    if (error) throw error;
    if (!row) {
      res.status(404).json({ error: "not_found" });
      return;
    }

    req.log?.info?.(
      {
        leadId: row.id,
        actor: req.adminEmail ?? null,
      },
      "admin/fitter-leads: manual unsubscribe",
    );

    res.json({
      id: row.id,
      journeyStage: row.journey_stage,
      unsubscribedAt: row.unsubscribed_at,
    });
  },
);

export default router;
