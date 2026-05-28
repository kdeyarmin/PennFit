// replyInConversation — admin-typed message appended to an EXISTING
// conversation thread.
//
// This is the sibling of `sendReminderSms` / `sendReminderEmail` but
// with one critical difference: those helpers always create a brand
// new `conversations` row, which is correct for templated outbound
// reminders (each reminder starts its own thread). Reply does NOT
// create a new conversation — it appends to the open thread the
// admin is looking at, so the patient sees the back-and-forth as one
// continuous SMS/email conversation.
//
// The channel comes from the conversation row, not from the caller —
// admins reply on whichever channel the patient was already using.
//
// Audit invariants (mirror sendReminder*):
//   - This helper writes its own audit row on success and on
//     vendor-failure paths.
//   - Metadata is structural — never the body, phone number, or
//     email address plaintext. We DO record `body_length` so admins
//     reviewing the audit log can spot suspiciously empty / long
//     replies without exposing PHI.

import { normalizeE164 } from "@workspace/resupply-domain";
import {
  tryUpsertPatientLatestMessageSb,
  type Json,
  type ResupplySupabaseClient,
} from "@workspace/resupply-db";
import {
  createSendgridClient,
  EmailApiError,
  EmailConfigError,
} from "@workspace/resupply-email";
import {
  createTwilioSmsClient,
  TwilioApiError,
  TwilioConfigError,
} from "@workspace/resupply-telecom";

import { safeAuditFromActor } from "./safe-audit";
import type { EmailSendConfig, SendActor, SmsSendConfig } from "./types";

export interface ReplyInConversationInput {
  supabase: ResupplySupabaseClient;
  /**
   * Both configs are required because the conversation's channel
   * decides which one we'll use, and the API route can't know which
   * channel a given conversation is on without a database round-trip.
   * Passing both keeps the route handler simple.
   */
  smsCfg: SmsSendConfig;
  emailCfg: EmailSendConfig;
  conversationId: string;
  body: string;
  actor: SendActor;
}

export type ReplyInConversationOutcome =
  | {
      status: "ok";
      conversationId: string;
      /** Undefined when the vendor send succeeded but the DB write failed. */
      messageId: string | undefined;
      vendorRef: string;
    }
  | { status: "conversation_not_found" }
  | { status: "conversation_closed" }
  | { status: "patient_missing_contact"; channel: "sms" | "email" }
  | { status: "patient_phone_unnormalizable" }
  /**
   * The conversation is on a channel this dispatcher doesn't handle
   * (currently only `in_app`). Callers must branch BEFORE invoking
   * this helper for in-app threads — see
   * `routes/conversations/reply.ts` for the dispatch split.
   */
  | { status: "unsupported_channel"; channel: string }
  | {
      status: "vendor_api_error";
      vendor: "sms_vendor" | "email_vendor";
      vendorStatus: number | null;
      vendorCode: string | null;
    };

