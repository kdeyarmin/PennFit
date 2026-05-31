// Alert dispatch — the shared send path for the alert library.
//
// Loads the alert definition + the editable per-channel message,
// renders the {{snake_case}} variables against the alert's allowlist,
// and sends over the requested channel:
//   * email → SendGrid (via @workspace/resupply-email)
//   * sms   → Twilio Messaging (via @workspace/resupply-telecom)
//   * voice → Twilio Voice placeCall, pointed at /voice/alert-twiml,
//             which speaks the rendered transcript back out.
//
// Returns a tagged-union outcome rather than throwing on recoverable
// errors — the route translates each outcome to an HTTP status, the
// same posture as @workspace/resupply-reminders.
//
// Variable substitution reuses the exact primitives the rest of the
// message library uses (applyVariables / applyVariablesHtmlSafe from
// @workspace/resupply-templates), so a token outside the alert's
// allowed_variables stays literal — visible in QA, never shipped.

import { randomUUID } from "node:crypto";

import { normalizeE164 } from "@workspace/resupply-domain";
import {
  getSupabaseServiceRoleClient,
  type ResupplySupabaseClient,
} from "@workspace/resupply-db";
import {
  createSendgridClient,
  EmailApiError,
  EmailConfigError,
} from "@workspace/resupply-email";
import {
  createTwilioClient,
  createTwilioSmsClient,
  TwilioApiError,
  TwilioConfigError,
} from "@workspace/resupply-telecom";
import {
  applyVariables,
  applyVariablesHtmlSafe,
} from "@workspace/resupply-templates";

import { logger } from "../logger";
import {
  readEmailConfigOrNull,
  readSmsConfigOrNull,
} from "../messaging/messaging-config";
import { readVoiceConfigOrNull } from "../voice/voice-config";
import { getAlertVoiceScripts } from "./voice-scripts";

export type AlertChannel = "email" | "sms" | "voice";

/**
 * Names of `{{snake_case}}` tokens still present in a rendered string —
 * i.e. variables the caller didn't supply, which `applyVariables`
 * leaves literal. Used to refuse a send that would ship a raw
 * `{{order_number}}` to a patient. Mirrors the substitution regex.
 */
function unresolvedTokens(...rendered: Array<string | null>): string[] {
  const found = new Set<string>();
  for (const s of rendered) {
    if (!s) continue;
    for (const m of s.matchAll(/\{\{([a-z][a-z0-9_]*)\}\}/g)) {
      found.add(m[1]!);
    }
  }
  return [...found];
}

/** HTML-escape so a plain-text body can be used safely in an HTML
 *  email part. Mirrors the escape in @workspace/resupply-templates. */
function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export interface RenderedAlert {
  subject: string | null;
  bodyHtml: string | null;
  bodyText: string;
}

/**
 * Pure render: substitute `variables` into a message row's fields
 * using `allowedVariables` as the allowlist. Exported so the dispatch
 * behaviour can be unit-tested without a DB or vendor clients.
 */
export function renderAlertMessage(input: {
  subject: string | null;
  bodyHtml: string | null;
  bodyText: string;
  allowedVariables: ReadonlyArray<string>;
  variables: Readonly<Record<string, string>>;
}): RenderedAlert {
  const { subject, bodyHtml, bodyText, allowedVariables, variables } = input;
  return {
    subject:
      subject !== null
        ? applyVariables(subject, variables, allowedVariables)
        : null,
    bodyHtml:
      bodyHtml !== null
        ? applyVariablesHtmlSafe(bodyHtml, variables, allowedVariables)
        : null,
    bodyText: applyVariables(bodyText, variables, allowedVariables),
  };
}

export type DispatchAlertOutcome =
  | { status: "ok"; channel: AlertChannel; vendorRef: string }
  | { status: "alert_not_found" }
  | { status: "alert_inactive" }
  | { status: "channel_not_supported"; channel: AlertChannel }
  | { status: "message_not_configured"; channel: AlertChannel }
  | { status: "suppressed_for_patient"; channel: AlertChannel }
  | { status: "patient_not_found" }
  | { status: "patient_not_active"; patientStatus: string }
  | { status: "patient_missing_email" }
  | { status: "patient_missing_phone" }
  | { status: "patient_phone_unnormalizable" }
  | { status: "messaging_not_configured" }
  | { status: "voice_not_configured" }
  | { status: "unresolved_variables"; channel: AlertChannel; missing: string[] }
  | {
      status: "vendor_error";
      channel: AlertChannel;
      vendorStatus: number | null;
      vendorCode: string | null;
    };

