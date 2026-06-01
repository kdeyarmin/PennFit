// /admin/alerts — the alert library: a curated catalog of alerts and
// their editable per-channel messages, plus a send action.
//
// Endpoints:
//   GET   /admin/alerts                          — list every alert + its messages
//   GET   /admin/alerts/:key                     — one alert + its messages
//   PATCH /admin/alerts/:key/messages/:channel   — edit a channel message
//   POST  /admin/alerts/:key/send                — send an alert to a patient
//
// Reading + editing the library is `admin.tools.manage`-gated (the
// same tier as message templates and CSR macros — CSRs USE alerts but
// editing the copy is a tier above). Sending is `requireAdmin` +
// rate-limited, matching the existing reminder/place-call send routes.
//
// Editor enforcement mirrors /admin/message-templates: every
// `{{var}}` token in the new copy must be in the alert's
// allowed_variables (else 400 + the offending tokens), and SMS bodies
// must be ASCII (a single non-GSM-7 char silently triples the segment
// count, and therefore the cost, on Twilio).
//
// PHI posture: alert message bodies stay OUT of the audit metadata and
// out of the application logger.

import { Router, type IRouter } from "express";
import { z } from "zod";

import {
  getSupabaseServiceRoleClient,
  type Database,
} from "@workspace/resupply-db";
import { EmailConfigError } from "@workspace/resupply-email";
import { TwilioConfigError } from "@workspace/resupply-telecom";

import {
  dispatchAlert,
  type AlertChannel,
  type DispatchAlertOutcome,
} from "../../lib/alerts/dispatch";
import { logger } from "../../lib/logger";
import { isAsciiOnly } from "../../lib/message-templates/sms";
import {
  adminRateLimit,
  adminReadRateLimiter,
} from "../../middlewares/admin-rate-limit";
import {
  requireAdmin,
  requirePermission,
} from "../../middlewares/requireAdmin";

type AlertDefinitionRow =
  Database["resupply"]["Tables"]["alert_definitions"]["Row"];
type AlertMessageRow = Database["resupply"]["Tables"]["alert_messages"]["Row"];
type AlertMessageUpdate =
  Database["resupply"]["Tables"]["alert_messages"]["Update"];

const router: IRouter = Router();

const channelEnum = z.enum(["email", "sms", "voice"]);
const keyParam = z
  .string()
  .trim()
  .min(1)
  .max(120)
  .regex(/^[a-z0-9][a-z0-9_.-]*$/);

const patchBody = z
  .object({
    subject: z.string().trim().max(1000).nullable().optional(),
    bodyHtml: z.string().trim().max(200000).nullable().optional(),
    bodyText: z.string().trim().min(1).max(50000).optional(),
    isActive: z.boolean().optional(),
  })
  .strict();

const sendBody = z
  .object({
    patientId: z.string().uuid(),
    channel: channelEnum,
    variables: z.record(z.string().max(120), z.string().max(4000)).optional(),
  })
  .strict();

interface AlertMessageView {
  channel: string;
  subject: string | null;
  bodyHtml: string | null;
  bodyText: string;
  isActive: boolean;
  updatedAt: string;
  updatedBy: string | null;
}

interface AlertDefinitionView {
  key: string;
  name: string;
  description: string | null;
  category: string;
  severity: string;
  channels: string[];
  allowedVariables: string[];
  isActive: boolean;
  messages: AlertMessageView[];
}

function serializeMessage(row: AlertMessageRow): AlertMessageView {
  return {
    channel: row.channel,
    subject: row.subject ?? null,
    bodyHtml: row.body_html ?? null,
    bodyText: row.body_text,
    isActive: row.is_active,
    updatedAt: row.updated_at,
    updatedBy: row.updated_by ?? null,
  };
}

function serializeDefinition(
  def: AlertDefinitionRow,
  messages: AlertMessageRow[],
): AlertDefinitionView {
  return {
    key: def.key,
    name: def.name,
    description: def.description ?? null,
    category: def.category,
    severity: def.severity,
    channels: def.channels ?? [],
    allowedVariables: def.allowed_variables ?? [],
    isActive: def.is_active,
    messages: messages
      .filter((m) => m.alert_key === def.key)
      .map(serializeMessage),
  };
}

/**
 * Names of `{{snake_case}}` tokens in `s` that aren't in `allowed`.
 * Mirrors the substitution regex in @workspace/resupply-templates so
 * the editor pre-flight matches what the renderer will actually do.
 */
function disallowedTokens(
  s: string | null | undefined,
  allowed: ReadonlyArray<string>,
): string[] {
  if (!s) return [];
  const found = new Set<string>();
  const allowedSet = new Set(allowed);
  for (const m of s.matchAll(/\{\{([a-z][a-z0-9_]*)\}\}/g)) {
    const name = m[1]!;
    if (!allowedSet.has(name)) found.add(name);
  }
  return [...found];
}

