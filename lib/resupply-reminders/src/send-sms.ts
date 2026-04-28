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
// Audit invariants (per ADR 008 / ADR 009 / Rule 8):
//   - Audit is written from this function for both success and
//     vendor-failure paths. The caller MUST NOT double-audit.
//   - Metadata is structural only — never the SMS body, never the
//     phone number plaintext, never the admin's typed text.

import { desc, eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";

import {
  conversations,
  decrypt,
  encrypt,
  episodes,
  hmacPhone,
  messages,
  normalizeE164,
  patients,
  phoneLookup,
} from "@workspace/resupply-db";
import {
  createTwilioSmsClient,
  TwilioApiError,
  TwilioConfigError,
} from "@workspace/resupply-telecom";

import { safeAuditFromActor } from "./safe-audit";
import type { SendActor, SendReminderOutcome, SmsSendConfig } from "./types";

export interface SendReminderSmsInput {
  pool: Pool;
  cfg: SmsSendConfig;
  patientId: string;
  episodeId?: string;
  /**
   * Optional override for the message body. When absent we render a
   * default reminder template. Admin-typed bodies are passed through
   * verbatim to Twilio (and stored encrypted in `messages.body`).
   */
  body?: string;
  actor: SendActor;
}

export async function sendReminderSms(
  input: SendReminderSmsInput,
): Promise<SendReminderOutcome> {
  const { pool, cfg, patientId, actor } = input;
  const db = drizzle(pool);

  const patientRows = await db
    .select({
      id: patients.id,
      status: patients.status,
      phoneE164: decrypt(patients.phoneE164),
      legalFirstName: decrypt(patients.legalFirstName),
    })
    .from(patients)
    .where(eq(patients.id, patientId))
    .limit(1);
  const patient = patientRows[0];
  if (!patient) return { status: "patient_not_found" };
  if (patient.status !== "active") {
    return { status: "patient_not_active", patientStatus: patient.status };
  }
  if (!patient.phoneE164) return { status: "patient_missing_phone" };

  // Resolve episode — explicit if provided, else most recent.
  let episodeId = input.episodeId;
  if (!episodeId) {
    const recent = await db
      .select({ id: episodes.id })
      .from(episodes)
      .where(eq(episodes.patientId, patientId))
      .orderBy(desc(episodes.dueAt))
      .limit(1);
    episodeId = recent[0]?.id;
    if (!episodeId) return { status: "no_episode_for_patient" };
  } else {
    const epRows = await db
      .select({ id: episodes.id, patientId: episodes.patientId })
      .from(episodes)
      .where(eq(episodes.id, episodeId))
      .limit(1);
    const ep = epRows[0];
    if (!ep) return { status: "episode_not_found" };
    if (ep.patientId !== patientId) {
      return { status: "episode_patient_mismatch" };
    }
  }

  const normalizedPhone = normalizeE164(patient.phoneE164);
  if (!normalizedPhone) return { status: "patient_phone_unnormalizable" };
  const hmac = hmacPhone(normalizedPhone);

  // Phone-lookup upsert (safe variant).
  //
  // The naive `ON CONFLICT (hmac_phone) DO UPDATE SET patient_id = …`
  // upsert silently REASSIGNS the lookup row's patientId whenever two
  // patients share a phone number — and that reassignment moves every
  // subsequent inbound reply (including STOP keywords and order
  // confirmations) onto the wrong patient. We refuse to do that.
  //
  // Correct semantics:
  //   - If no row exists for this hmac → insert it bound to patientId.
  //   - If a row exists for this hmac AND it belongs to patientId →
  //     refresh updated_at (idempotent re-send).
  //   - If a row exists for this hmac AND it belongs to a DIFFERENT
  //     patient → CONFLICT. Do NOT overwrite. Audit + abort the send
  //     so an admin can resolve the data-quality issue.
  //
  // We use ON CONFLICT (patient_id) — the table's primary key — which
  // is the only conflict path we want to silently merge (same patient,
  // potentially-changed phone). The hmac_phone unique index will fire
  // a 23505 if a different patient owns the hmac; we trap that as a
  // belt-and-braces guard against TOCTOU between the read-check and
  // the upsert.
  const existingByHmac = await db
    .select({ patientId: phoneLookup.patientId })
    .from(phoneLookup)
    .where(eq(phoneLookup.hmacPhone, hmac))
    .limit(1);
  if (existingByHmac[0] && existingByHmac[0].patientId !== patientId) {
    await safeAuditFromActor({
      action: "messaging.phone_lookup.conflict",
      actor,
      targetTable: "phone_lookup",
      targetId: null,
      metadata: {
        channel: "sms",
        patient_id: patientId,
        existing_patient_id: existingByHmac[0].patientId,
        reason: "phone_in_use_by_other_patient",
      },
    });
    return {
      status: "phone_in_use_by_other_patient",
      existingPatientId: existingByHmac[0].patientId,
    };
  }
  try {
    await db
      .insert(phoneLookup)
      .values({ patientId, hmacPhone: hmac })
      .onConflictDoUpdate({
        target: phoneLookup.patientId,
        set: { hmacPhone: hmac, updatedAt: new Date() },
      });
  } catch (err) {
    // Postgres unique-violation on hmac_phone — another patient won
    // the race between our read-check above and this insert. Treat
    // identically to the read-check path: audit + abort.
    if (
      err != null &&
      typeof err === "object" &&
      "code" in err &&
      (err as { code?: unknown }).code === "23505"
    ) {
      const reread = await db
        .select({ patientId: phoneLookup.patientId })
        .from(phoneLookup)
        .where(eq(phoneLookup.hmacPhone, hmac))
        .limit(1);
      const existingId = reread[0]?.patientId ?? "<unknown>";
      await safeAuditFromActor({
        action: "messaging.phone_lookup.conflict",
        actor,
        targetTable: "phone_lookup",
        targetId: null,
        metadata: {
          channel: "sms",
          patient_id: patientId,
          existing_patient_id: existingId,
          reason: "phone_in_use_by_other_patient_race",
        },
      });
      return {
        status: "phone_in_use_by_other_patient",
        existingPatientId: existingId,
      };
    }
    throw err;
  }

  const insertedConv = await db
    .insert(conversations)
    .values({
      patientId,
      episodeId,
      channel: "sms",
      status: "open",
      lastMessageAt: new Date(),
    })
    .returning({ id: conversations.id });
  const conversationId = insertedConv[0]?.id;
  if (!conversationId) return { status: "conversation_create_failed" };

  const messageBody =
    input.body ??
    `Hi ${patient.legalFirstName}, this is ${cfg.practiceName}. Time to refill ` +
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

  await db.insert(messages).values({
    conversationId,
    direction: "outbound",
    senderRole: "agent",
    body: sql`${encrypt(messageBody)}`,
    deliveryStatus: "queued",
    vendorMetadata: { twilio_message_sid: messageSid },
    sentAt: new Date(),
  });
  await db
    .update(conversations)
    .set({ externalRef: messageSid, updatedAt: new Date() })
    .where(eq(conversations.id, conversationId));

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
