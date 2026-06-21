// /admin/referrals/scorecard + /admin/providers/:id/referral-activity —
// the referral-source CRM (relationship management for referring physicians).
//
// The B2B referral-source signal is insurance_claims.referring_provider_id ->
// providers (the claim's referring/ordering physician). This surface turns that
// into (1) a SCORECARD — which referring physicians drive the most claim
// volume, patients, and paid revenue (migration 0431 RPC) — and (2) a
// rep-ACTIVITY log so a sales/relationship owner can record visits/calls and
// the next action per referral source.
//
// Org-scoped: the scorecard RPC takes an explicit p_org_id; the activity log
// goes through getOrgScopedClient (auto org_id filter/tag). providers is a
// SHARED NPPES registry (no org_id) so provider existence is checked via the
// unscoped .raw() client. PHI posture: referral-source rows reference provider
// + claim aggregates, never patient identifiers; this module logs ids only.

import { Router, type IRouter } from "express";
import { z } from "zod";

import { logAudit } from "@workspace/resupply-audit";
import { getOrgScopedClient } from "@workspace/resupply-db";

import { logger } from "../../lib/logger";
import { adminRateLimit } from "../../middlewares/admin-rate-limit";
import { requirePermission } from "../../middlewares/requireAdmin";

const router: IRouter = Router();

const ACTIVITY_TYPES = [
  "visit",
  "call",
  "email",
  "lunch",
  "mailer",
  "other",
] as const;

const scorecardQuery = z
  .object({
    sinceDays: z.coerce.number().int().min(1).max(730).optional().default(90),
  })
  .strict();

const providerIdParams = z.object({ providerId: z.string().uuid() });

// The org-scoped facade and .raw().rpc() return loosely-typed data; cast the
// rows so the response mappers are type-checked.
interface ScorecardRpcRow {
  provider_id: string;
  provider_name: string | null;
  practice_name: string | null;
  npi: string | null;
  claim_count: number | string;
  patient_count: number | string;
  claims_since: number | string;
  paid_cents: number | string;
  last_activity_on: string | null;
}

interface ActivityRow {
  id: string;
  provider_id: string;
  activity_type: string;
  occurred_on: string;
  summary: string;
  next_action: string | null;
  created_by_email: string | null;
  created_at: string;
}

const activityBody = z
  .object({
    activityType: z.enum(ACTIVITY_TYPES).optional().default("visit"),
    occurredOn: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/, "expected YYYY-MM-DD")
      .optional(),
    summary: z.string().trim().min(1).max(2000),
    nextAction: z.string().trim().max(2000).nullish(),
  })
  .strict();

// GET /admin/referrals/scorecard — per referring-provider rollup.
router.get(
  "/admin/referrals/scorecard",
  requirePermission("reports.read"),
  async (req, res) => {
    const parsed = scorecardQuery.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json({ error: "invalid_query" });
      return;
    }
    const orgId = req.orgId;
    if (!orgId || !orgId.trim()) {
      res.status(500).json({ error: "tenant_context_missing" });
      return;
    }
    const since = new Date(
      Date.now() - parsed.data.sinceDays * 24 * 60 * 60 * 1000,
    ).toISOString();

    const supabase = getOrgScopedClient(orgId);
    const { data, error } = await supabase
      .raw()
      .schema("resupply")
      .rpc("referral_source_scorecard", { p_org_id: orgId, p_since: since });
    if (error) throw error;

    res.json({
      sinceDays: parsed.data.sinceDays,
      sources: ((data ?? []) as ScorecardRpcRow[]).map((r) => ({
        providerId: r.provider_id,
        providerName: r.provider_name,
        practiceName: r.practice_name,
        npi: r.npi,
        claimCount: Number(r.claim_count),
        patientCount: Number(r.patient_count),
        claimsSince: Number(r.claims_since),
        paidCents: Number(r.paid_cents),
        lastActivityOn: r.last_activity_on,
      })),
    });
  },
);

// GET /admin/providers/:providerId/referral-activity — rep-touch log.
router.get(
  "/admin/providers/:providerId/referral-activity",
  requirePermission("reports.read"),
  async (req, res) => {
    const idParsed = providerIdParams.safeParse(req.params);
    if (!idParsed.success) {
      res.status(400).json({ error: "invalid_id" });
      return;
    }
    const orgId = req.orgId;
    if (!orgId || !orgId.trim()) {
      res.status(500).json({ error: "tenant_context_missing" });
      return;
    }
    const supabase = getOrgScopedClient(orgId);
    const { data, error } = await supabase
      .from("referral_source_activity")
      .select(
        "id, provider_id, activity_type, occurred_on, summary, next_action, created_by_email, created_at",
      )
      .eq("provider_id", idParsed.data.providerId)
      .order("occurred_on", { ascending: false })
      .order("created_at", { ascending: false })
      .limit(200);
    if (error) throw error;

    res.json({
      providerId: idParsed.data.providerId,
      activity: ((data ?? []) as ActivityRow[]).map((r) => ({
        id: r.id,
        providerId: r.provider_id,
        activityType: r.activity_type,
        occurredOn: r.occurred_on,
        summary: r.summary,
        nextAction: r.next_action,
        createdByEmail: r.created_by_email,
        createdAt: r.created_at,
      })),
    });
  },
);

// POST /admin/providers/:providerId/referral-activity — log a rep touch.
router.post(
  "/admin/providers/:providerId/referral-activity",
  requirePermission("conversations.manage"),
  adminRateLimit({ name: "referral_source.activity_log", preset: "mutation" }),
  async (req, res) => {
    const idParsed = providerIdParams.safeParse(req.params);
    if (!idParsed.success) {
      res.status(400).json({ error: "invalid_id" });
      return;
    }
    const parsed = activityBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "invalid_body" });
      return;
    }
    const orgId = req.orgId;
    if (!orgId || !orgId.trim()) {
      res.status(500).json({ error: "tenant_context_missing" });
      return;
    }
    const providerId = idParsed.data.providerId;
    const supabase = getOrgScopedClient(orgId);

    // providers is a SHARED registry (no org_id) — validate existence on the
    // unscoped client so we don't log activity against a phantom provider.
    const { data: provider, error: provErr } = await supabase
      .raw()
      .schema("resupply")
      .from("providers")
      .select("id")
      .eq("id", providerId)
      .maybeSingle();
    if (provErr) throw provErr;
    if (!provider) {
      res.status(404).json({ error: "provider_not_found" });
      return;
    }

    const b = parsed.data;
    const { data: inserted, error: insErr } = await supabase
      .from("referral_source_activity")
      .insert({
        provider_id: providerId,
        activity_type: b.activityType,
        ...(b.occurredOn ? { occurred_on: b.occurredOn } : {}),
        summary: b.summary,
        next_action: b.nextAction ?? null,
        created_by_email: req.adminEmail ?? null,
        created_by_user_id: req.adminUserId ?? null,
      })
      .select("id, occurred_on")
      .single();
    if (insErr) throw insErr;

    await logAudit({
      action: "referral_source.activity_logged",
      adminEmail: req.adminEmail ?? null,
      adminUserId: req.adminUserId ?? null,
      targetTable: "referral_source_activity",
      targetId: inserted.id,
      metadata: { provider_id: providerId, activity_type: b.activityType },
      ip: req.ip ?? null,
      userAgent: req.get("user-agent") ?? null,
    }).catch((err) => {
      logger.warn({ err }, "referral_source.activity_logged audit failed");
    });

    res.status(201).json({ id: inserted.id, occurredOn: inserted.occurred_on });
  },
);

export default router;
