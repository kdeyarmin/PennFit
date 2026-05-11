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

import {
  resolveAudience,
  type AudienceKind,
  type Category,
  type PatientCandidate,
  type ShopCustomerCandidate,
} from "../../lib/bulk-campaigns/resolve-audience";
import { logger } from "../../lib/logger";
import { requireAdmin } from "../../middlewares/requireAdmin";

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
    const { data: tpl } = await supabase
      .schema("resupply")
      .from("message_templates")
      .select("template_key, channel, is_active")
      .eq("template_key", b.templateKey)
      .eq("channel", "email")
      .limit(1)
      .maybeSingle();
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
    const shopCandidates: ShopCustomerCandidate[] = [];
    const patientCandidates: PatientCandidate[] = [];

    if (b.audienceKind === "all_active_shop_customers") {
      const { data, error } = await supabase
        .schema("resupply")
        .from("shop_customers")
        .select("customer_id, email_lower, communication_preferences");
      if (error) throw error;
      for (const r of data ?? []) {
        shopCandidates.push({
          id: r.customer_id,
          emailLower: r.email_lower,
          communicationPreferences:
            r.communication_preferences as ShopCustomerCandidate["communicationPreferences"],
        });
      }
    } else if (b.audienceKind === "all_active_patients") {
      const { data, error } = await supabase
        .schema("resupply")
        .from("patients")
        .select("id, email, status, insurance_payer")
        .eq("status", "active");
      if (error) throw error;
      for (const r of data ?? []) {
        patientCandidates.push({
          id: r.id,
          email: r.email,
          status: r.status,
          insurancePayer: r.insurance_payer,
        });
      }
    } else if (b.audienceKind === "by_patient_payer") {
      const { data, error } = await supabase
        .schema("resupply")
        .from("patients")
        .select("id, email, status, insurance_payer")
        .eq("status", "active")
        .eq("insurance_payer", b.audiencePayer ?? "");
      if (error) throw error;
      for (const r of data ?? []) {
        patientCandidates.push({
          id: r.id,
          email: r.email,
          status: r.status,
          insurancePayer: r.insurance_payer,
        });
      }
    } else if (b.audienceKind === "manual_list") {
      // Bulk-fetch each list, but cap PostgREST `.in` payload at a
      // reasonable size. 1000 ids per batch keeps the URL under
      // 32KB. The resolver will dedupe further.
      const BATCH = 1000;
      const shopIds = b.manualShopCustomerIds ?? [];
      for (let i = 0; i < shopIds.length; i += BATCH) {
        const slice = shopIds.slice(i, i + BATCH);
        const { data, error } = await supabase
          .schema("resupply")
          .from("shop_customers")
          .select("customer_id, email_lower, communication_preferences")
          .in("customer_id", slice);
        if (error) throw error;
        for (const r of data ?? []) {
          shopCandidates.push({
            id: r.customer_id,
            emailLower: r.email_lower,
            communicationPreferences:
              r.communication_preferences as ShopCustomerCandidate["communicationPreferences"],
          });
        }
      }
      const patientIds = b.manualPatientIds ?? [];
      for (let i = 0; i < patientIds.length; i += BATCH) {
        const slice = patientIds.slice(i, i + BATCH);
        const { data, error } = await supabase
          .schema("resupply")
          .from("patients")
          .select("id, email, status, insurance_payer")
          .in("id", slice);
        if (error) throw error;
        for (const r of data ?? []) {
          patientCandidates.push({
            id: r.id,
            email: r.email,
            status: r.status,
            insurancePayer: r.insurance_payer,
          });
        }
      }
    }

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

router.post(
  "/admin/bulk-campaigns/:id/cancel",
  requireAdmin,
  async (req, res) => {
    const params = idParam.safeParse(req.params);
    if (!params.success) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    const supabase = getSupabaseServiceRoleClient();

    const { data: existing, error: getErr } = await supabase
      .schema("resupply")
      .from("bulk_campaigns")
      .select("id, status")
      .eq("id", params.data.id)
      .limit(1)
      .maybeSingle();
    if (getErr) throw getErr;
    if (!existing) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    // Phase A only supports cancelling from `draft`. Phase B will
    // extend this to also cancel `paused` or `sending` campaigns
    // once the worker can be told to stop.
    if (existing.status !== "draft") {
      res.status(409).json({
        error: "invalid_transition",
        message: `Cannot cancel a campaign in status "${existing.status}". Only drafts can be cancelled in Phase A.`,
      });
      return;
    }

    const updates: Database["resupply"]["Tables"]["bulk_campaigns"]["Update"] =
      {
        status: "cancelled",
        cancelled_at: new Date().toISOString(),
        cancelled_by_user_id: req.adminUserId ?? null,
      };
    const { error: updErr } = await supabase
      .schema("resupply")
      .from("bulk_campaigns")
      .update(updates)
      .eq("id", params.data.id);
    if (updErr) throw updErr;

    await logAudit({
      action: "bulk_campaign.cancel",
      adminEmail: req.adminEmail ?? null,
      adminUserId: req.adminUserId ?? null,
      targetTable: "bulk_campaigns",
      targetId: params.data.id,
      metadata: {
        from_status: existing.status,
      },
      ip: req.ip ?? null,
      userAgent: req.get("user-agent") ?? null,
    }).catch((err) => {
      logger.warn({ err }, "bulk_campaign.cancel audit failed");
    });

    res.status(200).json({ id: params.data.id, status: "cancelled" });
  },
);

export default router;