// ─── GET /admin/alerts ───────────────────────────────────────────
router.get(
  "/admin/alerts",
  requirePermission("admin.tools.manage"),
  async (_req, res) => {
    const supabase = getSupabaseServiceRoleClient();
    const [defsRes, msgsRes] = await Promise.all([
      supabase
        .schema("resupply")
        .from("alert_definitions")
        .select(
          "key, name, description, category, severity, channels, allowed_variables, is_active",
        )
        .order("category", { ascending: true })
        .order("name", { ascending: true })
        .limit(500),
      supabase
        .schema("resupply")
        .from("alert_messages")
        .select(
          "alert_key, channel, subject, body_html, body_text, is_active, updated_at, updated_by",
        )
        .order("alert_key", { ascending: true })
        .order("channel", { ascending: true })
        .limit(2000),
    ]);
    if (defsRes.error) throw defsRes.error;
    if (msgsRes.error) throw msgsRes.error;
    const defs = (defsRes.data ?? []) as AlertDefinitionRow[];
    const msgs = (msgsRes.data ?? []) as AlertMessageRow[];
    res.json({
      alerts: defs.map((d) => serializeDefinition(d, msgs)),
    });
  },
);

// ─── GET /admin/alerts/:key ──────────────────────────────────────
router.get(
  "/admin/alerts/:key",
  requirePermission("admin.tools.manage"),
  async (req, res) => {
    const keyCheck = keyParam.safeParse(req.params.key);
    if (!keyCheck.success) {
      res.status(400).json({ error: "invalid_key" });
      return;
    }
    const supabase = getSupabaseServiceRoleClient();
    const { data: def, error: defErr } = await supabase
      .schema("resupply")
      .from("alert_definitions")
      .select(
        "key, name, description, category, severity, channels, allowed_variables, is_active",
      )
      .eq("key", keyCheck.data)
      .limit(1)
      .maybeSingle();
    if (defErr) throw defErr;
    if (!def) {
      res.status(404).json({ error: "alert_not_found" });
      return;
    }
    const { data: msgs, error: msgErr } = await supabase
      .schema("resupply")
      .from("alert_messages")
      .select(
        "alert_key, channel, subject, body_html, body_text, is_active, updated_at, updated_by",
      )
      .eq("alert_key", keyCheck.data)
      .order("channel", { ascending: true });
    if (msgErr) throw msgErr;
    res.json({
      alert: serializeDefinition(
        def as AlertDefinitionRow,
        (msgs ?? []) as AlertMessageRow[],
      ),
    });
  },
);

// ─── PATCH /admin/alerts/:key/messages/:channel ──────────────────
const alertMessageMutationLimiter = adminRateLimit({
  name: "alerts.message_update",
  preset: "mutation",
});

router.patch(
  "/admin/alerts/:key/messages/:channel",
  requirePermission("admin.tools.manage"),
  alertMessageMutationLimiter,
  async (req, res) => {
    const keyCheck = keyParam.safeParse(req.params.key);
    const channelCheck = channelEnum.safeParse(req.params.channel);
    if (!keyCheck.success || !channelCheck.success) {
      res.status(400).json({ error: "invalid_params" });
      return;
    }
    const parsed = patchBody.safeParse(req.body);
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
    const alertKey = keyCheck.data;
    const channel = channelCheck.data;
    const supabase = getSupabaseServiceRoleClient();

    const { data: def, error: defErr } = await supabase
      .schema("resupply")
      .from("alert_definitions")
      .select("key, allowed_variables")
      .eq("key", alertKey)
      .limit(1)
      .maybeSingle();
    if (defErr) throw defErr;
    if (!def) {
      res.status(404).json({ error: "alert_not_found" });
      return;
    }

    const { data: existing, error: existingErr } = await supabase
      .schema("resupply")
      .from("alert_messages")
      .select("subject, body_html, body_text, channel")
      .eq("alert_key", alertKey)
      .eq("channel", channel)
      .limit(1)
      .maybeSingle();
    if (existingErr) throw existingErr;
    if (!existing) {
      res.status(404).json({ error: "message_not_found" });
      return;
    }

    const nextSubject =
      parsed.data.subject !== undefined
        ? parsed.data.subject
        : existing.subject;
    const nextBodyHtml =
      parsed.data.bodyHtml !== undefined
        ? parsed.data.bodyHtml
        : existing.body_html;
    const nextBodyText =
      parsed.data.bodyText !== undefined
        ? parsed.data.bodyText
        : existing.body_text;

    const allowed = def.allowed_variables ?? [];
    const offenders = [
      ...disallowedTokens(nextSubject, allowed),
      ...disallowedTokens(nextBodyHtml, allowed),
      ...disallowedTokens(nextBodyText, allowed),
    ];
    if (offenders.length > 0) {
      res.status(400).json({
        error: "disallowed_variables",
        message:
          "These placeholders are not in the alert's allowedVariables list:",
        offending: [...new Set(offenders)],
        allowed,
      });
      return;
    }
    if (
      channel === "sms" &&
      parsed.data.bodyText !== undefined &&
      !isAsciiOnly(parsed.data.bodyText)
    ) {
      res.status(400).json({ error: "sms_body_text_must_be_ascii" });
      return;
    }
    // Email must ship with a non-empty subject — dispatch falls back to
    // `rendered.subject ?? ""`, so a blank subject would send silently.
    if (channel === "email" && (nextSubject?.trim() ?? "") === "") {
      res.status(400).json({ error: "email_subject_required" });
      return;
    }

    const adminId = req.adminUserId ?? null;
    const updateValues: AlertMessageUpdate = {
      updated_by: adminId,
      updated_at: new Date().toISOString(),
    };
    if (parsed.data.subject !== undefined)
      updateValues.subject = parsed.data.subject;
    if (parsed.data.bodyHtml !== undefined)
      updateValues.body_html = parsed.data.bodyHtml;
    if (parsed.data.bodyText !== undefined)
      updateValues.body_text = parsed.data.bodyText;
    if (parsed.data.isActive !== undefined)
      updateValues.is_active = parsed.data.isActive;

    const { data: updated, error: updateErr } = await supabase
      .schema("resupply")
      .from("alert_messages")
      .update(updateValues)
      .eq("alert_key", alertKey)
      .eq("channel", channel)
      .select(
        "alert_key, channel, subject, body_html, body_text, is_active, updated_at, updated_by",
      )
      .limit(1)
      .maybeSingle();
    if (updateErr) throw updateErr;
    if (!updated) {
      res.status(404).json({ error: "message_not_found" });
      return;
    }

    const fieldsChanged: string[] = [];
    for (const k of ["subject", "bodyHtml", "bodyText", "isActive"] as const) {
      if (parsed.data[k] !== undefined) fieldsChanged.push(k);
    }
    // Observability only — a structured log line, NOT an audit write.
    // Per CLAUDE.md the @workspace/resupply-audit package is a no-op
    // stub and new resupply-api code must not write against it. Bodies
    // are never logged (lengths only) — treat template copy as content
    // that may quote PHI-shaped patterns.
    logger.info(
      {
        event: "alert_message_updated",
        alert_key: alertKey,
        channel,
        admin_user_id: adminId,
        fields_changed: fieldsChanged,
        new_lengths: {
          subject: nextSubject?.length ?? null,
          body_html: nextBodyHtml?.length ?? null,
          body_text: nextBodyText.length,
        },
      },
      "admin updated an alert message",
    );

    res.json({ message: serializeMessage(updated as AlertMessageRow) });
  },
);

