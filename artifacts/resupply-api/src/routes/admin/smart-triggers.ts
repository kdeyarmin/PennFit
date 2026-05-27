// /admin/smart-triggers — data-driven reorder-trigger evaluator +
// dispatcher (Phase E.2 / feature #19). Reads patient_therapy_nights,
// runs the rule library, inserts proposals into
// patient_smart_trigger_events, then sends an email per detected
// event. Mirrors the other dispatcher patterns (Phase B.1 onboarding,
// Phase B.2 Rx renewal): synchronous, capped, summary response.
//
//   POST /admin/smart-triggers/evaluate
//        — scan therapy data, insert any new pending events.
//          Idempotent: the partial-unique active index prevents
//          re-firing while an existing event is pending or sent.
//   POST /admin/smart-triggers/send-due
//        — email pending events; stamp sent_at on success.
//   POST /admin/smart-triggers/:id/dismiss
//        — CSR manually clears a false-positive or
//          customer-requested mute.
//   GET  /admin/patients/:id/smart-triggers
//        — per-patient list (most-recent-first) for the admin
//          patient-detail "smart triggers" tab.
//
// Email content is intentionally short — the data-driven version
// converts at 3-5x the rate of calendar-only nudges per the brief,
// and the conversion comes from the SPECIFICITY of the message,
// not its length.
//
// PHI / log posture: nightly therapy data is PHI. The audit
// envelope records patient_id + kind + window dates only — never
// the leak rate / AHI / usage values that drove detection.

import { Router, type IRouter } from "express";
import { z } from "zod";

import { logAudit } from "@workspace/resupply-audit";
import { getSupabaseServiceRoleClient } from "@workspace/resupply-db";

import { runSmartTriggerEvaluator } from "../../lib/smart-triggers/evaluator";
import { runSmartTriggerSendDue } from "../../lib/smart-triggers/dispatcher";
import {
  htmlBody,
  pushBody,
  smsBody,
  subjectForKind,
  textBody,
} from "../../lib/smart-triggers/renderers";
import { logger } from "../../lib/logger";
import { requirePermission } from "../../middlewares/requireAdmin";
import { rateLimit } from "../../middlewares/rate-limit";

const router: IRouter = Router();

// Per-admin rate limits on smart-trigger ops (B-07). Two buckets:
//   * adminSmartTriggerRunLimiter — 10/hour. /evaluate and /send-due
//     are heavy fan-outs (DB scan + outbound email/SMS dispatch).
//     Tighter cap so a runaway script can't burn vendor quota or DB.
//   * adminSmartTriggerDismissLimiter — 60/hour. Per-event dismissals
//     are part of the regular CSR queue workflow.
const adminSmartTriggerRunLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 10,
  name: "admin_smart_trigger_run",
  keyFn: (req) => req.adminUserId ?? "unknown",
});
const adminSmartTriggerDismissLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 60,
  name: "admin_smart_trigger_dismiss",
  keyFn: (req) => req.adminUserId ?? "unknown",
});

const triggerIdParam = z.string().uuid();
const dismissBody = z
  .object({
    reason: z.string().trim().max(500).optional().nullable(),
  })
  .strict();

// Per-run caps live in lib/smart-triggers/{evaluator,dispatcher}.ts
// now that those handlers are shared between the route and the
// daily pg-boss crons.

router.post(
  "/admin/smart-triggers/evaluate",
  // Manual run of the rule evaluator — admin-tools tier (it's a
  // dispatcher trigger that fans out across the whole population).
  requirePermission("admin.tools.manage"),
  adminSmartTriggerRunLimiter,
  async (req, res) => {
    const result = await runSmartTriggerEvaluator({
      adminEmail: req.adminEmail ?? null,
      adminUserId: req.adminUserId ?? null,
      ip: req.ip ?? null,
      userAgent: req.get("user-agent") ?? null,
    });
    res.json(result);
  },
);

const sendDueChannelQuery = z.enum(["email", "sms"]).default("email");

router.post(
  "/admin/smart-triggers/send-due",
  // Manual dispatcher trigger — same admin-tools tier as evaluate.
  requirePermission("admin.tools.manage"),
  adminSmartTriggerRunLimiter,
  async (req, res) => {
    const channelParse = sendDueChannelQuery.safeParse(
      req.query.channel ?? "email",
    );
    if (!channelParse.success) {
      res.status(400).json({ error: "invalid_channel" });
      return;
    }
    const channel = channelParse.data;

    const outcome = await runSmartTriggerSendDue(
      channel,
      {
        adminEmail: req.adminEmail ?? null,
        adminUserId: req.adminUserId ?? null,
        ip: req.ip ?? null,
        userAgent: req.get("user-agent") ?? null,
      },
      { subjectForKind, textBody, htmlBody, smsBody, pushBody },
    );

    if (outcome.status === "not_configured") {
      res.status(503).json({
        error:
          channel === "email" ? "email_not_configured" : "sms_not_configured",
        message:
          channel === "email"
            ? "SendGrid is not configured on this server."
            : "SMS messaging is not configured on this server.",
      });
      return;
    }

    const { attempted, sent, failed, skippedNoContact, remaining } = outcome;
    res.json({
      attempted,
      sent,
      failed,
      // Backwards-compatible: the original endpoint returned this key
      // for the email channel.
      ...(channel === "email"
        ? { skippedNoEmail: skippedNoContact }
        : { skippedNoPhone: skippedNoContact }),
      skippedNoContact,
      remaining,
      channel,
    });
  },
);

