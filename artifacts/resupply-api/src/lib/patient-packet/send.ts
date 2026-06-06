// Shared "create + send a patient signature packet" routine.
//
// Used by both the admin on-demand route (POST /admin/patients/:id/
// packets) and the automatic send-on-delivery hook so the two paths
// can never drift. Encapsulates: resolve the patient, insert the
// packet + its document snapshot, mint the HMAC signing link, and
// deliver the secure link over the requested channel(s) — email
// (SendGrid) and/or SMS (Twilio). Each channel degrades gracefully
// when unconfigured or when the patient has no address/number on file.
//
// The caller owns audit logging and HTTP shaping; this helper only
// returns structured data.

import {
  getSupabaseServiceRoleClient,
  type Json,
} from "@workspace/resupply-db";
import { createTwilioSmsClient } from "@workspace/resupply-telecom";

import { getAuthDeps } from "../auth-deps";
import { logger } from "../logger";
import { resolveCompanyProfile } from "./company";
import {
  PACKET_TEMPLATES,
  defaultPacketDocumentKeys,
  getPacketTemplate,
  isValidPacketDocumentKey,
  requiredPacketDocumentKeys,
  type CompanyProfile,
  type DeliveryDetails,
} from "./templates";
import { signPatientPacketToken } from "../patient-packet-token";

type SupabaseClient = ReturnType<typeof getSupabaseServiceRoleClient>;

export const DEFAULT_PACKET_TTL_DAYS = 30;

export type PacketChannel = "email" | "sms";
export const PACKET_CHANNELS: PacketChannel[] = ["email", "sms"];

export interface CreateAndSendPatientPacketOptions {
  supabase: SupabaseClient;
  patientId: string;
  /** Defaults to the standard new-patient document set. */
  documentKeys?: string[];
  title?: string;
  /** Overrides the patient's email-on-file as the link recipient. */
  recipientEmailOverride?: string | null;
  /** Overrides the patient's phone-on-file as the SMS recipient. */
  recipientPhoneOverride?: string | null;
  expiresInDays?: number;
  /** Stamped onto the packet (admin email, or e.g. "system:delivery"). */
  createdByEmail?: string | null;
  /**
   * Which channels to deliver on. When omitted, the link is sent on
   * every channel for which the patient has a contact point on file
   * (email + SMS) — maximising the chance the patient completes it.
   */
  channels?: PacketChannel[];
  /** Flavours the email subject ("Reminder: …" vs "Please review …"). */
  reminder?: boolean;
  /** Itemized Proof of Delivery snapshot stored on the packet. */
  deliveryDetails?: DeliveryDetails | null;
  /**
   * Skip the "every compliance-required document is included" guarantee.
   * Off by default so normal sends are always complete; an explicit
   * caller (e.g. a re-delivery POD-only packet) can opt out.
   */
  allowPartial?: boolean;
}

export type CreateAndSendPatientPacketResult =
  | {
      ok: true;
      packetId: string;
      signingLink: string;
      emailSent: boolean;
      smsSent: boolean;
      recipientEmail: string | null;
      recipientPhone: string | null;
      documentCount: number;
    }
  | { ok: false; code: "patient_not_found" }
  | { ok: false; code: "invalid_document_keys"; invalidKeys: string[] };

function signingUrl(baseUrl: string, token: string): string {
  return `${baseUrl.replace(/\/$/, "")}/patient-packet-sign?token=${encodeURIComponent(token)}`;
}

/**
 * Mint a fresh signing link for an existing packet (used by the resend
 * route and the reminder sweep). Pass the packet's CURRENT link_version
 * after bumping it so previously-issued links are invalidated.
 */