export interface DispatchAlertInput {
  alertKey: string;
  channel: AlertChannel;
  patientId: string;
  /**
   * Caller-supplied substitution values. `first_name` and
   * `practice_name` are filled in from the patient row + config when
   * the caller does not override them.
   */
  variables?: Readonly<Record<string, string>>;
  /** Test seam — defaults to the shared service-role client. */
  supabase?: ResupplySupabaseClient;
}

/**
 * Send one alert to one patient over one channel. See the outcome
 * union for every distinguishable result.
 */
export async function dispatchAlert(
  input: DispatchAlertInput,
): Promise<DispatchAlertOutcome> {
  const supabase = input.supabase ?? getSupabaseServiceRoleClient();
  const { alertKey, channel, patientId } = input;

  // 1. Alert definition. A missing table (migration 0179 not yet
  // applied on this environment) degrades to `alert_not_found` rather
  // than throwing a 500 — the route stays forward-deploy-safe.
  const { data: def, error: defErr } = await supabase
    .schema("resupply")
    .from("alert_definitions")
    .select("key, channels, allowed_variables, is_active")
    .eq("key", alertKey)
    .limit(1)
    .maybeSingle();
  if (defErr) {
    logger.warn(
      { event: "alert_dispatch_def_lookup_failed", alertKey },
      "alert dispatch: alert_definitions lookup failed; treating as not found",
    );
    return { status: "alert_not_found" };
  }
  if (!def) return { status: "alert_not_found" };
  if (!def.is_active) return { status: "alert_inactive" };
  if (!(def.channels ?? []).includes(channel)) {
    return { status: "channel_not_supported", channel };
  }

  // 2. Editable message for this channel + the per-patient override
  // (if any), in parallel — both are single unique-index hits.
  const [globalRes, overrideRes] = await Promise.all([
    supabase
      .schema("resupply")
      .from("alert_messages")
      .select("subject, body_html, body_text, is_active")
      .eq("alert_key", alertKey)
      .eq("channel", channel)
      .limit(1)
      .maybeSingle(),
    supabase
      .schema("resupply")
      .from("alert_message_overrides")
      .select("subject, body_html, body_text, is_active")
      .eq("patient_id", patientId)
      .eq("alert_key", alertKey)
      .eq("channel", channel)
      .limit(1)
      .maybeSingle(),
  ]);
  // A missing alert_messages table (migration 0179) degrades to
  // `message_not_configured`; a missing override table (0180) degrades
  // to the global message. Both keep the route forward-deploy-safe.
  if (globalRes.error) {
    logger.warn(
      { event: "alert_dispatch_message_lookup_failed", alertKey, channel },
      "alert dispatch: alert_messages lookup failed; treating as not configured",
    );
    return { status: "message_not_configured", channel };
  }
  const override = overrideRes.error ? null : (overrideRes.data ?? null);

  const global = globalRes.data;
  if (!global || !global.is_active) {
    return { status: "message_not_configured", channel };
  }
  // An override with is_active=false explicitly SUPPRESSES this alert
  // for this patient on this channel.
  if (override && !override.is_active) {
    return { status: "suppressed_for_patient", channel };
  }
  // Layer the override per-field over the global; null override fields
  // inherit from the global.
  const msg = {
    subject: override?.subject ?? global.subject,
    body_html: override?.body_html ?? global.body_html,
    body_text: override?.body_text ?? global.body_text,
  };

  // 3. Patient.
  const { data: patient, error: patientErr } = await supabase
    .schema("resupply")
    .from("patients")
    .select("id, status, email, phone_e164, legal_first_name")
    .eq("id", patientId)
    .limit(1)
    .maybeSingle();
  if (patientErr) throw patientErr;
  if (!patient) return { status: "patient_not_found" };
  if (patient.status !== "active") {
    return { status: "patient_not_active", patientStatus: patient.status };
  }

  // 4. Render. Caller variables win over the derived defaults.
  const practiceName = process.env.RESUPPLY_PRACTICE_NAME?.trim() || "PennPaps";
  const variables: Record<string, string> = {
    first_name: patient.legal_first_name ?? "there",
    practice_name: practiceName,
    ...(input.variables ?? {}),
  };
  const rendered = renderAlertMessage({
    subject: msg.subject,
    bodyHtml: msg.body_html,
    bodyText: msg.body_text,
    allowedVariables: def.allowed_variables ?? [],
    variables,
  });

  // Refuse to ship a message that still has unresolved `{{tokens}}`.
  // `applyVariables` leaves a variable literal when the caller didn't
  // supply it — without this guard a "Send test" with only patientId +
  // channel would deliver a raw `{{order_number}}` to a real patient.
  const missing = unresolvedTokens(
    rendered.subject,
    rendered.bodyHtml,
    rendered.bodyText,
  );
  if (missing.length > 0) {
    return { status: "unresolved_variables", channel, missing };
  }

  // 5. Send.
  if (channel === "email") {
    if (!patient.email) return { status: "patient_missing_email" };
    // Per-channel config: an email-only deployment must be able to send
    // alerts even when Twilio SMS isn't configured (and vice versa).
    const cfg = readEmailConfigOrNull();
    if (!cfg) return { status: "messaging_not_configured" };
    try {
      const sg = createSendgridClient({
        apiKey: cfg.sendgridApiKey,
        fromEmail: cfg.sendgridFromEmail,
        fromName: cfg.sendgridFromName,
      });
      // When the email message has no HTML body, wrap the (HTML-escaped)
      // plain-text body so an admin-typed `<` / `&` — or an unescaped
      // variable value — can't inject markup into the rendered email.
      const html =
        rendered.bodyHtml ??
        `<pre style="font-family:inherit;white-space:pre-wrap;">${escapeHtml(
          rendered.bodyText,
        )}</pre>`;
      const r = await sg.sendEmail({
        to: patient.email,
        subject: rendered.subject ?? "",
        html,
        text: rendered.bodyText,
        customArgs: { kind: "alert", alert_key: alertKey },
      });
      return { status: "ok", channel, vendorRef: r.messageId };
    } catch (err) {
      return vendorOutcome(channel, err);
    }
  }

  if (channel === "sms") {
    if (!patient.phone_e164) return { status: "patient_missing_phone" };
    const normalized = normalizeE164(patient.phone_e164);
    if (!normalized) return { status: "patient_phone_unnormalizable" };
    const cfg = readSmsConfigOrNull();
    if (!cfg) return { status: "messaging_not_configured" };
    try {
      const sms = createTwilioSmsClient({
        accountSid: cfg.twilioAccountSid,
        authToken: cfg.twilioAuthToken,
        from: cfg.twilioPhoneNumber,
        messagingServiceSid: cfg.twilioMessagingServiceSid,
      });
      const r = await sms.sendSms({ to: normalized, body: rendered.bodyText });
      return { status: "ok", channel, vendorRef: r.messageSid };
    } catch (err) {
      return vendorOutcome(channel, err);
    }
  }

  // channel === "voice"
  if (!patient.phone_e164) return { status: "patient_missing_phone" };
  const normalized = normalizeE164(patient.phone_e164);
  if (!normalized) return { status: "patient_phone_unnormalizable" };
  const voiceCfg = readVoiceConfigOrNull();
  if (!voiceCfg || !voiceCfg.twilioPhoneNumber) {
    return { status: "voice_not_configured" };
  }
  // Stash the spoken transcript under an opaque ref so it never rides
  // the webhook URL (which Twilio logs). The TwiML endpoint reads it
  // back when the patient answers.
  const ref = randomUUID();
  getAlertVoiceScripts().register(ref, rendered.bodyText);
  const base = voiceCfg.publicBaseUrl;
  try {
    const twilio = createTwilioClient({
      accountSid: voiceCfg.twilioAccountSid,
      authToken: voiceCfg.twilioAuthToken,
    });
    const r = await twilio.placeCall({
      to: normalized,
      from: voiceCfg.twilioPhoneNumber,
      url: `${base}/resupply-api/voice/alert-twiml?ref=${encodeURIComponent(ref)}`,
      statusCallbackUrl: `${base}/resupply-api/voice/status-callback?conversationId=${encodeURIComponent(ref)}`,
    });
    return { status: "ok", channel, vendorRef: r.sid };
  } catch (err) {
    return vendorOutcome(channel, err);
  }
}

/**
 * Map a thrown vendor error to the dispatch outcome. Config errors
 * (missing secrets) and unexpected exceptions re-throw so they surface
 * in the application log; recoverable API errors become a tagged
 * `vendor_error`.
 */
function vendorOutcome(
  channel: AlertChannel,
  err: unknown,
): DispatchAlertOutcome {
  if (err instanceof TwilioConfigError || err instanceof EmailConfigError) {
    throw err;
  }
  if (err instanceof TwilioApiError) {
    logger.warn(
      { event: "alert_dispatch_vendor_error", channel, status: err.status },
      "alert dispatch: twilio api error",
    );
    return {
      status: "vendor_error",
      channel,
      vendorStatus: err.status ?? null,
      vendorCode: err.code != null ? String(err.code) : null,
    };
  }
  if (err instanceof EmailApiError) {
    logger.warn(
      { event: "alert_dispatch_vendor_error", channel, status: err.status },
      "alert dispatch: sendgrid api error",
    );
    return {
      status: "vendor_error",
      channel,
      vendorStatus: err.status ?? null,
      vendorCode: null,
    };
  }
  throw err;
}