router.post(
  "/admin/smart-triggers/:id/dismiss",
  // CSR action — dismissing an individual trigger is the same
  // tier as triaging a compliance alert. `conversations.manage`
  // matches the rest of the per-patient CSR inbox.
  requirePermission("conversations.manage"),
  adminSmartTriggerDismissLimiter,
  async (req, res) => {
    const idParsed = triggerIdParam.safeParse(req.params.id);
    if (!idParsed.success) {
      res.status(400).json({ error: "invalid_id" });
      return;
    }
    const id = idParsed.data;

    const bodyParsed = dismissBody.safeParse(req.body ?? {});
    if (!bodyParsed.success) {
      res.status(400).json({
        error: "invalid_body",
        issues: bodyParsed.error.issues.map((i) => ({
          path: i.path.join("."),
          message: i.message,
        })),
      });
      return;
    }

    const supabase = getSupabaseServiceRoleClient();
    const { data: row, error: lookupErr } = await supabase
      .schema("resupply")
      .from("patient_smart_trigger_events")
      .select("id, patient_id, kind, dismissed_at")
      .eq("id", id)
      .limit(1)
      .maybeSingle();
    if (lookupErr) throw lookupErr;
    if (!row) {
      res.status(404).json({ error: "trigger_not_found" });
      return;
    }
    if (row.dismissed_at !== null) {
      res.status(409).json({ error: "already_dismissed" });
      return;
    }

    const now = new Date();
    const nowIso = now.toISOString();
    const { error: updateErr } = await supabase
      .schema("resupply")
      .from("patient_smart_trigger_events")
      .update({
        dismissed_at: nowIso,
        dismissed_by_email: req.adminEmail ?? null,
        dismissed_reason: bodyParsed.data.reason ?? null,
        updated_at: nowIso,
      })
      .eq("id", id);
    if (updateErr) throw updateErr;

    await logAudit({
      action: "patient.smart_trigger.dismissed",
      adminEmail: req.adminEmail ?? null,
      adminUserId: req.adminUserId ?? null,
      targetTable: "patient_smart_trigger_events",
      targetId: id,
      metadata: {
        patient_id: row.patient_id,
        kind: row.kind,
        // length-only — operator's free-form reason isn't logged
        // verbatim so audit-log search can't surface PHI-adjacent
        // commentary.
        reason_length: bodyParsed.data.reason?.length ?? 0,
      },
      ip: req.ip ?? null,
      userAgent: req.get("user-agent") ?? null,
    }).catch((err) => {
      logger.warn(
        { err },
        "patient.smart_trigger.dismissed audit write failed",
      );
    });

    res.json({ id, dismissedAt: nowIso });
  },
);

/**
 * GET /admin/patients/:id/smart-triggers — list trigger events
 * for a single patient. Used by the admin patient-detail page's
 * "Smart triggers" tab so CSRs can see what fired and dismiss
 * false positives in-context (instead of needing the per-id
 * dismiss endpoint with no list view).
 *
 * No pagination — a real patient should never have more than a
 * handful of trigger events; the LIMIT of 50 is the upper bound.
 *
 * Returns the same row shape `/admin/smart-triggers/:id/dismiss`
 * mutates so the SPA can do an optimistic local update.
 *
 * PHI posture: kind + window dates are non-PHI structural metadata
 * (the detection inputs from patient_therapy_nights are excluded
 * here, same as the email/SMS dispatcher envelope).
 */
const patientIdParam = z.string().uuid();

router.get(
  "/admin/patients/:id/smart-triggers",
  // Per-patient feed — same patient-tier read scope as the rest
  // of the per-patient surface.
  requirePermission("patients.read"),
  async (req, res) => {
    const idParsed = patientIdParam.safeParse(req.params.id);
    if (!idParsed.success) {
      res.status(404).json({ error: "patient_not_found" });
      return;
    }
    const supabase = getSupabaseServiceRoleClient();
    const { data, error } = await supabase
      .schema("resupply")
      .from("patient_smart_trigger_events")
      .select(
        "id, kind, detected_at, window_start_date, window_end_date, sent_at, dismissed_at, dismissed_by_email, dismissed_reason, created_at",
      )
      .eq("patient_id", idParsed.data)
      .order("detected_at", { ascending: false })
      .limit(50);
    if (error) throw error;
    res.json({
      events: (data ?? []).map((r) => ({
        id: r.id,
        kind: r.kind,
        // PostgREST returns timestamps as ISO strings already, and date
        // columns as YYYY-MM-DD — no Date conversion needed.
        detectedAt: r.detected_at,
        windowStartDate: r.window_start_date,
        windowEndDate: r.window_end_date,
        sentAt: r.sent_at,
        dismissedAt: r.dismissed_at,
        dismissedByEmail: r.dismissed_by_email,
        dismissedReason: r.dismissed_reason,
        createdAt: r.created_at,
      })),
    });
  },
);

export default router;
