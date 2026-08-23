// Platform super-admin: outreach email campaigns.
//
//   POST /resupply-api/platform/email-campaigns/draft        — resolve
//          audience + persist draft + recipient snapshot
//   GET  /resupply-api/platform/email-campaigns              — list
//   GET  /resupply-api/platform/email-campaigns/:id          — detail
//   POST /resupply-api/platform/email-campaigns/:id/start    — send
//   POST /resupply-api/platform/email-campaigns/:id/pause
//   POST /resupply-api/platform/email-campaigns/:id/resume
//   POST /resupply-api/platform/email-campaigns/:id/cancel
//
// The platform-level broadcast tool: email tenants, saved contacts, or a
// pasted cold list from the platform's OWN sender. Platform-GLOBAL rows
// behind requirePlatformAdmin. Mirrors the per-tenant /admin/bulk-campaigns
// lifecycle, drained by the platform-email send worker.

import { Router, type IRouter, type Request, type Response } from "express";
import { z } from "zod";

import { logAudit } from "@workspace/resupply-audit";
import { getSupabaseServiceRoleClient } from "@workspace/resupply-db";

import {
  isLegalCampaignTransition,
  type CampaignStatus,
} from "../../lib/platform-outreach/dispatch";
import {
  resolvePlatformAudience,
  type PlatformAudienceKind,
} from "../../lib/platform-outreach/resolve-audience";
import { redactDbErr } from "../../lib/redact-db-err";
import { logger } from "../../lib/logger";
import {
  adminReadRateLimiter,
  adminWriteRateLimiter,
} from "../../middlewares/admin-rate-limit";
import { requirePlatformAdmin } from "../../middlewares/requirePlatformAdmin";
import { getBoss } from "../../worker/index.js";
import { enqueueImmediateTick } from "../../worker/jobs/platform-email-tick.js";

const router: IRouter = Router();

const idParam = z.object({ id: z.string().uuid() });

const AUDIENCE_KINDS: PlatformAudienceKind[] = [
  "all_tenants",
  "selected_tenants",
  "all_contacts",
  "contacts_by_tag",
  "manual_list",
];

const draftBody = z
  .object({
    name: z.string().trim().min(1).max(200),
    subject: z.string().trim().min(1).max(300),
    bodyText: z.string().trim().min(1).max(100_000),
    bodyHtml: z.string().max(500_000).nullable().optional(),
    audienceKind: z.enum(
      AUDIENCE_KINDS as [PlatformAudienceKind, ...PlatformAudienceKind[]],
    ),
    tenantIds: z.array(z.string().uuid()).max(10_000).optional(),
    tag: z.string().trim().max(60).optional(),
    emails: z.array(z.string().trim().max(320)).max(50_000).optional(),
    throttlePerMinute: z.number().int().min(1).max(3600).optional().default(60),
  })
  .strict()
  .refine(
    (b) =>
      b.audienceKind !== "selected_tenants" ||
      (b.tenantIds && b.tenantIds.length > 0),
    {
      path: ["tenantIds"],
      message: "tenantIds is required for selected_tenants.",
    },
  )
  .refine(
    (b) => b.audienceKind !== "contacts_by_tag" || (b.tag && b.tag.length > 0),
    { path: ["tag"], message: "tag is required for contacts_by_tag." },
  )
  .refine(
    (b) =>
      b.audienceKind !== "manual_list" || (b.emails && b.emails.length > 0),
    { path: ["emails"], message: "emails is required for manual_list." },
  );

// A subject with a newline can be used for header injection — Zod can't
// see CR/LF in .max(); the SendGrid client also rejects it, but fail early.
function subjectHasControlChars(s: string): boolean {
  return /[\r\n]/.test(s);
}

