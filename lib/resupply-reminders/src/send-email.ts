// sendReminderEmail — shared code path for outbound reminder emails.
//
// Mirrors send-sms exactly:
//   - Returns a tagged-union outcome (no exceptions on recoverable
//     errors).
//   - Audits success and SendGrid-failure paths from inside the helper.
//   - Vendor-config errors throw — caller must surface to admin.
//
// What's different from SMS:
//   - No phone_lookup upsert (email channel uses signed link tokens
//     for inbound action, not reverse phone lookup).
//   - We sign three short-TTL link tokens (confirm/edit/stop) and embed
//     them in the rendered template.
//   - SendGrid customArgs carries conversation_id so the event-webhook
//     can correlate bounces/deliveries back to our row.

import { desc, eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";

import {
  conversations,
  decrypt,
  encrypt,
  episodes,
  messages,
  patients,
  prescriptions,
} from "@workspace/resupply-db";
import {
  createSendgridClient,
  EmailApiError,
  EmailConfigError,
} from "@workspace/resupply-email";
import {
  renderResupplyReminder,
  signLinkToken,
} from "@workspace/resupply-messaging";

import { safeAuditFromActor } from "./safe-audit";
import type { EmailSendConfig, SendActor, SendReminderOutcome } from "./types";

export interface SendReminderEmailInput {
  pool: Pool;
  cfg: EmailSendConfig;
  patientId: string;
  episodeId?: string;
  actor: SendActor;
}

const LINK_TOKEN_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export async function sendReminderEmail(
  input: SendReminderEmailInput,
): Promise<SendReminderOutcome> {
  const { pool, cfg, patientId, actor } = input;
  const db = drizzle(pool);

  const patientRows = await db
    .select({
      id: patients.id,
      status: patients.status,
      email: decrypt(patients.email),
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
  if (!patient.email) return { status: "patient_missing_email" };

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
  }

  const epRows = await db
    .select({
      id: episodes.id,
      patientId: episodes.patientId,
      prescriptionId: episodes.prescriptionId,
    })
    .from(episodes)
    .where(eq(episodes.id, episodeId))
    .limit(1);
  const ep = epRows[0];
  if (!ep) return { status: "episode_not_found" };
  if (ep.patientId !== patientId) return { status: "episode_patient_mismatch" };

  const rxRows = await db
    .select({ itemSku: prescriptions.itemSku })
    .from(prescriptions)
    .where(eq(prescriptions.id, ep.prescriptionId))
    .limit(1);
  const itemSku = rxRows[0]?.itemSku;
  const items: Array<{ name: string; quantity: number }> = itemSku
    ? [{ name: itemSku, quantity: 1 }]
    : [];

  const insertedConv = await db
    .insert(conversations)
    .values({
      patientId,
      episodeId,
      channel: "email",
      status: "open",
      lastMessageAt: new Date(),
    })
    .returning({ id: conversations.id });
  const conversationId = insertedConv[0]?.id;
  if (!conversationId) return { status: "conversation_create_failed" };

  const expiresAt = Date.now() + LINK_TOKEN_TTL_MS;
  const baseClick = `${cfg.publicBaseUrl}/resupply-api/email/click`;
  const confirmUrl = `${baseClick}?t=${encodeURIComponent(
    signLinkToken({ conversationId, action: "confirm", expiresAt }),
  )}`;
  const editUrl = `${baseClick}?t=${encodeURIComponent(
    signLinkToken({ conversationId, action: "edit", expiresAt }),
  )}`;
  const stopUrl = `${baseClick}?t=${encodeURIComponent(
    signLinkToken({ conversationId, action: "stop", expiresAt }),
  )}`;

  const rendered = renderResupplyReminder({
    practiceName: cfg.practiceName,
    firstName: patient.legalFirstName ?? "there",
    items,
    confirmUrl,
    editUrl,
    stopUrl,
  });

  let messageId: string;
  try {
    const sg = createSendgridClient({
      apiKey: cfg.sendgridApiKey,
      fromEmail: cfg.sendgridFromEmail,
      fromName: cfg.sendgridFromName,
    });
    const r = await sg.sendEmail({
      to: patient.email,
      subject: rendered.subject,
      html: rendered.html,
      text: rendered.text,
      customArgs: {
        conversation_id: conversationId,
        patient_id: patientId,
        episode_id: episodeId,
      },
    });
    messageId = r.messageId;
  } catch (err) {
    if (err instanceof EmailConfigError) {
      // Surface to caller — see send-sms for rationale.
      throw err;
    }
    if (err instanceof EmailApiError) {
      await safeAuditFromActor({
        action: "messaging.reminder.sent",
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

  await db.insert(messages).values({
    conversationId,
    direction: "outbound",
    senderRole: "agent",
    body: sql`${encrypt(rendered.text)}`,
    deliveryStatus: "queued",
    vendorMetadata: {
      sendgrid_message_id: messageId,
      subject: rendered.subject,
    },
    sentAt: new Date(),
  });
  await db
    .update(conversations)
    .set({ externalRef: messageId, updatedAt: new Date() })
    .where(eq(conversations.id, conversationId));

  await safeAuditFromActor({
    action: "messaging.reminder.sent",
    actor,
    targetTable: "conversations",
    targetId: conversationId,
    metadata: {
      channel: "email",
      patient_id: patientId,
      episode_id: episodeId,
      conversation_id: conversationId,
      status: "ok",
      sendgrid_message_id: messageId,
    },
  });

  return { status: "ok", conversationId, vendorRef: messageId };
}