export async function replyInConversation(
  input: ReplyInConversationInput,
): Promise<ReplyInConversationOutcome> {
  const { supabase, conversationId, body, actor } = input;

  const { data: conv, error: convErr } = await supabase
    .schema("resupply")
    .from("conversations")
    .select("id, patient_id, episode_id, channel, status")
    .eq("id", conversationId)
    .limit(1)
    .maybeSingle();
  if (convErr) throw convErr;
  if (!conv) return { status: "conversation_not_found" };
  if (conv.status === "closed") return { status: "conversation_closed" };

  // Voice conversations are TwiML/transcript-driven — there is no
  // admin-typed reply path on voice. Surface as "missing contact"
  // so the route handler returns a clean 409.
  if (conv.channel === "voice") {
    return { status: "patient_missing_contact", channel: "sms" };
  }

  // In-app shop-customer threads (added in 0033) are handled by a
  // separate code path; this dispatcher is patient-flow-only. Return
  // `unsupported_channel` so the caller knows to branch — in
  // practice the route handler already branches BEFORE this call,
  // so this is a defense-in-depth safety return.
  if (conv.channel === "in_app") {
    return { status: "unsupported_channel", channel: "in_app" };
  }

  // Post-0033 the schema marks patient_id nullable so in-app threads
  // can omit it, but the CHECK constraint guarantees that any row
  // whose channel is sms/voice/email has patient_id set. Voice was
  // returned above; in_app was returned above; we're SMS or email
  // here. The defensive null check below catches a corrupted row
  // (CHECK should prevent this from being reachable).
  if (!conv.patient_id) {
    return { status: "conversation_not_found" };
  }
  const patientId: string = conv.patient_id;
  const episodeId: string | null = conv.episode_id ?? null;

  const { data: patient, error: patientErr } = await supabase
    .schema("resupply")
    .from("patients")
    .select("id, phone_e164, email")
    .eq("id", patientId)
    .limit(1)
    .maybeSingle();
  if (patientErr) throw patientErr;
  if (!patient) {
    // Conversation is FK-cascaded to the patient, so a missing
    // patient here means the row was deleted between our read and
    // the helper call. Treat as missing contact.
    return { status: "patient_missing_contact", channel: conv.channel as "sms" | "email" };
  }

  // Twilio's per-message body cap is 1600 characters (segmented across
  // up to 10 SMS parts). The conversations/reply HTTP route allows up
  // to 4000 characters because the same endpoint also services email
  // (which has no such cap). Without an explicit SMS-side clamp,
  // bodies in the 1600..4000 range were either silently split into
  // many billed segments (Twilio absorbs the cost question quietly)
  // or rejected with a `vendor_api_error` — neither is great. Truncate
  // at 1600 with a trailing ellipsis so the admin notices the clip.
  const SMS_BODY_MAX = 1600;
  const SMS_BODY_TRUNCATE_TAIL = "… (truncated)";
  const smsBody =
    body.length > SMS_BODY_MAX
      ? body.slice(0, SMS_BODY_MAX - SMS_BODY_TRUNCATE_TAIL.length) +
        SMS_BODY_TRUNCATE_TAIL
      : body;

  let vendorRef: string;
  if (conv.channel === "sms") {
    if (!patient.phone_e164) {
      return { status: "patient_missing_contact", channel: "sms" };
    }
    const normalizedPhone = normalizeE164(patient.phone_e164);
    if (!normalizedPhone) return { status: "patient_phone_unnormalizable" };

    const statusCallbackUrl = `${input.smsCfg.publicBaseUrl}/resupply-api/sms/status-callback?conversationId=${encodeURIComponent(
      conversationId,
    )}`;
    try {
      const sms = createTwilioSmsClient({
        accountSid: input.smsCfg.twilioAccountSid,
        authToken: input.smsCfg.twilioAuthToken,
        from: input.smsCfg.twilioPhoneNumber,
        messagingServiceSid: input.smsCfg.twilioMessagingServiceSid,
      });
      const r = await sms.sendSms({
        to: normalizedPhone,
        body: smsBody,
        statusCallbackUrl,
      });
      vendorRef = r.messageSid;
    } catch (err) {
      if (err instanceof TwilioConfigError) throw err;
      if (err instanceof TwilioApiError) {
        await safeAuditFromActor({
          action: "messaging.reply.sent",
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
            body_length: body.length,
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
  } else {
    // email
    if (!patient.email) {
      return { status: "patient_missing_contact", channel: "email" };
    }
    try {
      const sg = createSendgridClient({
        apiKey: input.emailCfg.sendgridApiKey,
        fromEmail: input.emailCfg.sendgridFromEmail,
        fromName: input.emailCfg.sendgridFromName,
      });
      // Plain text email — admin-typed replies don't render through
      // the templated reminder. Subject reuses the practice name as
      // a "Re:"-style prefix so the patient's mail client threads
      // it with the original reminder.
      const subject = `Re: ${input.emailCfg.practiceName.replace(/[\r\n]/g, "")} — your CPAP supplies`;
      const r = await sg.sendEmail({
        to: patient.email,
        subject,
        text: body,
        html: `<p style="white-space: pre-wrap; font-family: -apple-system, system-ui, sans-serif; line-height: 1.5">${escapeHtml(body)}</p>`,
        customArgs: {
          conversation_id: conversationId,
          patient_id: patientId,
          episode_id: episodeId ?? "",
        },
      });
      vendorRef = r.messageId;
    } catch (err) {
      if (err instanceof EmailConfigError) throw err;
      if (err instanceof EmailApiError) {
        await safeAuditFromActor({
          action: "messaging.reply.sent",
          actor,
          targetTable: "conversations",
          targetId: conversationId,
          metadata: {
            channel: "email",
            patient_id: patientId,
            episode_id: episodeId,
            conversation_id: conversationId,
            status: "sendgrid_error",
            sendgrid_status: err.status ?? null,
            body_length: body.length,
          },
        });
        return {
          status: "vendor_api_error",
          vendor: "email_vendor",
          vendorStatus: err.status ?? null,
          vendorCode: null,
        };
      }
      throw err;
    }
  }

  // Persist the outbound message + thread the conversation forward.
  // Vendor accepted the message above. Wrap DB writes so a transient DB
  // error does NOT propagate as an unhandled exception — the caller would
  // see a 500 and retry, sending a duplicate message to the patient.
  // On DB failure we return "ok" with a sentinel messageId so the route
  // can render "sent" rather than "error". vendorRef in the log lets ops
  // manually reconcile the missing row.
  const sentAt = new Date();
  const sentAtIso = sentAt.toISOString();
  let messageId: string | undefined;
  try {
    const { data: inserted, error: insertMsgErr } = await supabase
      .schema("resupply")
      .from("messages")
      .insert({
        conversation_id: conversationId,
        direction: "outbound",
        sender_role: "admin",
        // Persist what we actually sent. For SMS that's `smsBody`
        // (potentially truncated to 1600); for email it's the
        // untouched `body`.
        body: conv.channel === "sms" ? smsBody : body,
        delivery_status: "queued",
        vendor_metadata:
          (conv.channel === "sms"
            ? { twilio_message_sid: vendorRef }
            : { sendgrid_message_id: vendorRef }) as unknown as Json,
        sent_at: sentAtIso,
      })
      .select("id")
      .limit(1)
      .maybeSingle();
    if (insertMsgErr) throw insertMsgErr;
    messageId = inserted?.id;

    const { error: stampConvErr } = await supabase
      .schema("resupply")
      .from("conversations")
      .update({
        last_message_at: sentAtIso,
        // Admin replied — the ball is back in the patient's court.
        // We don't transition closed→ here; that's gated above.
        status: "awaiting_patient",
        updated_at: sentAtIso,
      })
      .eq("id", conversationId);
    if (stampConvErr) throw stampConvErr;
  } catch (dbErr) {
    process.stderr.write(
      JSON.stringify({
        level: 50,
        event: "reply_db_write_failed_after_vendor_accept",
        conversationId,
        vendorRef,
        channel: conv.channel,
        errName: dbErr instanceof Error ? dbErr.name : "non_error",
        errMessage: dbErr instanceof Error ? dbErr.message : String(dbErr),
        msg: "Reply delivered by vendor but messages row not written — manual reconciliation required",
      }) + "\n",
    );
  }

  // Refresh latest-message projection (best-effort).
  await tryUpsertPatientLatestMessageSb(supabase, {
    conversationId,
    body,
    direction: "outbound",
    messageAt: sentAt,
  });

  await safeAuditFromActor({
    action: "messaging.reply.sent",
    actor,
    targetTable: "conversations",
    targetId: conversationId,
    metadata: {
      channel: conv.channel,
      patient_id: patientId,
      episode_id: episodeId,
      conversation_id: conversationId,
      message_id: messageId,
      status: "ok",
      body_length: body.length,
      vendor_ref: vendorRef,
    },
  });

  return { status: "ok", conversationId, messageId, vendorRef };
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
