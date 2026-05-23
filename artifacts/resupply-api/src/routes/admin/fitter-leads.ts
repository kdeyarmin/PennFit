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
  "final_call_pending",
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
  // Optional "hot leads only" filter — drives the CSR outreach queue.
  // Truthy values: '1', 'true'. Anything else (incl. omitted) means
  // "no filter".
  hotOnly: z
    .string()
    .optional()
    .transform((v) => v === "1" || v === "true"),
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
    const { stage, source, hotOnly, limit } = parsed.data;
    const supabase = getSupabaseServiceRoleClient();

    let rowsQuery = supabase
      .schema("resupply")
      .from("fitter_leads")
      .select(
        "id, email, phone_e164, sms_opt_in, marketing_opt_in, source, journey_stage, recommended_mask_id, recommended_mask_name, recommended_mask_type, first_name, campaign_touch_count, last_campaign_touch_at, next_campaign_touch_at, first_order_id, first_order_placed_at, unsubscribed_at, completed_at, created_at, engagement_score, hot_lead_at, click_count, csr_contacted_at, csr_contacted_by, last_open_at, last_click_at, csr_notes, cold_skipped_at",
      )
      // Hot leads sort to the top when present (CSR outreach queue);
      // otherwise most-recently-completed first; falls back to
      // created_at for rows that never reached /results.
      .order("hot_lead_at", { ascending: false, nullsFirst: false })
      .order("completed_at", { ascending: false, nullsFirst: false })
      .order("created_at", { ascending: false })
      .limit(limit);
    if (stage !== "all") rowsQuery = rowsQuery.eq("journey_stage", stage);
    if (source !== "all") rowsQuery = rowsQuery.eq("source", source);
    if (hotOnly) rowsQuery = rowsQuery.not("hot_lead_at", "is", null);

    const { data: rows, error: listErr } = await rowsQuery;
    if (listErr) throw listErr;

    // KPI tile counts. PostgREST has no GROUP BY, so parallel
    // count-only queries — same shape as the insurance-leads admin
    // route. Each is index-backed by the partial indexes on
    // journey_stage.
    // Helper to start a count query with the source filter pre-applied
    // so all KPI tiles reflect the same source predicate the table uses.
    const countBase = () => {
      const q = supabase
        .schema("resupply")
        .from("fitter_leads")
        .select("*", { count: "exact", head: true });
      return source !== "all" ? q.eq("source", source) : q;
    };

    const [
      consentCount,
      completedCount,
      campaignActiveCount,
      reorderActiveCount,
      finalCallPendingCount,
      convertedCount,
      unsubscribedCount,
      expiredCount,
      hotLeadCount,
      hotNeedsContactCount,
    ] = await Promise.all([
      countBase().eq("journey_stage", "consent"),
      countBase().eq("journey_stage", "completed"),
      countBase().eq("journey_stage", "campaign_active"),
      countBase().eq("journey_stage", "reorder_active"),
      countBase().eq("journey_stage", "final_call_pending"),
      countBase().eq("journey_stage", "converted"),
      countBase().eq("journey_stage", "unsubscribed"),
      countBase().eq("journey_stage", "expired"),
      // Hot-lead tile: opted-in, in any pre-conversion stage, with
      // hot_lead_at stamped. The "active" count includes leads
      // whether or not a CSR has reached out yet.
      countBase()
        .not("hot_lead_at", "is", null)
        .is("first_order_id", null)
        .is("unsubscribed_at", null),
      // "Needs CSR contact" — narrower subset of the above. Mig
      // 0154 partial index `fitter_leads_hot_uncontacted_idx`
      // covers this exact predicate. THIS is the actionable
      // "call now" number for ops; the broader hotLeadsActive
      // includes leads ops has already worked.
      countBase()
        .not("hot_lead_at", "is", null)
        .is("csr_contacted_at", null)
        .is("first_order_id", null)
        .is("unsubscribed_at", null),
    ]);

    for (const r of [
      consentCount,
      completedCount,
      campaignActiveCount,
      reorderActiveCount,
      finalCallPendingCount,
      convertedCount,
      unsubscribedCount,
      expiredCount,
      hotLeadCount,
      hotNeedsContactCount,
    ]) {
      if (r.error) throw r.error;
    }

    const counts = {
      consent: consentCount.count ?? 0,
      completed: completedCount.count ?? 0,
      campaign_active: campaignActiveCount.count ?? 0,
      reorder_active: reorderActiveCount.count ?? 0,
      final_call_pending: finalCallPendingCount.count ?? 0,
      converted: convertedCount.count ?? 0,
      unsubscribed: unsubscribedCount.count ?? 0,
      expired: expiredCount.count ?? 0,
    };
    const hotLeadsActive = hotLeadCount.count ?? 0;
    const hotLeadsNeedingContact = hotNeedsContactCount.count ?? 0;

    // Conversion rate: (reorder_active + converted) / completed-cohort.
    // The reorder_active stage IS a converted lead — they bought
    // their first mask; the campaign just keeps nurturing them
    // toward supply re-orders. Excludes 'consent' (pre-completion)
    // and 'unsubscribed' (terminal opt-out). Returned as a float
    // on [0..1]; UI formats as a percent. final_call_pending
    // counts as unconverted — it's the "between T6 and T11"
    // holding pattern.
    const convertedTotal = counts.converted + counts.reorder_active;
    const denominator =
      counts.completed +
      counts.campaign_active +
      counts.reorder_active +
      counts.final_call_pending +
      counts.converted +
      counts.expired;
    const conversionRate =
      denominator > 0 ? convertedTotal / denominator : 0;

    req.log?.info?.(
      {
        rowCount: rows?.length ?? 0,
        filter: { stage, source, hotOnly: hotOnly === true },
        counts,
        hotLeadsActive,
        hotLeadsNeedingContact,
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
        engagementScore: r.engagement_score ?? 0,
        hotLeadAt: r.hot_lead_at,
        clickCount: r.click_count ?? 0,
        csrContactedAt: r.csr_contacted_at,
        csrContactedBy: r.csr_contacted_by,
        lastOpenAt: r.last_open_at,
        lastClickAt: r.last_click_at,
        csrNotes: r.csr_notes,
        coldSkippedAt: r.cold_skipped_at,
      })),
      counts,
      conversionRate,
      hotLeadsActive,
      hotLeadsNeedingContact,
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