router.post(
  "/platform/email-campaigns/draft",
  adminWriteRateLimiter,
  requirePlatformAdmin,
  async (req: Request, res: Response): Promise<void> => {
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
    if (subjectHasControlChars(b.subject)) {
      res.status(400).json({ error: "invalid_subject" });
      return;
    }

    const resolved = await resolvePlatformAudience({
      audienceKind: b.audienceKind,
      tenantIds: b.tenantIds,
      tag: b.tag,
      emails: b.emails,
    });

    const supabase = getSupabaseServiceRoleClient();
    const audiencePayload: Record<string, unknown> = {};
    if (b.audienceKind === "selected_tenants")
      audiencePayload.tenantIds = b.tenantIds;
    if (b.audienceKind === "contacts_by_tag") audiencePayload.tag = b.tag;
    if (b.audienceKind === "manual_list") {
      audiencePayload.emailCount = b.emails?.length ?? 0;
    }

    const { data: campaign, error: campaignErr } = await supabase
      .schema("resupply")
      .from("platform_email_campaigns")
      .insert({
        name: b.name,
        subject: b.subject,
        body_text: b.bodyText,
        body_html: b.bodyHtml ?? null,
        audience_kind: b.audienceKind,
        audience_payload: audiencePayload,
        throttle_per_minute: b.throttlePerMinute,
        status: "draft",
        total_recipients: resolved.totals.total,
        suppressed_count: resolved.totals.suppressed,
        created_by_email: req.platformAdminEmail ?? null,
        created_by_user_id: req.platformAdminUserId ?? null,
      })
      .select("id")
      .single();
    if (campaignErr) throw campaignErr;

    if (resolved.recipients.length > 0) {
      const BATCH = 500;
      for (let i = 0; i < resolved.recipients.length; i += BATCH) {
        const slice = resolved.recipients.slice(i, i + BATCH).map((r) => ({
          campaign_id: campaign.id,
          recipient_kind: r.recipientKind,
          recipient_ref: r.recipientRef,
          recipient_email: r.recipientEmail,
          recipient_name: r.recipientName,
          status: r.status,
          suppression_reason: r.suppressionReason,
        }));
        const { error } = await supabase
          .schema("resupply")
          .from("platform_email_recipients")
          .insert(slice);
        if (error) throw error;
      }
    }

    await logAudit({
      action: "platform_email_campaign.draft.create",
      adminEmail: req.platformAdminEmail ?? null,
      adminUserId: req.platformAdminUserId ?? null,
      targetTable: "platform_email_campaigns",
      targetId: campaign.id,
      metadata: {
        audience_kind: b.audienceKind,
        total: resolved.totals.total,
        pending: resolved.totals.pending,
        suppressed: resolved.totals.suppressed,
      },
      ip: req.ip ?? null,
      userAgent: req.get("user-agent") ?? null,
    }).catch((err) =>
      logger.warn(
        { err: redactDbErr(err) },
        "platform_email_campaign.draft.create audit failed",
      ),
    );

    res.status(201).json({ id: campaign.id, totals: resolved.totals });
  },
);

router.get(
  "/platform/email-campaigns",
  adminReadRateLimiter,
  requirePlatformAdmin,
  async (_req: Request, res: Response): Promise<void> => {
    const supabase = getSupabaseServiceRoleClient();
    const { data, error } = await supabase
      .schema("resupply")
      .from("platform_email_campaigns")
      .select("*")
      .order("created_at", { ascending: false })
      .limit(100);
    if (error) throw error;
    res.json({
      campaigns: (data ?? []).map((r) => ({
        id: r.id,
        name: r.name,
        subject: r.subject,
        audienceKind: r.audience_kind,
        status: r.status,
        totalRecipients: r.total_recipients,
        pendingRecipients:
          r.total_recipients -
          r.suppressed_count -
          r.sent_count -
          r.failed_count,
        suppressedCount: r.suppressed_count,
        sentCount: r.sent_count,
        failedCount: r.failed_count,
        throttlePerMinute: r.throttle_per_minute,
        createdAt: r.created_at,
        startedAt: r.started_at,
        completedAt: r.completed_at,
        cancelledAt: r.cancelled_at,
      })),
    });
  },
);

router.get(
  "/platform/email-campaigns/:id",
  adminReadRateLimiter,
  requirePlatformAdmin,
  async (req: Request, res: Response): Promise<void> => {
    const params = idParam.safeParse(req.params);
    if (!params.success) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    const supabase = getSupabaseServiceRoleClient();
    const { data: row, error } = await supabase
      .schema("resupply")
      .from("platform_email_campaigns")
      .select("*")
      .eq("id", params.data.id)
      .limit(1)
      .maybeSingle();
    if (error) throw error;
    if (!row) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    const { data: recipients, error: rErr } = await supabase
      .schema("resupply")
      .from("platform_email_recipients")
      .select(
        "id, recipient_kind, recipient_email, recipient_name, status, suppression_reason",
      )
      .eq("campaign_id", row.id)
      .order("status", { ascending: false })
      .limit(200);
    if (rErr) throw rErr;
    res.json({
      id: row.id,
      name: row.name,
      subject: row.subject,
      bodyText: row.body_text,
      bodyHtml: row.body_html,
      audienceKind: row.audience_kind,
      audiencePayload: row.audience_payload,
      status: row.status,
      totalRecipients: row.total_recipients,
      suppressedCount: row.suppressed_count,
      sentCount: row.sent_count,
      failedCount: row.failed_count,
      throttlePerMinute: row.throttle_per_minute,
      createdAt: row.created_at,
      startedAt: row.started_at,
      completedAt: row.completed_at,
      cancelledAt: row.cancelled_at,
      recipients: (recipients ?? []).map((r) => ({
        id: r.id,
        recipientKind: r.recipient_kind,
        recipientEmail: r.recipient_email,
        recipientName: r.recipient_name,
        status: r.status,
        suppressionReason: r.suppression_reason,
      })),
    });
  },
);