// ─── POST /admin/alerts/:key/send ────────────────────────────────
router.post(
  "/admin/alerts/:key/send",
  // Recognized front-gate limiter ahead of the auth gate (CodeQL
  // js/missing-rate-limiting); the tighter per-actor send cap below
  // still applies once requireAdmin populates req.adminUserId.
  adminReadRateLimiter,
  requireAdmin,
  adminRateLimit({ name: "alerts.send", preset: "sensitive" }),
  async (req, res) => {
    const keyCheck = keyParam.safeParse(req.params.key);
    if (!keyCheck.success) {
      res.status(400).json({ error: "invalid_key" });
      return;
    }
    const parsed = sendBody.safeParse(req.body);
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
    const alertKey = keyCheck.data;
    const channel = parsed.data.channel as AlertChannel;

    let outcome: DispatchAlertOutcome;
    try {
      outcome = await dispatchAlert({
        alertKey,
        channel,
        patientId: parsed.data.patientId,
        variables: parsed.data.variables,
      });
    } catch (err) {
      if (err instanceof TwilioConfigError || err instanceof EmailConfigError) {
        logger.error(
          { err: { name: err.name, message: err.message }, channel },
          "alerts.send: vendor config error",
        );
        res.status(503).json({ error: "vendor_config_error", channel });
        return;
      }
      throw err;
    }

    if (outcome.status === "ok") {
      // Observability only — structured log, NOT an audit write (see
      // CLAUDE.md: resupply-audit is a no-op stub; no new writes).
      logger.info(
        {
          event: "alert_sent",
          alert_key: alertKey,
          channel,
          patient_id: parsed.data.patientId,
          admin_user_id: req.adminUserId ?? null,
          vendor_ref: outcome.vendorRef,
        },
        "admin sent an alert to a patient",
      );
      res.status(201).json({ channel, vendorRef: outcome.vendorRef });
      return;
    }

    // Unresolved placeholders are a 400 with the offending tokens so the
    // caller can supply them (the Send-test form omits alert variables).
    if (outcome.status === "unresolved_variables") {
      res.status(400).json({
        error: "unresolved_variables",
        channel: outcome.channel,
        missing: outcome.missing,
      });
      return;
    }

    const STATUS: Record<
      Exclude<DispatchAlertOutcome["status"], "ok" | "unresolved_variables">,
      number
    > = {
      alert_not_found: 404,
      alert_inactive: 409,
      channel_not_supported: 409,
      message_not_configured: 409,
      suppressed_for_patient: 409,
      patient_not_found: 404,
      patient_not_active: 409,
      patient_missing_email: 422,
      patient_missing_phone: 422,
      patient_phone_unnormalizable: 422,
      messaging_not_configured: 503,
      voice_not_configured: 503,
      vendor_error: 502,
    };
    res.status(STATUS[outcome.status]).json({ error: outcome.status });
  },
);

export default router;
