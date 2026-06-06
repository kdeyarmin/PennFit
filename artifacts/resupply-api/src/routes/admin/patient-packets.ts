// Patient signature packets — admin endpoints.
//
//   GET  /admin/patient-packet-templates            — the document catalog
//   GET  /admin/patient-packets                      — recent packets (all patients)
//   GET  /admin/patients/:id/packets                 — a patient's packets
//   POST /admin/patients/:id/packets                 — create + send a packet
//   GET  /admin/packets/:packetId                    — packet detail
//   POST /admin/packets/:packetId/resend             — reissue link + resend email
//   POST /admin/packets/:packetId/void               — void a packet
//   GET  /admin/packets/:packetId/pdf                — download the signed PDF
//
// Permission posture mirrors documentation-packets: reads require
// `patients.read`, mutations require `patients.update`. The signing
// link is an HMAC token (RESUPPLY_LINK_HMAC_KEY) — see
// lib/patient-packet-token.ts.

import { Router, type IRouter } from "express";
import { z } from "zod";

import { logAudit } from "@workspace/resupply-audit";
import { getSupabaseServiceRoleClient } from "@workspace/resupply-db";

import { getAuthDeps } from "../../lib/auth-deps";
import { logger } from "../../lib/logger";
import { resolveCompanyProfile } from "../../lib/patient-packet/company";
import {
  renderPatientPacketPdf,
  type PacketPdfInput,
} from "../../lib/patient-packet/packet-pdf";
import {
  createAndSendPatientPacket,
  deliverPacketLink,
  PACKET_CHANNELS,
} from "../../lib/patient-packet/send";
import {
  PACKET_TEMPLATES,
  isRequiredPacketDocumentKey,
} from "../../lib/patient-packet/templates";
import { signPatientPacketToken } from "../../lib/patient-packet-token";
import {
  adminRateLimit,
  adminReadRateLimiter,
} from "../../middlewares/admin-rate-limit";
import { requirePermission } from "../../middlewares/requireAdmin";

const router: IRouter = Router();

const idParam = z.object({ id: z.string().uuid() });
const packetIdParam = z.object({ packetId: z.string().uuid() });

const DEFAULT_TTL_DAYS = 30;

const channelsSchema = z
  .array(z.enum(["email", "sms"]))
  .min(1)
  .max(2)
  .optional();

const deliveryItemSchema = z
  .object({
    description: z.string().trim().min(1).max(200),
    hcpcs: z.string().trim().max(16).optional().nullable(),
    quantity: z.number().int().min(1).max(999).optional().nullable(),
  })
  .strict();

const deliveryDetailsSchema = z
  .object({
    items: z.array(deliveryItemSchema).max(40).optional(),
    deliveryDate: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/u)
      .optional()
      .nullable(),
    deliveryAddress: z.string().trim().max(300).optional().nullable(),
    orderRef: z.string().trim().max(120).optional().nullable(),
  })
  .strict();

const createBody = z
  .object({
    documentKeys: z.array(z.string().min(1).max(64)).min(1).max(20).optional(),
    title: z.string().trim().min(1).max(160).optional(),
    recipientEmail: z
      .string()
      .trim()
      .toLowerCase()
      .email()
      .optional()
      .nullable(),
    recipientPhone: z
      .string()
      .trim()
      .regex(/^\+1\d{10}$/, "Must be E.164, e.g. +12155551234")
      .optional()
      .nullable(),
    // Which channels to deliver the signing link on. Omitted = every
    // channel the patient has a contact point for (email + SMS).
    channels: channelsSchema,
    // Itemized Proof of Delivery snapshot (CMS-compliant POD).
    deliveryDetails: deliveryDetailsSchema.optional().nullable(),
    expiresInDays: z.number().int().min(1).max(90).optional(),
  })
  .strict();

const resendBody = z.object({ channels: channelsSchema }).strict();

function signingUrl(baseUrl: string, token: string): string {
  return `${baseUrl.replace(/\/$/, "")}/patient-packet-sign?token=${encodeURIComponent(token)}`;
}

// ── Document catalog ──────────────────────────────────────────────
router.get(
  "/admin/patient-packet-templates",
  adminReadRateLimiter,
  requirePermission("patients.read"),
  (_req, res) => {
    res.json({
      templates: PACKET_TEMPLATES.map((t) => ({
        key: t.key,
        title: t.title,
        category: t.category,
        version: t.version,
        summary: t.summary,
        requiresSignature: t.requiresSignature,
        defaultIncluded: t.defaultIncluded,
        required: isRequiredPacketDocumentKey(t.key),
      })),
    });
  },
);

