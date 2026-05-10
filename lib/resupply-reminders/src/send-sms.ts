// sendReminderSms — shared code path for outbound reminder SMS.
//
// Called by:
//   - POST /sms/send-reminder       (admin-initiated, actor='admin')
//   - reminders.send-sms pg-boss job (system-initiated, actor='system')
//
// The function never throws on a recoverable error — it returns a
// tagged outcome the caller translates to HTTP / log / retry.
// Vendor-config errors and unexpected exceptions DO bubble up because
// they indicate a deploy-level misconfiguration the caller wants to
// see in pino + Sentry rather than swallow.
//
// Audit invariants (per ADR 008 / Rule 8):
//   - Audit is written from this function for both success and
//     vendor-failure paths. The caller MUST NOT double-audit.
//   - Metadata is structural only — never the SMS body, never the
//     phone number plaintext, never the admin's typed text.

import { normalizeE164 } from "@workspace/resupply-domain";
import {
  tryUpsertPatientLatestMessageSb,
  type Json,
  type ResupplySupabaseClient,
} from "@workspace/resupply-db";
import {
  createTwilioSmsClient,
  TwilioApiError,
  TwilioConfigError,
} from "@workspace/resupply-telecom";

import { safeAuditFromActor } from "./safe-audit";
import type { SendActor, SendReminderOutcome, SmsSendConfig } from "./types";

export interface SendReminderSmsInput {
  supabase: ResupplySupabaseClient;
  cfg: SmsSendConfig;
  patientId: string;
  episodeId?: string;
  /**
   * Optional override for the message body. When absent we render a
   * default reminder template. Admin-typed bodies are passed through
   * verbatim to Twilio and stored as-is in `messages.body`.
   */
  body?: string;
  actor: SendActor;
}

