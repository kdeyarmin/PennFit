// Shared "create + send a patient signature packet" routine.
//
// Used by both the admin on-demand route (POST /admin/patients/:id/
// packets) and the automatic send-on-delivery hook so the two paths
// can never drift. Encapsulates: resolve the patient, insert the
// packet + its document snapshot, mint the HMAC signing link, and
// (optionally) email the secure link via the shared SendGrid client.
//
// The caller owns audit logging and HTTP shaping; this helper only
// returns structured data.

import { getSupabaseServiceRoleClient } from "@workspace/resupply-db";

import { getAuthDeps } from "../auth-deps";
import { logger } from "../logger";
import { resolveCompanyProfile } from "./company";
import {
  defaultPacketDocumentKeys,
  getPacketTemplate,
  isValidPacketDocumentKey,
} from "./templates";
import { signPatientPacketToken } from "../patient-packet-token";

type SupabaseClient = ReturnType<typeof getSupabaseServiceRoleClient>;

export const DEFAULT_PACKET_TTL_DAYS = 30;

export interface CreateAndSendPatientPacketOptions {
  supabase: SupabaseClient;
  patientId: string;
  /** Defaults to the standard new-patient document set. */
  documentKeys?: string[];
  title?: string;
  /** Overrides the patient's email-on-file as the link recipient. */
  recipientEmailOverride?: string | null;
  expiresInDays?: number;
  /** Stamped onto the packet (admin email, or e.g. "system:delivery"). */
  createdByEmail?: string | null;
  /** When false, the packet is created but no email is sent (default true). */
  sendEmail?: boolean;
  /** Flavours the email subject ("Reminder: …" vs "Please review …"). */
  reminder?: boolean;
}

export type CreateAndSendPatientPacketResult =
  | {
      ok: true;
      packetId: string;
      signingLink: string;
      emailSent: boolean;
      recipientEmail: string | null;
      documentCount: number;
    }
  | { ok: false; code: "patient_not_found" }
  | { ok: false; code: "invalid_document_keys"; invalidKeys: string[] };

function signingUrl(baseUrl: string, token: string): string {
  return `${baseUrl.replace(/\/$/, "")}/patient-packet-sign?token=${encodeURIComponent(token)}`;
}

