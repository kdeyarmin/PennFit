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
import { normalizeE164 } from "@workspace/resupply-domain";
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

export interface SendPatientPacketSuccess {
  ok: true;
  packetId: string;
  signingLink: string;
  emailSent: boolean;
  smsSent: boolean;
  recipientEmail: string | null;
  recipientPhone: string | null;
  documentCount: number;
  /** The patient chart this packet was filed under, or null if unlinked. */
  matchedPatientId: string | null;
}

export type CreateAndSendPatientPacketResult =
  | SendPatientPacketSuccess
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

  // Validate + resolve the document set before any DB work so a bad
  // request fails cheaply (this contract holds without a live client).
  const docs = resolveDocumentKeys(opts.documentKeys, opts.allowPartial);
  if (!docs.ok) {
    return {
      ok: false,
      code: "invalid_document_keys",
      invalidKeys: docs.invalidKeys,
    };
  }

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

  const built = await buildAndDeliverPacket({
    supabase,
    patientId,
    recipientName,
    recipientEmail,
    recipientPhone,
    uniqueKeys: docs.uniqueKeys,
    title: opts.title,
    channels: opts.channels,
    deliveryDetails: opts.deliveryDetails ?? null,
    expiresInDays: opts.expiresInDays,
    createdByEmail: opts.createdByEmail ?? null,
    reminder: opts.reminder,
  });
  return { ...built, matchedPatientId: patientId };
}

// ── Send to an arbitrary contact (no patient selected up front) ───
//
// A CSR can send a signature packet straight to an email address and/or
// phone number without first locating the patient. If the contact
// resolves to exactly one patient (or one portal customer linked to a
// patient), the packet is filed onto that patient's chart by setting
// patient_id; otherwise it is created unlinked but still fully signable.

export interface SendPatientPacketToContactOptions {
  supabase: SupabaseClient;
  /** Email to send to (also used to match a patient). Case-insensitive. */
  email?: string | null;
  /** Phone to text (also used to match a patient). Any common format. */
  phone?: string | null;
  /** Display name for the packet when no patient matches. */
  recipientName?: string | null;
  documentKeys?: string[];
  title?: string;
  channels?: PacketChannel[];
  expiresInDays?: number;
  createdByEmail?: string | null;
}

export type SendPatientPacketToContactResult =
  | (SendPatientPacketSuccess & {
      matchedPatientName: string | null;
      /** True when 2+ candidate patients matched, so we did NOT link. */
      matchAmbiguous: boolean;
    })
  | { ok: false; code: "no_recipient" }
  | { ok: false; code: "invalid_phone" }
  | { ok: false; code: "invalid_document_keys"; invalidKeys: string[] };

export async function createAndSendPatientPacketToContact(
  opts: SendPatientPacketToContactOptions,
): Promise<SendPatientPacketToContactResult> {
  const { supabase } = opts;
  const emailLower = opts.email?.trim().toLowerCase() || null;
  const rawPhone = opts.phone?.trim() || null;

  let phoneE164: string | null = null;
  if (rawPhone) {
    phoneE164 = normalizeE164(rawPhone);
    if (!phoneE164) return { ok: false, code: "invalid_phone" };
  }
  if (!emailLower && !phoneE164) return { ok: false, code: "no_recipient" };

  // Validate the document set before any DB work (mirrors the patient
  // path; lets the route surface a 400 without a wasted round-trip).
  const docs = resolveDocumentKeys(opts.documentKeys, undefined);
  if (!docs.ok) {
    return {
      ok: false,
      code: "invalid_document_keys",
      invalidKeys: docs.invalidKeys,
    };
  }

  const match = await resolvePatientByContact(supabase, {
    emailLower,
    phoneE164,
  });
  const matchedPatientId = match.status === "matched" ? match.patientId : null;
  const matchedPatientName = match.status === "matched" ? match.name : null;
  const recipientName =
    opts.recipientName?.trim() || matchedPatientName || "Patient";

  const built = await buildAndDeliverPacket({
    supabase,
    patientId: matchedPatientId,
    recipientName,
    recipientEmail: emailLower,
    recipientPhone: phoneE164,
    uniqueKeys: docs.uniqueKeys,
    title: opts.title,
    channels: opts.channels,
    expiresInDays: opts.expiresInDays,
    createdByEmail: opts.createdByEmail ?? null,
  });

  return {
    ...built,
    matchedPatientId,
    matchedPatientName,
    matchAmbiguous: match.status === "ambiguous",
  };
}

