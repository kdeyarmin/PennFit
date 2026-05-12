// /admin/bulk-campaigns — staging-side surface for bulk-email
// campaigns. Phase A: draft create + list + detail + cancel.
// Phase B will add the send-side worker that drains the
// bulk_campaign_recipients table.
//
//   POST   /admin/bulk-campaigns/draft       — resolve audience +
//                                               persist draft +
//                                               recipients
//   GET    /admin/bulk-campaigns             — list (default newest)
//   GET    /admin/bulk-campaigns/:id         — detail + counts +
//                                               first 200 recipients
//   POST   /admin/bulk-campaigns/:id/cancel  — flip draft to
//                                               cancelled (terminal)

import { Router, type IRouter } from "express";
import { z } from "zod";

import { logAudit } from "@workspace/resupply-audit";
import {
  type Database,
  getSupabaseServiceRoleClient,
} from "@workspace/resupply-db";

import { fetchAudienceCandidates } from "../../lib/bulk-campaigns/fetch-candidates";
import {
  resolveAudience,
  type AudienceKind,
  type Category,
} from "../../lib/bulk-campaigns/resolve-audience";
import {
  isLegalCampaignTransition,
  type CampaignStatus,
} from "../../lib/bulk-campaigns/dispatch-helpers";
import { logger } from "../../lib/logger";
import { requireAdmin } from "../../middlewares/requireAdmin";
import { getBoss } from "../../worker/index.js";
import { enqueueImmediateTick } from "../../worker/jobs/bulk-campaign-tick.js";

const router: IRouter = Router();

const idParam = z.object({ id: z.string().uuid() });

const AUDIENCE_KIND_VALUES: AudienceKind[] = [
  "all_active_shop_customers",
  "all_active_patients",
  "by_patient_payer",
  "manual_list",
];
const CATEGORY_VALUES: Category[] = ["marketing", "service", "compliance"];

const draftBody = z
  .object({
    name: z.string().trim().min(1).max(200),
    description: z.string().trim().max(5000).nullable().optional(),
    audienceKind: z.enum(AUDIENCE_KIND_VALUES as [AudienceKind, ...AudienceKind[]]),
    audiencePayer: z.string().trim().max(120).nullable().optional(),
    /** Required when audienceKind='manual_list'. Each id is a UUID;
     *  recipientKind is determined by the order in shop/patient
     *  arrays. */
    manualShopCustomerIds: z.array(z.string().uuid()).max(50_000).optional(),
    manualPatientIds: z.array(z.string().uuid()).max(50_000).optional(),
    category: z.enum(CATEGORY_VALUES as [Category, ...Category[]]),
    complianceAttestation: z
      .string()
      .trim()
      .max(2000)
      .nullable()
      .optional(),
    templateKey: z.string().trim().min(1).max(120),
    throttlePerMinute: z
      .number()
      .int()
      .min(1)
      .max(3600)
      .optional()
      .default(120),
  })
  .strict()
  .refine(
    (b) =>
      b.audienceKind !== "by_patient_payer" ||
      (b.audiencePayer && b.audiencePayer.trim().length > 0),
    {
      path: ["audiencePayer"],
      message: "audiencePayer is required when audienceKind=by_patient_payer.",
    },
  )
  .refine(
    (b) =>
      b.category !== "compliance" ||
      (b.complianceAttestation &&
        b.complianceAttestation.trim().length >= 10),
    {
      path: ["complianceAttestation"],
      message:
        "complianceAttestation (≥ 10 chars) is required when category=compliance.",
    },
  );