// ── Lifecycle ──────────────────────────────────────────────────────
function planFor(action: "start" | "pause" | "resume" | "cancel"): {
  to: CampaignStatus;
  auditAction: string;
} {
  switch (action) {
    case "start":
      return { to: "sending", auditAction: "platform_email_campaign.start" };
    case "pause":
      return { to: "paused", auditAction: "platform_email_campaign.pause" };
    case "resume":
      return { to: "sending", auditAction: "platform_email_campaign.resume" };
    case "cancel":
      return { to: "cancelled", auditAction: "platform_email_campaign.cancel" };
  }
}

function makeTransitionHandler(
  action: "start" | "pause" | "resume" | "cancel",
) {
  return async (req: Request, res: Response): Promise<void> => {
    const params = idParam.safeParse(req.params);
    if (!params.success) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    const supabase = getSupabaseServiceRoleClient();
    const { data: existing, error: getErr } = await supabase
      .schema("resupply")
      .from("platform_email_campaigns")
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
    if (
      !isLegalCampaignTransition(existing.status as CampaignStatus, plan.to)
    ) {
      res.status(409).json({
        error: "invalid_transition",
        message: `Cannot ${action} a campaign in status "${existing.status}".`,
      });
      return;
    }

    if (
      action === "start" &&
      existing.total_recipients - existing.suppressed_count <= 0
    ) {
      res.status(409).json({
        error: "no_pending_recipients",
        message: "Every recipient is suppressed; rebuild the audience.",
      });
      return;
    }
    if (action === "start" && !getBoss()) {
      res.status(503).json({
        error: "worker_unavailable",
        message: "The send worker isn't running yet. Try again shortly.",
      });
      return;
    }

    const nowIso = new Date().toISOString();
    const updates: Record<string, unknown> = { status: plan.to };
    if (action === "start" && existing.status === "draft")
      updates.started_at = nowIso;
    if (action === "cancel") {
      updates.cancelled_at = nowIso;
      updates.cancelled_by_user_id = req.platformAdminUserId ?? null;
    }

    const { data: updated, error: updErr } = await supabase
      .schema("resupply")
      .from("platform_email_campaigns")
      .update(updates)
      .eq("id", params.data.id)
      .eq("status", existing.status)
      .select("id");
    if (updErr) throw updErr;
    if (!updated || updated.length === 0) {
      res.status(409).json({ error: "status_conflict" });
      return;
    }

    if (action === "start" || action === "resume") {
      const boss = getBoss();
      if (boss) {
        try {
          await enqueueImmediateTick(boss, params.data.id);
        } catch (err) {
          logger.error(
            { campaignId: params.data.id, action, err },
            `platform_email_campaign.${action}: enqueue failed`,
          );
        }
      }
    }

    await logAudit({
      action: plan.auditAction,
      adminEmail: req.platformAdminEmail ?? null,
      adminUserId: req.platformAdminUserId ?? null,
      targetTable: "platform_email_campaigns",
      targetId: params.data.id,
      metadata: { from_status: existing.status, to_status: plan.to },
      ip: req.ip ?? null,
      userAgent: req.get("user-agent") ?? null,
    }).catch((err) =>
      logger.warn(
        { err: redactDbErr(err) },
        `${plan.auditAction} audit failed`,
      ),
    );

    res.json({ id: params.data.id, status: plan.to });
  };
}

router.post(
  "/platform/email-campaigns/:id/start",
  adminWriteRateLimiter,
  requirePlatformAdmin,
  makeTransitionHandler("start"),
);
router.post(
  "/platform/email-campaigns/:id/pause",
  adminWriteRateLimiter,
  requirePlatformAdmin,
  makeTransitionHandler("pause"),
);
router.post(
  "/platform/email-campaigns/:id/resume",
  adminWriteRateLimiter,
  requirePlatformAdmin,
  makeTransitionHandler("resume"),
);
router.post(
  "/platform/email-campaigns/:id/cancel",
  adminWriteRateLimiter,
  requirePlatformAdmin,
  makeTransitionHandler("cancel"),
);

export default router;
