// sendReminderEmail — shared code path for outbound reminder emails.
//
// Mirrors send-sms exactly:
//   - Returns a tagged-union outcome (no exceptions on recoverable
//     errors).
//   - Audits success and SendGrid-failure paths from inside the helper.
//   - Vendor-config errors throw — caller must surface to admin.
//
// What's different from SMS:
//   - No phone-uniqueness check (email channel uses signed link tokens
//     for inbound action, not reverse phone lookup).
//   - We sign three short-TTL link tokens (confirm/edit/stop) and embed
//     them in the rendered template.
//   - SendGrid customArgs carries conversation_id so the event-webhook
//     can correlate bounces/deliveries back to our row.

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
  renderResupplyReminder,
  signLinkToken,
} from "@workspace/resupply-messaging";

import { safeAuditFromActor } from "./safe-audit";
import type { EmailSendConfig, SendActor, SendReminderOutcome } from "./types";

export interface SendReminderEmailInput {
  supabase: ResupplySupabaseClient;
  cfg: EmailSendConfig;
  patientId: string;
  episodeId?: string;
  actor: SendActor;
}

const LINK_TOKEN_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export async function sendReminderEmail(
  input: SendReminderEmailInput,
): Promise<SendReminderOutcome> {
  const { supabase, cfg, patientId, actor } = input;

  const { data: patient, error: patientErr } = await supabase
    .schema("resupply")
    .from("patients")
    .select("id, status, email, legal_first_name")
    .eq("id", patientId)
    .limit(1)
    .maybeSingle();
  if (patientErr) throw patientErr;
  if (!patient) return { status: "patient_not_found" };
  if (patient.status !== "active") {
    return { status: "patient_not_active", patientStatus: patient.status };
  }
  if (!patient.email) return { status: "patient_missing_email" };

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
  }

  const { data: ep, error: epErr } = await supabase
    .schema("resupply")
    .from("episodes")
    .select("id, patient_id, prescription_id")
    .eq("id", episodeId)
    .limit(1)
    .maybeSingle();
  if (epErr) throw epErr;
  if (!ep) return { status: "episode_not_found" };
  if (ep.patient_id !== patientId) return { status: "episode_patient_mismatch" };

  const { data: rxRow, error: rxErr } = await supabase
    .schema("resupply")
    .from("prescriptions")
    .select("item_sku")
    .eq("id", ep.prescription_id)
    .limit(1)
    .maybeSingle();
  if (rxErr) throw rxErr;
  const itemSku = rxRow?.item_sku;
  const items: Array<{ name: string; quantity: number }> = itemSku
    ? [{ name: itemSku, quantity: 1 }]
    : [];

  const { data: insertedConv, error: insertConvErr } = await supabase
    .schema("resupply")
    .from("conversations")
    .insert({
      patient_id: patientId,
      episode_id: episodeId,
      channel: "email",
      status: "open",
      last_message_at: new Date().toISOString(),
    })
    .select("id")
    .limit(1)
    .maybeSingle();
  if (insertConvErr) throw insertConvErr;
  const conversationId = insertedConv?.id;
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
    firstName: patient.legal_first_name ?? "there",
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

  const sentAt = new Date();
  const sentAtIso = sentAt.toISOString();
  // SendGrid accepted the email. Wrap subsequent DB writes so a transient
  // DB error does NOT propagate — a propagated error causes the worker to
  // retry, which would re-call this function and send a duplicate email.
  // The vendorRef in the log is sufficient for ops to manually reconcile.
  try {
    const { error: insertMsgErr } = await supabase
      .schema("resupply")
      .from("messages")
      .insert({
        conversation_id: conversationId,
        direction: "outbound",
        sender_role: "agent",
        body: rendered.text,
        delivery_status: "queued",
        vendor_metadata: {
          sendgrid_message_id: messageId,
          subject: rendered.subject,
        } as unknown as Json,
        sent_at: sentAtIso,
      });
    if (insertMsgErr) throw insertMsgErr;
    const { error: stampConvErr } = await supabase
      .schema("resupply")
      .from("conversations")
      .update({ external_ref: messageId, updated_at: new Date().toISOString() })
      .eq("id", conversationId);
    if (stampConvErr) throw stampConvErr;
  } catch (dbErr) {
    process.stderr.write(
      JSON.stringify({
        level: 50,
        event: "send_email_db_write_failed_after_vendor_accept",
        conversationId,
        messageId,
        errName: dbErr instanceof Error ? dbErr.name : "non_error",
        errMessage: dbErr instanceof Error ? dbErr.message : String(dbErr),
        msg: "Email delivered by SendGrid but messages row not written — manual reconciliation required",
      }) + "\n",
    );
  }

  // Refresh latest-message projection (best-effort).
  await tryUpsertPatientLatestMessageSb(supabase, {
    conversationId,
    body: rendered.text,
    direction: "outbound",
    messageAt: sentAt,
  });

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