// ── Recent packets across all patients ────────────────────────────
router.get(
  "/admin/patient-packets",
  adminReadRateLimiter,
  requirePermission("patients.read"),
  async (req, res) => {
    const status =
      typeof req.query.status === "string" ? req.query.status : null;
    const supabase = getSupabaseServiceRoleClient();
    let query = supabase
      .schema("resupply")
      .from("patient_packets")
      .select(
        "id, patient_id, title, status, recipient_name, recipient_email, sent_at, completed_at, expires_at, created_at",
      )
      .order("created_at", { ascending: false })
      .limit(100);
    if (
      status &&
      ["draft", "sent", "viewed", "completed", "voided", "expired"].includes(
        status,
      )
    ) {
      query = query.eq("status", status);
    }
    const { data, error } = await query;
    if (error) throw error;
    res.json({ packets: data ?? [] });
  },
);

// ── A patient's packets ───────────────────────────────────────────
router.get(
  "/admin/patients/:id/packets",
  adminReadRateLimiter,
  requirePermission("patients.read"),
  async (req, res) => {
    const parsed = idParam.safeParse(req.params);
    if (!parsed.success) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    const supabase = getSupabaseServiceRoleClient();
    const { data, error } = await supabase
      .schema("resupply")
      .from("patient_packets")
      .select(
        "id, patient_id, title, status, recipient_name, recipient_email, sent_at, completed_at, expires_at, created_at",
      )
      .eq("patient_id", parsed.data.id)
      .order("created_at", { ascending: false })
      .limit(50);
    if (error) throw error;
    res.json({ packets: data ?? [] });
  },
);

// ── Create + send a packet ────────────────────────────────────────
router.post(
  "/admin/patients/:id/packets",
  requirePermission("patients.update"),
  adminRateLimit({ name: "patient_packets.create", preset: "sensitive" }),
  async (req, res) => {
    const idParsed = idParam.safeParse(req.params);
    if (!idParsed.success) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    const parsed = createBody.safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(400).json({
        error: "invalid_body",
        issues: parsed.error.issues.map((i) => ({
          path: i.path.join("."),
          message: i.message,
        })),
      });
      return;
    }
    const b = parsed.data;

    const supabase = getSupabaseServiceRoleClient();
    const result = await createAndSendPatientPacket({
      supabase,
      patientId: idParsed.data.id,
      documentKeys: b.documentKeys,
      title: b.title,
      recipientEmailOverride: b.recipientEmail,
      recipientPhoneOverride: b.recipientPhone,
      channels: b.channels,
      deliveryDetails: b.deliveryDetails ?? null,
      expiresInDays: b.expiresInDays,
      createdByEmail: req.adminEmail ?? null,
    });
    if (!result.ok) {
      if (result.code === "invalid_document_keys") {
        res.status(400).json({
          error: "invalid_document_keys",
          invalidKeys: result.invalidKeys,
        });
        return;
      }
      res.status(404).json({ error: "patient_not_found" });
      return;
    }

    await logAudit({
      action: "patient_packet.sent",
      adminEmail: req.adminEmail ?? null,
      adminUserId: req.adminUserId ?? null,
      targetTable: "patient_packets",
      targetId: result.packetId,
      metadata: {
        patient_id: idParsed.data.id,
        document_count: result.documentCount,
        email_sent: result.emailSent,
        sms_sent: result.smsSent,
      },
      ip: req.ip ?? null,
      userAgent: req.get("user-agent") ?? null,
    }).catch((err) => {
      logger.warn({ err }, "patient_packet.sent audit write failed");
    });

    res.status(201).json({
      id: result.packetId,
      status: "sent",
      emailSent: result.emailSent,
      smsSent: result.smsSent,
      // Always returned so the CSR can deliver it by hand if needed.
      signingLink: result.signingLink,
    });
  },
);