export type ContactPatientMatch =
  | { status: "matched"; patientId: string; name: string }
  | { status: "none" }
  | { status: "ambiguous" };

/**
 * Resolve a contact (email and/or phone) to a single patient chart.
 *
 * Matching is deliberately conservative — it NEVER links when the
 * answer is ambiguous, so a packet is never silently filed onto the
 * wrong patient's chart (cross-linking PHI). The lookups, in order:
 *
 *   1. patients.email (case-insensitive) + patients.phone_e164 (exact).
 *      A 2+ row hit on either, or a different patient on each, is
 *      ambiguous → do not link.
 *   2. Fallback when (1) finds nothing and an email was given: bridge
 *      through the portal account — shop_customers.email_lower →
 *      auth_user_id → patients.portal_auth_user_id. This catches a
 *      customer whose portal login differs from the email on their
 *      clinical record. Any non-unique hop is treated as no-match.
 */
export async function resolvePatientByContact(
  supabase: SupabaseClient,
  contact: { emailLower?: string | null; phoneE164?: string | null },
): Promise<ContactPatientMatch> {
  const candidates = new Map<string, string>(); // patientId -> display name
  let ambiguous = false;

  const ingest = (
    rows:
      | {
          id: string;
          legal_first_name: string | null;
          legal_last_name: string | null;
        }[]
      | null,
  ) => {
    if (!rows || rows.length === 0) return;
    if (rows.length > 1) {
      ambiguous = true;
      return;
    }
    const r = rows[0]!;
    const name =
      `${r.legal_first_name ?? ""} ${r.legal_last_name ?? ""}`.trim() ||
      "Patient";
    candidates.set(r.id, name);
  };

  if (contact.emailLower) {
    const { data, error } = await supabase
      .schema("resupply")
      .from("patients")
      .select("id, legal_first_name, legal_last_name")
      .ilike("email", contact.emailLower)
      .limit(2);
    if (error) throw error;
    ingest(data);
  }
  if (contact.phoneE164) {
    const { data, error } = await supabase
      .schema("resupply")
      .from("patients")
      .select("id, legal_first_name, legal_last_name")
      .eq("phone_e164", contact.phoneE164)
      .limit(2);
    if (error) throw error;
    ingest(data);
  }

  // A 2+ row hit on either contact field, or different patients on each, is
  // ambiguous — never link to avoid cross-filing PHI.
  if (ambiguous || candidates.size > 1) {
    return { status: "ambiguous" };
  }

  if (candidates.size === 1) {
    const [[patientId, name]] = candidates;

    // When both contact points are provided, only link if the same patient
    // matches both. Otherwise leave it unlinked to avoid cross-filing PHI.
    if (contact.emailLower && contact.phoneE164) {
      // Check the email bridge before committing: if the portal email resolves
      // to a different patient, the situation is ambiguous — don't link.
      const bridged = await resolvePatientViaCustomerEmail(
        supabase,
        contact.emailLower,
      );
      if (bridged && bridged.patientId !== patientId) {
        return { status: "none" };
      }

      const { data: verify, error: verifyErr } = await supabase
        .schema("resupply")
        .from("patients")
        .select("id")
        .eq("id", patientId)
        .ilike("email", contact.emailLower)
        .eq("phone_e164", contact.phoneE164)
        .limit(1)
        .maybeSingle();
      if (verifyErr) throw verifyErr;
      if (!verify) return { status: "none" };
    }

    return { status: "matched", patientId, name };
  }

  // Direct match found nothing — try the portal-customer bridge by email.
  if (contact.emailLower) {
    const bridged = await resolvePatientViaCustomerEmail(
      supabase,
      contact.emailLower,
    );
    if (bridged) return { status: "matched", ...bridged };
  }

  return { status: "none" };
}