export function buildPacketSigningLink(
  packetId: string,
  linkVersion: number,
  ttlSeconds = DEFAULT_PACKET_TTL_DAYS * 24 * 60 * 60,
): string {
  const token = signPatientPacketToken(packetId, linkVersion, ttlSeconds);
  return signingUrl(getAuthDeps().publicBaseUrl, token);
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
  // Guarantee compliance completeness: unless the caller explicitly opts
  // out, every required document is present. Then order the final set by
  // the catalog order for a consistent packet sequence.
  const selected = new Set(documentKeys);
  if (!opts.allowPartial) {
    for (const k of requiredPacketDocumentKeys()) selected.add(k);
  }
  const uniqueKeys = PACKET_TEMPLATES.map((t) => t.key).filter((k) =>
    selected.has(k),
  );

  const { data: patient, error: patientErr } = await supabase
    .schema("resupply")
    .from("patients")
    .select("id, legal_first_name, legal_last_name, email, phone_e164")
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
  const recipientPhone =
    opts.recipientPhoneOverride ?? patient.phone_e164 ?? null;
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
      delivery_details: opts.deliveryDetails
        ? (opts.deliveryDetails as unknown as Json)
        : null,
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
  const link = signingUrl(getAuthDeps().publicBaseUrl, token);

  const { emailSent, smsSent } = await deliverPacketLink({
    supabase,
    recipientName,
    link,
    email: recipientEmail,
    phone: recipientPhone,
    channels: opts.channels ?? PACKET_CHANNELS,
    reminder: opts.reminder,
    packetId: packet.id,
  });

  return {
    ok: true,
    packetId: packet.id,
    signingLink: link,
    emailSent,
    smsSent,
    recipientEmail,
    recipientPhone,
    documentCount: uniqueKeys.length,
  };
}

export interface DeliverPacketLinkInput {
  supabase: SupabaseClient;
  recipientName: string;
  link: string;
  email: string | null;
  phone: string | null;
  /** Channels to attempt. Each is skipped when its recipient is absent. */
  channels: PacketChannel[];
  reminder?: boolean;
  /** For log correlation only. */
  packetId?: string;
}

/**
 * Delivers a packet signing link over the requested channels. Resolves
 * the company profile once and reuses it. Every channel is best-effort:
 * a missing contact point, an unconfigured vendor, or a send error
 * leaves that channel's flag false without throwing.
 */
export async function deliverPacketLink(
  input: DeliverPacketLinkInput,
): Promise<{ emailSent: boolean; smsSent: boolean }> {
  const wantEmail = input.channels.includes("email") && Boolean(input.email);
  const wantSms = input.channels.includes("sms") && Boolean(input.phone);
  if (!wantEmail && !wantSms) return { emailSent: false, smsSent: false };

  const company = await resolveCompanyProfile(input.supabase);

  let emailSent = false;
  if (wantEmail && input.email) {
    try {
      await getAuthDeps().email({
        to: input.email,
        subject: input.reminder
          ? `Reminder: please sign your ${company.legalName} new patient documents`
          : `Please review and sign your ${company.legalName} new patient documents`,
        html: renderPacketInviteHtml(
          company.legalName,
          input.recipientName,
          input.link,
        ),
        text: renderPacketInviteText(
          company.legalName,
          input.recipientName,
          input.link,
        ),
      });
      emailSent = true;
    } catch (err) {
      logger.warn(
        {
          err: err instanceof Error ? err : new Error(String(err)),
          packet_id: input.packetId,
        },
        "patient packet invite email failed",
      );
      );
    }
  }

  let smsSent = false;
  if (wantSms && input.phone) {
    smsSent = await sendPacketSms(
      company,
      input.phone,
      input.link,
      input.packetId,
    );
  }

  return { emailSent, smsSent };
}

function sendPacketSms(
  company: CompanyProfile,
  phoneE164: string,
  link: string,
  packetId?: string,
): Promise<boolean> {
  const accountSid = process.env.TWILIO_ACCOUNT_SID ?? null;
  const authToken = process.env.TWILIO_AUTH_TOKEN ?? null;
  const from = process.env.TWILIO_PHONE_NUMBER ?? null;
  const messagingServiceSid = process.env.TWILIO_MESSAGING_SERVICE_SID ?? null;
  if (!accountSid || !authToken || !(from || messagingServiceSid)) {
    // SMS not configured (dev / preview). Graceful no-op.
    return Promise.resolve(false);
  }
  const body =
    `${company.legalName}: please review & sign your new patient documents here: ${link}` +
    ` Reply STOP to opt out.`;
  const client = createTwilioSmsClient({
    accountSid,
    authToken,
    from: from ?? undefined,
    messagingServiceSid: messagingServiceSid ?? undefined,
  });
  return client
    .sendSms({ to: phoneE164, body: body.slice(0, 480) })
    .then(() => true)
    .catch((err: unknown) => {
      logger.warn(
        {
          err: err instanceof Error ? err : new Error(String(err)),
          packet_id: packetId,
        },
        "patient packet invite SMS failed",
      );
      );
      return false;
    });
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