export async function sendReminderSms(
  input: SendReminderSmsInput,
): Promise<SendReminderOutcome> {
  const { supabase, cfg, patientId, actor } = input;

  const { data: patient, error: patientErr } = await supabase
    .schema("resupply")
    .from("patients")
    .select("id, status, phone_e164, legal_first_name")
    .eq("id", patientId)
    .limit(1)
    .maybeSingle();
  if (patientErr) throw patientErr;
  if (!patient) return { status: "patient_not_found" };
  if (patient.status !== "active") {
    return { status: "patient_not_active", patientStatus: patient.status };
  }
  if (!patient.phone_e164) return { status: "patient_missing_phone" };

  // Resolve episode — explicit if provided, else most recent.
  let episodeId = input.episodeId;
  if (!episodeId) {
    const { data: recent, error: recentErr } = await supabase
      .schema("resupply")
      .from("episodes")
      .select("id")
      .eq("patient_id", patientId)
      .order("due_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (recentErr) throw recentErr;
    episodeId = recent?.id;
    if (!episodeId) return { status: "no_episode_for_patient" };
  } else {
    const { data: ep, error: epErr } = await supabase
      .schema("resupply")
      .from("episodes")
      .select("id, patient_id")
      .eq("id", episodeId)
      .limit(1)
      .maybeSingle();
    if (epErr) throw epErr;
    if (!ep) return { status: "episode_not_found" };
    if (ep.patient_id !== patientId) {
      return { status: "episode_patient_mismatch" };
    }
  }

  const normalizedPhone = normalizeE164(patient.phone_e164);
  if (!normalizedPhone) return { status: "patient_phone_unnormalizable" };

  // Inbound-routing safety check.
  //
  // The inbound-SMS webhook resolves the From number to a patient via
  // a direct equality lookup on `patients.phone_e164`. If TWO patient
  // rows share the same normalized phone number, that lookup becomes
  // ambiguous and replies (including STOP keywords and order
  // confirmations) will route to whichever row Postgres returns
  // first. We refuse to send before the ambiguity exists, audit it,
  // and let an admin de-duplicate the patient roster.
  const { data: otherOwners, error: otherOwnersErr } = await supabase
    .schema("resupply")
    .from("patients")
    .select("id")
    .eq("phone_e164", normalizedPhone)
    .limit(2); // need at most 2 rows to detect the conflict
  if (otherOwnersErr) throw otherOwnersErr;
  const otherIds = (otherOwners ?? [])
    .map((r) => r.id)
    .filter((id) => id !== patientId);
  if (otherIds.length > 0) {
    await safeAuditFromActor({
      action: "messaging.phone_lookup.conflict",
      actor,
      targetTable: "patients",
      targetId: null,
      metadata: {
        channel: "sms",
        patient_id: patientId,
        existing_patient_id: otherIds[0],
        reason: "phone_in_use_by_other_patient",
      },
    });
    return {
      status: "phone_in_use_by_other_patient",
      existingPatientId: otherIds[0]!,
    };
  }

  const { data: insertedConv, error: insertConvErr } = await supabase
    .schema("resupply")
    .from("conversations")
    .insert({
      patient_id: patientId,
      episode_id: episodeId,
      channel: "sms",
      status: "open",
      last_message_at: new Date().toISOString(),
    })
    .select("id")
    .limit(1)
    .maybeSingle();
  if (insertConvErr) throw insertConvErr;
  const conversationId = insertedConv?.id;
  if (!conversationId) return { status: "conversation_create_failed" };

  const messageBody =
    input.body ??
    `Hi ${patient.legal_first_name ?? "there"}, this is ${cfg.practiceName}. Time to refill ` +
      "your CPAP supplies — reply YES to confirm shipping to the address on " +
      "file, EDIT to change it, or STOP to opt out.";

  const statusCallbackUrl = `${cfg.publicBaseUrl}/resupply-api/sms/status-callback?conversationId=${encodeURIComponent(
    conversationId,
  )}`;

  let messageSid: string;
  try {
    const sms = createTwilioSmsClient({
      accountSid: cfg.twilioAccountSid,
      authToken: cfg.twilioAuthToken,
      from: cfg.twilioPhoneNumber,
      messagingServiceSid: cfg.twilioMessagingServiceSid,
    });
    const r = await sms.sendSms({
      to: normalizedPhone,
      body: messageBody,
      statusCallbackUrl,
    });
    messageSid = r.messageSid;
  } catch (err) {
    if (err instanceof TwilioConfigError) {
      // Surface to caller — caller decides whether to 503 (api) or
      // crash the worker (worker). Either way the process admin
      // needs to know secrets are misconfigured.
      throw err;
    }
    if (err instanceof TwilioApiError) {
      await safeAuditFromActor({
        action: "messaging.reminder.sent",
        actor,
        targetTable: "conversations",
        targetId: conversationId,
        metadata: {
          channel: "sms",
          patient_id: patientId,
          episode_id: episodeId,
          conversation_id: conversationId,
          status: "twilio_error",
          twilio_status: err.status ?? null,
          twilio_code: err.code != null ? String(err.code) : null,
        },
      });
      return {
        status: "vendor_api_error",
        vendor: "sms_vendor",
        vendorStatus: err.status ?? null,
        vendorCode: err.code != null ? String(err.code) : null,
      };
    }
    throw err;
  }

  const sentAt = new Date();
  const sentAtIso = sentAt.toISOString();
  // Twilio accepted the message. Wrap subsequent DB writes so a transient
  // DB error does NOT propagate — a propagated error causes the worker to
  // retry, which would re-call this function and send a duplicate SMS.
  // The vendorRef in the log is sufficient for ops to manually reconcile.
  try {
    const { error: insertMsgErr } = await supabase
      .schema("resupply")
      .from("messages")
      .insert({
        conversation_id: conversationId,
        direction: "outbound",
        sender_role: "agent",
        body: messageBody,
        delivery_status: "queued",
        vendor_metadata: { twilio_message_sid: messageSid } as unknown as Json,
        sent_at: sentAtIso,
      });
    if (insertMsgErr) throw insertMsgErr;
    const { error: stampConvErr } = await supabase
      .schema("resupply")
      .from("conversations")
      .update({ external_ref: messageSid, updated_at: new Date().toISOString() })
      .eq("id", conversationId);
    if (stampConvErr) throw stampConvErr;
  } catch (dbErr) {
    console.error(
      "[send-sms] DB write failed after Twilio accept — SMS sent but unrecorded. Manual reconciliation required.",
      { conversationId, messageSid, err: dbErr instanceof Error ? dbErr.message : String(dbErr) },
    );
  }

  // Refresh the latest-message projection. Best-effort — a projection
  // failure must not abort the send (the message itself is the source
  // of truth; the projection is a UX accelerator only).
  await tryUpsertPatientLatestMessageSb(supabase, {
    conversationId,
    body: messageBody,
    direction: "outbound",
    messageAt: sentAt,
  });

  await safeAuditFromActor({
    action: "messaging.reminder.sent",
    actor,
    targetTable: "conversations",
    targetId: conversationId,
    metadata: {
      channel: "sms",
      patient_id: patientId,
      episode_id: episodeId,
      conversation_id: conversationId,
      status: "ok",
      twilio_message_sid: messageSid,
    },
  });

  return { status: "ok", conversationId, vendorRef: messageSid };
}