router.post(
  "/admin/bulk-campaigns/draft",
  requireAdmin,
  async (req, res) => {
    const parsed = draftBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({
        error: "invalid_body",
        issues: parsed.error.issues.map((i) => ({
          path: i.path.join("."),
          message: i.message,
        })),
      });
      return;
    }
    const b = parsed.data;
    const supabase = getSupabaseServiceRoleClient();

    // Verify the template exists + is active for the channel we're
    // about to send. The send-side worker will re-check at send
    // time too (handles late deactivation), but failing here keeps
    // a CSR from creating a campaign against a typo'd key.
    const { data: tpl, error: tplErr } = await supabase
      .schema("resupply")
      .from("message_templates")
      .select("template_key, channel, is_active")
      .eq("template_key", b.templateKey)
      .eq("channel", "email")
      .limit(1)
      .maybeSingle();
    if (tplErr) {
      logger.error({ err: tplErr }, "bulk_campaigns.draft.create: template lookup failed");
      res.status(500).json({
        error: "template_lookup_failed",
        message: "Failed to verify template — database error.",
      });
      return;
    }
    if (!tpl) {
      res.status(400).json({
        error: "template_not_found",
        message: `No active email template with key "${b.templateKey}".`,
      });
      return;
    }
    if (!tpl.is_active) {
      res.status(400).json({
        error: "template_inactive",
        message: `Template "${b.templateKey}" is inactive.`,
      });
      return;
    }

    // ── Pull candidates ───────────────────────────────────────────
    const { shopCandidates, patientCandidates } =
      await fetchAudienceCandidates(supabase, {
        audienceKind: b.audienceKind,
        audiencePayer: b.audiencePayer,
        manualShopCustomerIds: b.manualShopCustomerIds,
        manualPatientIds: b.manualPatientIds,
      });
    const resolved = resolveAudience({
      audienceKind: b.audienceKind,
      audiencePayer: b.audiencePayer ?? null,
      category: b.category,
      shopCustomers: shopCandidates,
      patients: patientCandidates,
    });

    // ── Persist the campaign + recipients ─────────────────────────
    const { data: campaign, error: campaignErr } = await supabase
      .schema("resupply")
      .from("bulk_campaigns")
      .insert({
        name: b.name,
        description: b.description ?? null,
        audience_kind: b.audienceKind,
        audience_payer: b.audiencePayer ?? null,
        channel: "email",
        category: b.category,
        compliance_attestation: b.complianceAttestation ?? null,
        template_key: b.templateKey,
        throttle_per_minute: b.throttlePerMinute,
        status: "draft",
        created_by_user_id: req.adminUserId ?? null,
        total_recipients: resolved.totals.total,
        suppressed_count: resolved.totals.suppressed,
      })
      .select("id")
      .single();
    if (campaignErr) throw campaignErr;

    if (resolved.recipients.length > 0) {
      // PostgREST insert handles up to ~1000 rows comfortably;
      // batch in 500-row chunks to stay well under that.
      const BATCH = 500;
      for (let i = 0; i < resolved.recipients.length; i += BATCH) {
        const slice = resolved.recipients.slice(i, i + BATCH).map((r) => ({
          campaign_id: campaign.id,
          recipient_kind: r.recipientKind,
          recipient_id: r.recipientId,
          recipient_email: r.recipientEmail,
          status: r.status,
          suppression_reason: r.suppressionReason,
        }));
        const { error } = await supabase
          .schema("resupply")
          .from("bulk_campaign_recipients")
          .insert(slice);
        if (error) throw error;
      }
    }

    await logAudit({
      action: "bulk_campaign.draft.create",
      adminEmail: req.adminEmail ?? null,
      adminUserId: req.adminUserId ?? null,
      targetTable: "bulk_campaigns",
      targetId: campaign.id,
      metadata: {
        audience_kind: b.audienceKind,
        category: b.category,
        template_key: b.templateKey,
        total: resolved.totals.total,
        pending: resolved.totals.pending,
        suppressed: resolved.totals.suppressed,
        // Recipient ids/emails withheld — the row count alone is
        // the meaningful audit dimension here.
      },
      ip: req.ip ?? null,
      userAgent: req.get("user-agent") ?? null,
    }).catch((err) => {
      logger.warn({ err }, "bulk_campaign.draft.create audit failed");
    });

    res.status(201).json({
      id: campaign.id,
      totals: resolved.totals,
    });
  },
);