// POST /admin/fitter-leads/:id/mark-contacted — CSR acknowledges
// outreach to a hot lead. Stamps csr_contacted_at + csr_contacted_by
// so the row drops out of the "hot leads needing contact" queue;
// hot_lead_at stays stamped (we keep the historical signal).
//
// Idempotent: a repeated call updates the stamp to the latest
// time so ops can see "I followed up again N minutes ago" rather
// than the original first-contact time. If that's a problem we
// can split into two columns (first_contacted vs latest_contacted)
// later — keeping it simple now.
router.post(
  "/admin/fitter-leads/:id/mark-contacted",
  requirePermission("conversations.manage"),
  adminRateLimit({ name: "fitter_leads.mark_contacted", preset: "mutation" }),
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
        csr_contacted_at: new Date().toISOString(),
        csr_contacted_by: req.adminEmail ?? null,
      })
      .eq("id", idParam)
      .select("id, csr_contacted_at, csr_contacted_by, hot_lead_at")
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
        wasHot: row.hot_lead_at !== null,
      },
      "admin/fitter-leads: marked contacted",
    );

    res.json({
      id: row.id,
      csrContactedAt: row.csr_contacted_at,
      csrContactedBy: row.csr_contacted_by,
    });
  },
);

// POST /admin/fitter-leads/:id/notes — set / replace the CSR
// free-text notes on a lead. Mig 0156.
//
// One field, one shape: the full note replaces whatever was there
// before. No edit history (intentional — this is operator
// scratchpad, not an audit log). Cleared by posting "" (empty
// string) or null.
const notesBody = z
  .object({
    notes: z
      .string()
      .trim()
      .max(2000)
      .nullish()
      .transform((v) => (v === undefined || v === null || v === "" ? null : v)),
  })
  .strict();

router.post(
  "/admin/fitter-leads/:id/notes",
  requirePermission("conversations.manage"),
  adminRateLimit({ name: "fitter_leads.notes", preset: "mutation" }),
  async (req, res) => {
    const idParam = req.params.id;
    if (typeof idParam !== "string" || !ID_RE.test(idParam)) {
      res.status(400).json({ error: "invalid_id" });
      return;
    }
    const parse = notesBody.safeParse(req.body);
    if (!parse.success) {
      res.status(400).json({
        error: "invalid_body",
        issues: parse.error.issues.map((i) => ({
          path: i.path.join("."),
          message: i.message,
        })),
      });
      return;
    }

    const supabase = getSupabaseServiceRoleClient();
    const { data: row, error } = await supabase
      .schema("resupply")
      .from("fitter_leads")
      .update({ csr_notes: parse.data.notes })
      .eq("id", idParam)
      .select("id, csr_notes")
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
        cleared: parse.data.notes === null,
      },
      "admin/fitter-leads: notes updated",
    );

    res.json({
      id: row.id,
      csrNotes: row.csr_notes,
    });
  },
);