async function resolvePatientViaCustomerEmail(
  supabase: SupabaseClient,
  emailLower: string,
): Promise<{ patientId: string; name: string } | null> {
  const { data: customers, error: custErr } = await supabase
    .schema("resupply")
    .from("shop_customers")
    .select("auth_user_id")
    .eq("email_lower", emailLower)
    .not("auth_user_id", "is", null)
    .limit(2);
  if (custErr) throw custErr;
  // Need exactly one portal account for this email to resolve safely.
  if (!customers || customers.length !== 1) return null;
  const authUserId = customers[0]!.auth_user_id;
  if (!authUserId) return null;

  const { data: patients, error: patErr } = await supabase
    .schema("resupply")
    .from("patients")
    .select("id, legal_first_name, legal_last_name")
    .eq("portal_auth_user_id", authUserId)
    .limit(2);
  if (patErr) throw patErr;
  if (!patients || patients.length !== 1) return null;
  const p = patients[0]!;
  const name =
    `${p.legal_first_name ?? ""} ${p.legal_last_name ?? ""}`.trim() ||
    "Patient";
  return { patientId: p.id, name };
}

// Validate the caller's requested document keys and expand them into
// the final, catalog-ordered list to snapshot onto the packet. Pure +
// DB-free, so both send paths can fail fast before any round-trip.
//
// Unless `allowPartial` is set, every compliance-required document is
// folded in so a normal send is always complete.
function resolveDocumentKeys(
  documentKeys: string[] | undefined,
  allowPartial: boolean | undefined,
): { ok: true; uniqueKeys: string[] } | { ok: false; invalidKeys: string[] } {
  const keys = documentKeys ?? defaultPacketDocumentKeys();
  const invalidKeys = keys.filter((k) => !isValidPacketDocumentKey(k));
  if (invalidKeys.length > 0) return { ok: false, invalidKeys };
  const selected = new Set(keys);
  if (!allowPartial) {
    for (const k of requiredPacketDocumentKeys()) selected.add(k);
  }
  const uniqueKeys = PACKET_TEMPLATES.map((t) => t.key).filter((k) =>
    selected.has(k),
  );
  return { ok: true, uniqueKeys };
}

// ── Shared packet builder ─────────────────────────────────────────
//
// The common tail of both send paths: insert the packet + its document
// snapshot, mint the HMAC signing link, and deliver it over the
// requested channels. `patientId` is null for an unlinked contact send.
// `uniqueKeys` must already be validated + ordered (resolveDocumentKeys).

interface BuildAndDeliverPacketInput {
  supabase: SupabaseClient;
  patientId: string | null;
  recipientName: string;
  recipientEmail: string | null;
  recipientPhone: string | null;
  uniqueKeys: string[];
  title?: string;
  channels?: PacketChannel[];
  deliveryDetails?: DeliveryDetails | null;
  expiresInDays?: number;
  createdByEmail?: string | null;
  reminder?: boolean;
}

interface BuildAndDeliverPacketResult {
  ok: true;
  packetId: string;
  signingLink: string;
  emailSent: boolean;
  smsSent: boolean;
  recipientEmail: string | null;
  recipientPhone: string | null;
  documentCount: number;
}

async function buildAndDeliverPacket(
  input: BuildAndDeliverPacketInput,
): Promise<BuildAndDeliverPacketResult> {
  const { supabase, uniqueKeys } = input;
  const ttlDays = input.expiresInDays ?? DEFAULT_PACKET_TTL_DAYS;

  const nowIso = new Date().toISOString();
  const expiresAt = new Date(
    Date.now() + ttlDays * 24 * 60 * 60 * 1000,
  ).toISOString();

  const { data: packet, error: insertErr } = await supabase
    .schema("resupply")
    .from("patient_packets")
    .insert({
      patient_id: input.patientId,
      title: input.title ?? "New Patient Document Packet",
      status: "sent",
      recipient_name: input.recipientName,
      recipient_email: input.recipientEmail,
      recipient_phone: input.recipientPhone,
      link_version: 1,
      sent_at: nowIso,
      expires_at: expiresAt,
      created_by_email: input.createdByEmail ?? null,
      delivery_details: input.deliveryDetails
        ? (input.deliveryDetails as unknown as Json)
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
    recipientName: input.recipientName,
    link,
    email: input.recipientEmail,
    phone: input.recipientPhone,
    channels: input.channels ?? PACKET_CHANNELS,
    reminder: input.reminder,
    packetId: packet.id,
  });

  return {
    ok: true,
    packetId: packet.id,
    signingLink: link,
    emailSent,
    smsSent,
    recipientEmail: input.recipientEmail,
    recipientPhone: input.recipientPhone,
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