router.get("/admin/bulk-campaigns", requireAdmin, async (_req, res) => {
  const supabase = getSupabaseServiceRoleClient();
  const { data, error } = await supabase
    .schema("resupply")
    .from("bulk_campaigns")
    .select("*")
    .order("created_at", { ascending: false })
    .limit(100);
  if (error) throw error;
  res.json({
    campaigns: (data ?? []).map((r) => ({
      id: r.id,
      name: r.name,
      description: r.description,
      audienceKind: r.audience_kind,
      audiencePayer: r.audience_payer,
      channel: r.channel,
      category: r.category,
      templateKey: r.template_key,
      throttlePerMinute: r.throttle_per_minute,
      status: r.status,
      totalRecipients: r.total_recipients,
      pendingRecipients:
        r.total_recipients - r.suppressed_count - r.sent_count - r.failed_count,
      suppressedCount: r.suppressed_count,
      sentCount: r.sent_count,
      failedCount: r.failed_count,
      createdAt: r.created_at,
      startedAt: r.started_at,
      completedAt: r.completed_at,
      cancelledAt: r.cancelled_at,
    })),
  });
});

router.get(
  "/admin/bulk-campaigns/:id",
  requireAdmin,
  async (req, res) => {
    const params = idParam.safeParse(req.params);
    if (!params.success) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    const supabase = getSupabaseServiceRoleClient();
    const { data: row, error } = await supabase
      .schema("resupply")
      .from("bulk_campaigns")
      .select("*")
      .eq("id", params.data.id)
      .limit(1)
      .maybeSingle();
    if (error) throw error;
    if (!row) {
      res.status(404).json({ error: "not_found" });
      return;
    }

    // Surface the first 200 recipients for the SPA preview.
    // Suppressed-first ordering puts the reasons in front of the
    // CSR (they're what needs explaining).
    const { data: recipients, error: rErr } = await supabase
      .schema("resupply")
      .from("bulk_campaign_recipients")
      .select(
        "id, recipient_kind, recipient_id, recipient_email, status, suppression_reason",
      )
      .eq("campaign_id", row.id)
      .order("status", { ascending: false })
      .limit(200);
    if (rErr) throw rErr;

    res.json({
      id: row.id,
      name: row.name,
      description: row.description,
      audienceKind: row.audience_kind,
      audiencePayer: row.audience_payer,
      channel: row.channel,
      category: row.category,
      complianceAttestation: row.compliance_attestation,
      templateKey: row.template_key,
      throttlePerMinute: row.throttle_per_minute,
      status: row.status,
      totalRecipients: row.total_recipients,
      suppressedCount: row.suppressed_count,
      sentCount: row.sent_count,
      failedCount: row.failed_count,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      startedAt: row.started_at,
      completedAt: row.completed_at,
      cancelledAt: row.cancelled_at,
      recipients: (recipients ?? []).map((r) => ({
        id: r.id,
        recipientKind: r.recipient_kind,
        recipientId: r.recipient_id,
        recipientEmail: r.recipient_email,
        status: r.status,
        suppressionReason: r.suppression_reason,
      })),
    });
  },
);

// ── Lifecycle transitions (Phase B) ────────────────────────────────
//
// start  : draft   → sending   + enqueue an immediate tick
// pause  : sending → paused    (worker exits on next tick)
// resume : paused  → sending   + enqueue an immediate tick
// cancel : * → cancelled       (terminal; sent/cancelled are no-ops
//          unless they're already in that state, in which case 409)
//
// All four routes share the same /:id/:action shape with a single
// handler that does the legal-transition check and the side effects.

interface TransitionPlan {
  to: CampaignStatus;
  /** Per-transition audit action. */
  auditAction: string;
  /** Side effect to run after the DB update succeeds. */
  sideEffect?: (campaignId: string) => Promise<void>;
}