// GET /admin/fitter-leads/metrics — per-touch send/open/click
// aggregates pulled from the fitter_campaign_touch_metrics view
// (mig 0155). One row per touch_index 1..11 even when the touch
// hasn't shipped yet (the view's generate_series outer join
// fills zero rows).
router.get(
  "/admin/fitter-leads/metrics",
  requirePermission("conversations.manage"),
  async (req, res) => {
    const supabase = getSupabaseServiceRoleClient();
    const { data: rows, error } = await supabase
      .schema("resupply")
      .from("fitter_campaign_touch_metrics")
      .select(
        "touch_index, email_sends, email_failures, opens, sms_sends, sms_failures, clicks",
      )
      .order("touch_index", { ascending: true });
    if (error) throw error;

    req.log?.info?.(
      { rowCount: rows?.length ?? 0 },
      "admin/fitter-leads/metrics: list",
    );

    // Compute open + click rates on the API side so the UI never
    // has to do the arithmetic + divide-by-zero guarding. Rate
    // = signal / email_sends because opens + clicks both ride
    // the email channel.
    res.json({
      touches: (rows ?? []).map((r) => {
        const sends = r.email_sends ?? 0;
        const opens = r.opens ?? 0;
        const clicks = r.clicks ?? 0;
        return {
          touchIndex: r.touch_index,
          emailSends: sends,
          emailFailures: r.email_failures ?? 0,
          smsSends: r.sms_sends ?? 0,
          smsFailures: r.sms_failures ?? 0,
          opens,
          clicks,
          openRate: sends > 0 ? opens / sends : 0,
          clickRate: sends > 0 ? clicks / sends : 0,
        };
      }),
    });
  },
);

// GET /admin/fitter-leads/metrics/variants — per-(touch, subject
// variant) breakdown. Sibling of the touch-rollup endpoint above;
// used by the admin UI's "expand for variants" affordance on
// touches that are running an A/B test. Returns rows only for
// (touch, variant) combinations that have actually shipped — the
// composer-side SUBJECT_VARIANTS registry is the source of truth
// for "which touches are testing what."
router.get(
  "/admin/fitter-leads/metrics/variants",
  requirePermission("conversations.manage"),
  async (req, res) => {
    const supabase = getSupabaseServiceRoleClient();
    const { data: rows, error } = await supabase
      .schema("resupply")
      .from("fitter_campaign_touch_variant_metrics")
      .select(
        "touch_index, subject_variant_key, email_sends, email_failures, opens, clicks",
      )
      .order("touch_index", { ascending: true })
      .order("subject_variant_key", { ascending: true });
    if (error) throw error;

    req.log?.info?.(
      { rowCount: rows?.length ?? 0 },
      "admin/fitter-leads/metrics/variants: list",
    );

    res.json({
      variants: (rows ?? []).map((r) => {
        const sends = r.email_sends ?? 0;
        const opens = r.opens ?? 0;
        const clicks = r.clicks ?? 0;
        return {
          touchIndex: r.touch_index,
          subjectVariantKey: r.subject_variant_key,
          emailSends: sends,
          emailFailures: r.email_failures ?? 0,
          opens,
          clicks,
          openRate: sends > 0 ? opens / sends : 0,
          clickRate: sends > 0 ? clicks / sends : 0,
        };
      }),
    });
  },
);