// ── Packet detail ─────────────────────────────────────────────────
router.get(
  "/admin/packets/:packetId",
  adminReadRateLimiter,
  requirePermission("patients.read"),
  async (req, res) => {
    const parsed = packetIdParam.safeParse(req.params);
    if (!parsed.success) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    const supabase = getSupabaseServiceRoleClient();
    const { data: packet, error } = await supabase
      .schema("resupply")
      .from("patient_packets")
      .select("*")
      .eq("id", parsed.data.packetId)
      .limit(1)
      .maybeSingle();
    if (error) throw error;
    if (!packet) {
      res.status(404).json({ error: "not_found" });
      return;
    }

    const [docsRes, sigRes] = await Promise.all([
      supabase
        .schema("resupply")
        .from("patient_packet_documents")
        .select("*")
        .eq("packet_id", packet.id)
        .order("sort_order", { ascending: true }),
      supabase
        .schema("resupply")
        .from("patient_packet_signatures")
        .select(
          "id, signer_name, signer_relationship, consent_esign, acknowledged_document_keys, signed_at, signer_ip, created_at",
        )
        .eq("packet_id", packet.id)
        .order("signed_at", { ascending: false })
        .limit(1)
        .maybeSingle(),
    ]);
    if (docsRes.error) throw docsRes.error;
    if (sigRes.error) throw sigRes.error;

    // A live signing link (only meaningful while the packet is open).
    let signingLink: string | null = null;
    if (packet.status === "sent" || packet.status === "viewed") {
      const token = signPatientPacketToken(packet.id, packet.link_version);
      signingLink = signingUrl(getAuthDeps().publicBaseUrl, token);
    }

    res.json({
      packet,
      documents: docsRes.data ?? [],
      signature: sigRes.data ?? null,
      signingLink,
    });
  },
);

// ── Reissue link + resend email ───────────────────────────────────
router.post(
  "/admin/packets/:packetId/resend",
  requirePermission("patients.update"),
  adminRateLimit({ name: "patient_packets.resend", preset: "sensitive" }),
  async (req, res) => {
    const parsed = packetIdParam.safeParse(req.params);
    if (!parsed.success) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    const bodyParsed = resendBody.safeParse(req.body ?? {});
    if (!bodyParsed.success) {
      res.status(400).json({ error: "invalid_body" });
      return;
    }

    const supabase = getSupabaseServiceRoleClient();
    const { data: packet, error } = await supabase
      .schema("resupply")
      .from("patient_packets")
      .select(
        "id, patient_id, status, link_version, recipient_name, recipient_email, expires_at",
      )
      .eq("id", parsed.data.packetId)
      .limit(1)
      .maybeSingle();
    if (error) throw error;
    if (!packet) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    if (packet.status === "completed" || packet.status === "voided") {
      res.status(409).json({ error: "packet_closed", status: packet.status });
      return;
    }

    // Bump link_version to invalidate any previously issued link.
    const nextVersion = (packet.link_version ?? 1) + 1;
    const nowIso = new Date().toISOString();
    const newExpiry = new Date(
      Date.now() + DEFAULT_TTL_DAYS * 24 * 60 * 60 * 1000,
    ).toISOString();
    const { error: updErr } = await supabase
      .schema("resupply")
      .from("patient_packets")
      .update({
        link_version: nextVersion,
        status: "sent",
        sent_at: nowIso,
        expires_at: newExpiry,
        updated_at: nowIso,
      })
      .eq("id", packet.id);
    if (updErr) throw updErr;

    // Pull the patient's phone so SMS resend works (the packet row only
    // snapshots the email recipient).
    const { data: patient } = await supabase
      .schema("resupply")
      .from("patients")
      .select("phone_e164")
      .eq("id", packet.patient_id)
      .limit(1)
      .maybeSingle();

    const token = signPatientPacketToken(packet.id, nextVersion);
    const link = signingUrl(getAuthDeps().publicBaseUrl, token);

    const { emailSent, smsSent } = await deliverPacketLink({
      supabase,
      recipientName: packet.recipient_name,
      link,
      email: packet.recipient_email,
      phone: patient?.phone_e164 ?? null,
      channels: bodyParsed.data.channels ?? PACKET_CHANNELS,
      reminder: true,
      packetId: packet.id,
    });

    await logAudit({
      action: "patient_packet.resent",
      adminEmail: req.adminEmail ?? null,
      adminUserId: req.adminUserId ?? null,
      targetTable: "patient_packets",
      targetId: packet.id,
      metadata: {
        email_sent: emailSent,
        sms_sent: smsSent,
        link_version: nextVersion,
      },
      ip: req.ip ?? null,
      userAgent: req.get("user-agent") ?? null,
    }).catch((err) => {
      logger.warn({ err }, "patient_packet.resent audit write failed");
    });

    res.json({ status: "sent", emailSent, smsSent, signingLink: link });
  },
);

// ── Void a packet ─────────────────────────────────────────────────
const voidBody = z
  .object({ reason: z.string().trim().max(500).optional() })
  .strict();