function planFor(action: "start" | "pause" | "resume" | "cancel"): TransitionPlan {
  switch (action) {
    case "start":
      return {
        to: "sending",
        auditAction: "bulk_campaign.start",
        sideEffect: async (id) => {
          const boss = getBoss();
          if (boss) {
            await enqueueImmediateTick(boss, id);
          } else {
            // The worker isn't booted (dev / test environment).
            // Mark the campaign sending anyway — the next worker
            // boot will pick it up via its own tick discovery if
            // we add one, or an admin can re-start once the
            // worker is up.
            logger.warn(
              { campaignId: id },
              "bulk_campaign.start: worker not running; campaign queued but no tick enqueued",
            );
          }
        },
      };
    case "pause":
      return { to: "paused", auditAction: "bulk_campaign.pause" };
    case "resume":
      return {
        to: "sending",
        auditAction: "bulk_campaign.resume",
        sideEffect: async (id) => {
          const boss = getBoss();
          if (boss) {
            await enqueueImmediateTick(boss, id);
          }
        },
      };
    case "cancel":
      return { to: "cancelled", auditAction: "bulk_campaign.cancel" };
  }
}

function makeTransitionHandler(
  action: "start" | "pause" | "resume" | "cancel",
) {
  return async (req: import("express").Request, res: import("express").Response) => {
    const params = idParam.safeParse(req.params);
    if (!params.success) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    const supabase = getSupabaseServiceRoleClient();

    const { data: existing, error: getErr } = await supabase
      .schema("resupply")
      .from("bulk_campaigns")
      .select("id, status, total_recipients, suppressed_count")
      .eq("id", params.data.id)
      .limit(1)
      .maybeSingle();
    if (getErr) throw getErr;
    if (!existing) {
      res.status(404).json({ error: "not_found" });
      return;
    }

    const plan = planFor(action);
    if (!isLegalCampaignTransition(existing.status, plan.to)) {
      res.status(409).json({
        error: "invalid_transition",
        message: `Cannot ${action} a campaign in status "${existing.status}".`,
      });
      return;
    }

    // Defensive: don't start a campaign whose entire audience is
    // suppressed — the worker would immediately mark it sent with
    // zero deliveries, which is misleading. Surface a clear 409
    // instead so the CSR can rebuild the audience.
    if (
      action === "start" &&
      existing.total_recipients - existing.suppressed_count <= 0
    ) {
      res.status(409).json({
        error: "no_pending_recipients",
        message:
          "Every recipient in this campaign is suppressed; cancel it and build a new audience.",
      });
      return;
    }

    const nowIso = new Date().toISOString();
    const updates: Database["resupply"]["Tables"]["bulk_campaigns"]["Update"] =
      { status: plan.to };
    if (action === "start" && existing.status === "draft") {
      updates.started_at = nowIso;
    }
    if (action === "cancel") {
      updates.cancelled_at = nowIso;
      updates.cancelled_by_user_id = req.adminUserId ?? null;
    }

    const { data: updated, error: updErr } = await supabase
      .schema("resupply")
      .from("bulk_campaigns")
      .update(updates)
      .eq("id", params.data.id)
      .eq("status", existing.status)
      .select("id");
    if (updErr) throw updErr;
    if (!updated || updated.length === 0) {
      res.status(409).json({
        error: "status_conflict",
        message: `Campaign status changed during ${action} operation — retry.`,
      });
      return;
    }

    if (plan.sideEffect) {
      try {
        await plan.sideEffect(params.data.id);
      } catch (err) {
        logger.error(
          {
            campaignId: params.data.id,
            action,
            err: err instanceof Error ? err.message : String(err),
          },
          `bulk_campaign.${action}: side effect failed`,
        );
        // Don't roll back the status update — the audit captures
        // the failed side-effect and a CSR can re-trigger the
        // action (e.g. resume from paused) to retry the tick
        // enqueue.
      }
    }

    await logAudit({
      action: plan.auditAction,
      adminEmail: req.adminEmail ?? null,
      adminUserId: req.adminUserId ?? null,
      targetTable: "bulk_campaigns",
      targetId: params.data.id,
      metadata: {
        from_status: existing.status,
        to_status: plan.to,
      },
      ip: req.ip ?? null,
      userAgent: req.get("user-agent") ?? null,
    }).catch((err) => {
      logger.warn({ err }, `${plan.auditAction} audit failed`);
    });

    res.status(200).json({ id: params.data.id, status: plan.to });
  };
}