// GET /admin/fitter-leads/:id/timeline — chronological event log
// for CSR call-prep. Pulls from fitter_campaign_touches +
// fitter_campaign_clicks + the lead row's lifecycle columns, then
// sorts by timestamp and returns a flat array.
//
// Each event has { ts, kind, label, detail? }. The UI renders this
// directly as a vertical timeline; clients can also filter on the
// kind enum.
router.get(
  "/admin/fitter-leads/:id/timeline",
  requirePermission("conversations.manage"),
  async (req, res) => {
    const idParam = req.params.id;
    if (typeof idParam !== "string" || !ID_RE.test(idParam)) {
      res.status(400).json({ error: "invalid_id" });
      return;
    }

    const supabase = getSupabaseServiceRoleClient();

    // Fetch the lead row + its full audit history in parallel.
    const [leadResult, touchesResult, clicksResult] = await Promise.all([
      supabase
        .schema("resupply")
        .from("fitter_leads")
        .select(
          "id, email, first_name, journey_stage, created_at, completed_at, unsubscribed_at, csr_contacted_at, csr_contacted_by, hot_lead_at, first_order_placed_at, last_open_at, last_click_at, recommended_mask_name, cold_skipped_at",
        )
        .eq("id", idParam)
        .maybeSingle(),
      supabase
        .schema("resupply")
        .from("fitter_campaign_touches")
        .select(
          "touch_index, channel, status, sent_at, first_opened_at, last_opened_at, open_count, error_message",
        )
        .eq("lead_id", idParam)
        .order("sent_at", { ascending: true }),
      supabase
        .schema("resupply")
        .from("fitter_campaign_clicks")
        .select("touch_index, link_key, clicked_at")
        .eq("lead_id", idParam)
        .order("clicked_at", { ascending: true }),
    ]);

    if (leadResult.error) throw leadResult.error;
    if (touchesResult.error) throw touchesResult.error;
    if (clicksResult.error) throw clicksResult.error;

    const lead = leadResult.data;
    if (!lead) {
      res.status(404).json({ error: "not_found" });
      return;
    }

    type TimelineEvent = {
      ts: string;
      kind: string;
      label: string;
      detail?: string | null;
    };
    const events: TimelineEvent[] = [];

    if (lead.created_at) {
      events.push({
        ts: lead.created_at,
        kind: "lead_created",
        label: "Lead created at /consent",
      });
    }
    if (lead.completed_at) {
      events.push({
        ts: lead.completed_at,
        kind: "fitter_completed",
        label: "Fitter completed — saw the recommendation",
        detail: lead.recommended_mask_name,
      });
    }
    for (const t of touchesResult.data ?? []) {
      if (t.status === "sent") {
        events.push({
          ts: t.sent_at as string,
          kind: `touch_sent_${t.channel}`,
          label: `T${t.touch_index} ${t.channel} sent`,
        });
        if (t.first_opened_at) {
          events.push({
            ts: t.first_opened_at as string,
            kind: "touch_opened",
            label: `Opened T${t.touch_index}`,
            detail:
              (t.open_count ?? 0) > 1
                ? `${t.open_count} opens through ${t.last_opened_at ?? t.first_opened_at}`
                : null,
          });
        }
      } else if (t.status === "failed") {
        events.push({
          ts: t.sent_at as string,
          kind: `touch_failed_${t.channel}`,
          label: `T${t.touch_index} ${t.channel} send failed`,
          detail: t.error_message,
        });
      }
    }
    for (const c of clicksResult.data ?? []) {
      events.push({
        ts: c.clicked_at as string,
        kind: "click",
        label: `Clicked "${c.link_key}" from T${c.touch_index}`,
      });
    }
    if (lead.hot_lead_at) {
      events.push({
        ts: lead.hot_lead_at,
        kind: "hot_flipped",
        label: "Flipped to hot lead",
      });
    }
    if (lead.cold_skipped_at) {
      events.push({
        ts: lead.cold_skipped_at,
        kind: "cold_skipped",
        label: "T5+T6 cold-skipped — fast-forwarded to T11",
      });
    }
    if (lead.csr_contacted_at) {
      events.push({
        ts: lead.csr_contacted_at,
        kind: "csr_contacted",
        label: "CSR contacted",
        detail: lead.csr_contacted_by,
      });
    }
    if (lead.first_order_placed_at) {
      events.push({
        ts: lead.first_order_placed_at,
        kind: "order_placed",
        label: "First order placed",
      });
    }
    if (lead.unsubscribed_at) {
      events.push({
        ts: lead.unsubscribed_at,
        kind: "unsubscribed",
        label: "Unsubscribed",
      });
    }

    events.sort((a, b) => a.ts.localeCompare(b.ts));

    req.log?.info?.(
      { leadId: lead.id, eventCount: events.length },
      "admin/fitter-leads/:id/timeline: list",
    );

    res.json({
      leadId: lead.id,
      // Counts-only log — never per-event detail to the
      // browser console (events carry no PHI, but discipline).
      events,
    });
  },
);

export default router;