router.post(
  "/admin/packets/:packetId/void",
  requirePermission("patients.update"),
  adminRateLimit({ name: "patient_packets.void", preset: "destroy" }),
  async (req, res) => {
    const parsed = packetIdParam.safeParse(req.params);
    if (!parsed.success) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    const bodyParsed = voidBody.safeParse(req.body ?? {});
    if (!bodyParsed.success) {
      res.status(400).json({ error: "invalid_body" });
      return;
    }
    const supabase = getSupabaseServiceRoleClient();
    const { data: packet, error } = await supabase
      .schema("resupply")
      .from("patient_packets")
      .select("id, status")
      .eq("id", parsed.data.packetId)
      .limit(1)
      .maybeSingle();
    if (error) throw error;
    if (!packet) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    if (packet.status === "completed") {
      res.status(409).json({ error: "already_completed" });
      return;
    }
    const nowIso = new Date().toISOString();
    const { error: updErr } = await supabase
      .schema("resupply")
      .from("patient_packets")
      .update({
        status: "voided",
        voided_at: nowIso,
        voided_reason: bodyParsed.data.reason ?? null,
        // Invalidate any outstanding link.
        link_version: 999_999,
        updated_at: nowIso,
      })
      .eq("id", packet.id);
    if (updErr) throw updErr;

    await logAudit({
      action: "patient_packet.voided",
      adminEmail: req.adminEmail ?? null,
      adminUserId: req.adminUserId ?? null,
      targetTable: "patient_packets",
      targetId: packet.id,
      metadata: { reason: bodyParsed.data.reason ?? null },
      ip: req.ip ?? null,
      userAgent: req.get("user-agent") ?? null,
    }).catch((err) => {
      logger.warn({ err }, "patient_packet.voided audit write failed");
    });

    res.json({ status: "voided" });
  },
);

// ── Download the signed PDF ───────────────────────────────────────
router.get(
  "/admin/packets/:packetId/pdf",
  adminReadRateLimiter,
  requirePermission("patients.read"),
  async (req, res) => {
    const parsed = packetIdParam.safeParse(req.params);
    if (!parsed.success) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    const supabase = getSupabaseServiceRoleClient();
    const { data: packet, error } = await supabase
      .schema("resupply")
      .from("patient_packets")
      .select(
        "id, patient_id, title, status, recipient_name, sent_at, completed_at, delivery_details",
      )
      .eq("id", parsed.data.packetId)
      .limit(1)
      .maybeSingle();
    if (error) throw error;
    if (!packet) {
      res.status(404).json({ error: "not_found" });
      return;
    }

    const [docsRes, sigRes, company] = await Promise.all([
      supabase
        .schema("resupply")
        .from("patient_packet_documents")
        .select(
          "document_key, title, requires_signature, content_version, sort_order",
        )
        .eq("packet_id", packet.id)
        .order("sort_order", { ascending: true }),
      supabase
        .schema("resupply")
        .from("patient_packet_signatures")
        .select("*")
        .eq("packet_id", packet.id)
        .order("signed_at", { ascending: false })
        .limit(1)
        .maybeSingle(),
      resolveCompanyProfile(supabase),
    ]);
    if (docsRes.error) throw docsRes.error;
    if (sigRes.error) throw sigRes.error;

    const sig = sigRes.data;
    const { pdf } = await renderPatientPacketPdf({
      packetId: packet.id,
      title: packet.title,
      company,
      patient: { name: packet.recipient_name },
      status: packet.status,
      sentAt: packet.sent_at,
      completedAt: packet.completed_at,
      documents: (docsRes.data ?? []).map((d) => ({
        documentKey: d.document_key,
        title: d.title,
        requiresSignature: d.requires_signature,
        contentVersion: d.content_version,
      })),
      deliveryDetails: (packet.delivery_details ??
        null) as PacketPdfInput["deliveryDetails"],
      signature: sig
        ? {
            signerName: sig.signer_name,
            signerRelationship: sig.signer_relationship,
            signatureImage: sig.signature_image,
            consentEsign: sig.consent_esign,
            signedAt: sig.signed_at,
            signerIp: sig.signer_ip,
            signerUserAgent: sig.signer_user_agent,
            signerReason: sig.signer_reason,
            dateReceived: sig.date_received,
          }
        : null,
    });

    res.setHeader("Content-Type", "application/pdf");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="patient-packet-${packet.id.slice(0, 8)}.pdf"`,
    );
    res.setHeader("Cache-Control", "no-store");
    res.status(200).end(pdf);
  },
);

export default router;