router.post(
  "/admin/bulk-campaigns/:id/start",
  requireAdmin,
  makeTransitionHandler("start"),
);
router.post(
  "/admin/bulk-campaigns/:id/pause",
  requireAdmin,
  makeTransitionHandler("pause"),
);
router.post(
  "/admin/bulk-campaigns/:id/resume",
  requireAdmin,
  makeTransitionHandler("resume"),
);
router.post(
  "/admin/bulk-campaigns/:id/cancel",
  requireAdmin,
  makeTransitionHandler("cancel"),
);

// ────────────────────────────────────────────────────────────────
// POST /admin/bulk-campaigns/:id/regenerate-audience — re-resolve
// the audience for a campaign that's still in `draft` status.
//
// Operational reality: a CSR drafts a campaign Monday, audience
// is 1,200 patients. Wednesday a few patients opt out, a few new
// ones join. Friday the CSR wants to send — without regenerate
// they're sending against a stale list.
//
// Behavior:
//   * Refuses non-draft campaigns (409 not_in_draft).
//   * Re-fetches candidates using the SAME audienceKind/payer the
//     draft was created with (we don't re-take manual_list inputs;
//     they were a CSR-curated list and re-running against the same
//     ids is what we want).
//   * Wipes existing bulk_campaign_recipients for the campaign,
//     then inserts the freshly resolved set in 500-row batches.
//   * Updates the campaign's materialized counters.
//   * Idempotent across re-runs (each call replaces the snapshot).
// ────────────────────────────────────────────────────────────────
router.post(
  "/admin/bulk-campaigns/:id/regenerate-audience",
  requireAdmin,
  async (req, res) => {
    const idCheck = z.string().uuid().safeParse(req.params.id);
    if (!idCheck.success) {
      res.status(404).json({ error: "campaign_not_found" });
      return;
    }
    const supabase = getSupabaseServiceRoleClient();
    const { data: campaign, error: lookupErr } = await supabase
      .schema("resupply")
      .from("bulk_campaigns")
      .select("id, status, audience_kind, audience_payer, category")
      .eq("id", idCheck.data)
      .limit(1)
      .maybeSingle();
    if (lookupErr) throw lookupErr;
    if (!campaign) {
      res.status(404).json({ error: "campaign_not_found" });
      return;
    }
    if (campaign.status !== "draft") {
      res.status(409).json({
        error: "not_in_draft",
        message: `Cannot regenerate audience on a campaign in ${campaign.status} status. Cancel and create a new draft.`,
      });
      return;
    }

    // manual_list regenerates aren't supported via this endpoint —
    // the original manual ids are NOT pinned on bulk_campaigns
    // (they live only on the recipients table at create time).
    // For manual lists, the CSR's intent is "the list I picked is
    // the list"; refusing here keeps the operation honest.
    if (campaign.audience_kind === "manual_list") {
      res.status(409).json({
        error: "manual_list_not_regenerable",
        message:
          "manual_list campaigns are pinned to the ids picked at draft time. Cancel and create a fresh draft to change the list.",
      });
      return;
    }

    const { shopCandidates, patientCandidates } =
      await fetchAudienceCandidates(supabase, {
        audienceKind: campaign.audience_kind as AudienceKind,
        audiencePayer: campaign.audience_payer,
      });

    const resolved = resolveAudience({
      audienceKind: campaign.audience_kind as AudienceKind,
      audiencePayer: campaign.audience_payer,
      category: campaign.category as Category,
      shopCustomers: shopCandidates,
      patients: patientCandidates,
    });

    // Wipe the prior snapshot. We don't soft-delete — the audit
    // log records "regenerate happened at T with totals X" and
    // that's the audit story; the prior recipient rows aren't
    // re-needed.
    const { error: delErr } = await supabase
      .schema("resupply")
      .from("bulk_campaign_recipients")
      .delete()
      .eq("campaign_id", idCheck.data);
    if (delErr) throw delErr;

    if (resolved.recipients.length > 0) {
      const BATCH = 500;
      for (let i = 0; i < resolved.recipients.length; i += BATCH) {
        const slice = resolved.recipients.slice(i, i + BATCH).map((r) => ({
          campaign_id: idCheck.data,
          recipient_kind: r.recipientKind,
          recipient_id: r.recipientId,
          recipient_email: r.recipientEmail,
          status: r.status,
          suppression_reason: r.suppressionReason,
        }));
        const { error } = await supabase
          .schema("resupply")
          .from("bulk_campaign_recipients")
          .insert(slice);
        if (error) throw error;
      }
    }

    // Refresh materialized counters.
    const { error: updErr } = await supabase
      .schema("resupply")
      .from("bulk_campaigns")
      .update({
        total_recipients: resolved.totals.total,
        suppressed_count: resolved.totals.suppressed,
        sent_count: 0,
        failed_count: 0,
        updated_at: new Date().toISOString(),
      })
      .eq("id", idCheck.data);
    if (updErr) throw updErr;

    await logAudit({
      action: "bulk_campaign.audience.regenerated",
      adminEmail: req.adminEmail ?? null,
      adminUserId: req.adminUserId ?? null,
      targetTable: "bulk_campaigns",
      targetId: idCheck.data,
      metadata: {
        audience_kind: campaign.audience_kind,
        total: resolved.totals.total,
        pending: resolved.totals.pending,
        suppressed: resolved.totals.suppressed,
      },
      ip: req.ip ?? null,
      userAgent: req.get("user-agent") ?? null,
    }).catch((err) => {
      logger.warn(
        { err },
        "bulk_campaign.audience.regenerated audit failed",
      );
    });

    res.json({ ok: true, totals: resolved.totals });
  },
);