export async function createAndSendPatientPacket(
  opts: CreateAndSendPatientPacketOptions,
): Promise<CreateAndSendPatientPacketResult> {
  const { supabase, patientId } = opts;
  const ttlDays = opts.expiresInDays ?? DEFAULT_PACKET_TTL_DAYS;

  const documentKeys = opts.documentKeys ?? defaultPacketDocumentKeys();
  const invalidKeys = documentKeys.filter((k) => !isValidPacketDocumentKey(k));
  if (invalidKeys.length > 0) {
    return { ok: false, code: "invalid_document_keys", invalidKeys };
  }
  // De-dupe while preserving order.
  const uniqueKeys = Array.from(new Set(documentKeys));

  const { data: patient, error: patientErr } = await supabase
    .schema("resupply")
    .from("patients")
    .select("id, legal_first_name, legal_last_name, email")
    .eq("id", patientId)
    .limit(1)
    .maybeSingle();
  if (patientErr) throw patientErr;
  if (!patient) return { ok: false, code: "patient_not_found" };

  const recipientName =
    `${patient.legal_first_name ?? ""} ${patient.legal_last_name ?? ""}`.trim() ||
    "Patient";
  const recipientEmail =
    opts.recipientEmailOverride ?? patient.email?.toLowerCase() ?? null;
  const nowIso = new Date().toISOString();
  const expiresAt = new Date(
    Date.now() + ttlDays * 24 * 60 * 60 * 1000,
  ).toISOString();

  const { data: packet, error: insertErr } = await supabase
    .schema("resupply")
    .from("patient_packets")
    .insert({
      patient_id: patientId,
      title: opts.title ?? "New Patient Document Packet",
      status: "sent",
      recipient_name: recipientName,
      recipient_email: recipientEmail,
      link_version: 1,
      sent_at: nowIso,
      expires_at: expiresAt,
      created_by_email: opts.createdByEmail ?? null,
    })
    .select("id, link_version")
    .single();
  if (insertErr) throw insertErr;

  const docRows = uniqueKeys.map((key, i) => {
    const t = getPacketTemplate(key)!;
    return {
      packet_id: packet.id,
      document_key: key,
      title: t.title,
      content_version: t.version,
      sort_order: i,
      requires_signature: t.requiresSignature,
    };
  });
  const { error: docsErr } = await supabase
    .schema("resupply")
    .from("patient_packet_documents")
    .insert(docRows);
  if (docsErr) throw docsErr;

  const token = signPatientPacketToken(
    packet.id,
    packet.link_version,
    ttlDays * 24 * 60 * 60,
  );
  const deps = getAuthDeps();
  const link = signingUrl(deps.publicBaseUrl, token);

  let emailSent = false;
  if (recipientEmail && opts.sendEmail !== false) {
    const company = await resolveCompanyProfile(supabase);
    try {
      await deps.email({
        to: recipientEmail,
        subject: opts.reminder
          ? `Reminder: please sign your ${company.legalName} new patient documents`
          : `Please review and sign your ${company.legalName} new patient documents`,
        html: renderPacketInviteHtml(company.legalName, recipientName, link),
        text: renderPacketInviteText(company.legalName, recipientName, link),
      });
      emailSent = true;
    } catch (err) {
      logger.warn(
        {
          err: err instanceof Error ? err.message : "unknown",
          packet_id: packet.id,
        },
        "patient packet invite email failed",
      );
    }
  }

  return {
    ok: true,
    packetId: packet.id,
    signingLink: link,
    emailSent,
    recipientEmail,
    documentCount: uniqueKeys.length,
  };
}

export function renderPacketInviteHtml(
  company: string,
  recipientName: string,
  link: string,
): string {
  const safeName = escapeHtml(recipientName);
  const safeCompany = escapeHtml(company);
  return `<!doctype html><html><body style="margin:0;background:#f1f5f9;font-family:Arial,Helvetica,sans-serif;color:#1f2937">
  <div style="max-width:560px;margin:0 auto;padding:24px">
    <div style="background:#ffffff;border-radius:16px;padding:32px;border:1px solid #e2e8f0">
      <h1 style="margin:0 0 12px;font-size:20px;color:#0f172a">${safeCompany}</h1>
      <p style="font-size:15px;line-height:1.55">Hello ${safeName},</p>
      <p style="font-size:15px;line-height:1.55">Welcome! Before we set up your therapy, please review and electronically sign your new patient documents. It only takes a few minutes on any phone, tablet, or computer.</p>
      <p style="text-align:center;margin:28px 0">
        <a href="${link}" style="display:inline-block;background:#0f172a;color:#ffffff;text-decoration:none;padding:14px 28px;border-radius:9999px;font-weight:bold;font-size:15px">Review &amp; sign my documents</a>
      </p>
      <p style="font-size:13px;color:#64748b;line-height:1.5">If the button doesn't work, copy and paste this link into your browser:<br><span style="word-break:break-all;color:#334155">${link}</span></p>
      <p style="font-size:13px;color:#64748b;line-height:1.5">This is a secure, personalized link. Please don't forward it. If you didn't expect this message, you can ignore it.</p>
    </div>
  </div></body></html>`;
}

export function renderPacketInviteText(
  company: string,
  recipientName: string,
  link: string,
): string {
  return [
    `${company}`,
    "",
    `Hello ${recipientName},`,
    "",
    "Welcome! Before we set up your therapy, please review and electronically sign your new patient documents. It only takes a few minutes on any device.",
    "",
    `Review & sign: ${link}`,
    "",
    "This is a secure, personalized link. Please don't forward it.",
  ].join("\n");
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
