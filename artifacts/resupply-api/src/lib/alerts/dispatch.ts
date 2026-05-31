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
import { readMessagingConfigOrNull } from "../messaging/messaging-config";
import { readVoiceConfigOrNull } from "../voice/voice-config";
import { getAlertVoiceScripts } from "./voice-scripts";

export type AlertChannel = "email" | "sms" | "voice";

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

  // 1. Alert definition.
  const { data: def, error: defErr } = await supabase
    .schema("resupply")
    .from("alert_definitions")
    .select("key, channels, allowed_variables, is_active")
    .eq("key", alertKey)
    .limit(1)
    .maybeSingle();
  if (defErr) throw defErr;
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
  if (globalRes.error) throw globalRes.error;
  // A missing override table (migration 0180 not yet applied) must not
  // break the send — degrade to the global message. PostgREST surfaces
  // "relation does not exist" as a query error; swallow it here.
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

  // 5. Send.
  if (channel === "email") {
    if (!patient.email) return { status: "patient_missing_email" };
    const cfg = readMessagingConfigOrNull();
    if (!cfg) return { status: "messaging_not_configured" };
    try {
      const sg = createSendgridClient({
        apiKey: cfg.email.sendgridApiKey,
        fromEmail: cfg.email.sendgridFromEmail,
        fromName: cfg.email.sendgridFromName,
      });
      const r = await sg.sendEmail({
        to: patient.email,
        subject: rendered.subject ?? "",
        html: rendered.bodyHtml ?? rendered.bodyText,
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
    const cfg = readMessagingConfigOrNull();
    if (!cfg) return { status: "messaging_not_configured" };
    try {
      const sms = createTwilioSmsClient({
        accountSid: cfg.sms.twilioAccountSid,
        authToken: cfg.sms.twilioAuthToken,
        from: cfg.sms.twilioPhoneNumber,
        messagingServiceSid: cfg.sms.twilioMessagingServiceSid,
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