// GET /admin/bulk-campaigns/:id/recipients.csv — flat CSV for a
// CSR to audit who's in / out and why. Paged DB read because a
// busy campaign can hit tens of thousands of recipients.
router.get(
  "/admin/bulk-campaigns/:id/recipients.csv",
  requireAdmin,
  async (req, res) => {
    const idCheck = z.string().uuid().safeParse(req.params.id);
    if (!idCheck.success) {
      res.status(404).json({ error: "campaign_not_found" });
      return;
    }
    const supabase = getSupabaseServiceRoleClient();
    const { data: campaign } = await supabase
      .schema("resupply")
      .from("bulk_campaigns")
      .select("id, name")
      .eq("id", idCheck.data)
      .limit(1)
      .maybeSingle();
    if (!campaign) {
      res.status(404).json({ error: "campaign_not_found" });
      return;
    }
    const filename = `bulk-campaign-${campaign.name.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 40)}-${new Date().toISOString().slice(0, 10)}.csv`;
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="${filename}"`,
    );
    res.write(
      [
        "recipient_kind",
        "recipient_id",
        "recipient_email",
        "status",
        "suppression_reason",
        "created_at",
      ].join(",") + "\n",
    );
    // Page through PostgREST in 1k batches so the response streams
    // start fast and stay bounded.
    const PAGE = 1000;
    let offset = 0;
    while (true) {
      const { data, error } = await supabase
        .schema("resupply")
        .from("bulk_campaign_recipients")
        .select(
          "recipient_kind, recipient_id, recipient_email, status, suppression_reason, created_at",
        )
        .eq("campaign_id", idCheck.data)
        .order("created_at", { ascending: true })
        .range(offset, offset + PAGE - 1);
      if (error) throw error;
      const rows = data ?? [];
      if (rows.length === 0) break;
      for (const r of rows) {
        res.write(
          [
            r.recipient_kind,
            r.recipient_id,
            r.recipient_email,
            r.status,
            r.suppression_reason ?? "",
            r.created_at,
          ]
            .map(csvCell)
            .join(",") + "\n",
        );
      }
      if (rows.length < PAGE) break;
      offset += PAGE;
    }
    res.end();
  },
);

function csvCell(value: unknown): string {
  if (value == null) return "";
  const s = String(value);
  if (/[",\n\r]/.test(s)) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

export default router;
