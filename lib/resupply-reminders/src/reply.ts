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

import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";

import { normalizeE164 } from "@workspace/resupply-domain";
import {
  conversations,
  messages,
  patients,
  tryUpsertPatientLatestMessage,
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
  pool: Pool;
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
      messageId: string;
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
  const { pool, conversationId, body, actor } = input;
  const db = drizzle(pool);

  const convRows = await db
    .select({
      id: conversations.id,
      patientId: conversations.patientId,
      episodeId: conversations.episodeId,
      channel: conversations.channel,
      status: conversations.status,
    })
    .from(conversations)
    .where(eq(conversations.id, conversationId))
    .limit(1);
  const conv = convRows[0];
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
  if (!conv.patientId) {
    return { status: "conversation_not_found" };
  }
  const patientId: string = conv.patientId;
  const episodeId: string | null = conv.episodeId ?? null;

  const patientRows = await db
    .select({
      id: patients.id,
      phoneE164: patients.phoneE164,
      email: patients.email,
    })
    .from(patients)
    .where(eq(patients.id, patientId))
    .limit(1);
  const patient = patientRows[0];
  if (!patient) {
    // Conversation is FK-cascaded to the patient, so a missing
    // patient here means the row was deleted between our read and
    // the helper call. Treat as missing contact.
    return { status: "patient_missing_contact", channel: conv.channel };
  }

  let vendorRef: string;
  if (conv.channel === "sms") {
    if (!patient.phoneE164) {
      return { status: "patient_missing_contact", channel: "sms" };
    }
    const normalizedPhone = normalizeE164(patient.phoneE164);
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
        body,
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
  const sentAt = new Date();
  const inserted = await db
    .insert(messages)
    .values({
      conversationId,
      direction: "outbound",
      senderRole: "admin",
      body,
      deliveryStatus: "queued",
      vendorMetadata:
        conv.channel === "sms"
          ? { twilio_message_sid: vendorRef }
          : { sendgrid_message_id: vendorRef },
      sentAt,
    })
    .returning({ id: messages.id });
  const messageId = inserted[0]?.id;
  if (!messageId) {
    // Should never happen — RETURNING guarantees the row when the
    // INSERT succeeds. Treat as vendor error so the route surfaces
    // a 5xx instead of pretending the send was clean.
    return {
      status: "vendor_api_error",
      vendor: conv.channel === "sms" ? "sms_vendor" : "email_vendor",
      vendorStatus: null,
      vendorCode: null,
    };
  }

  await db
    .update(conversations)
    .set({
      lastMessageAt: sentAt,
      // Admin replied — the ball is back in the patient's court.
      // We don't transition closed→ here; that's gated above.
      status: "awaiting_patient",
      updatedAt: sentAt,
    })
    .where(eq(conversations.id, conversationId));

  // Refresh latest-message projection (best-effort).
  await tryUpsertPatientLatestMessage(db, {
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
