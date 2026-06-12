// /admin/manual-document-packets — bundle manual documents into a packet.
//
// A packet is an ordered set of staff-authored manual documents (see
// routes/admin/manual-documents.ts) rendered as ONE combined PDF —
// optional generated cover sheet, then each document starting on a
// fresh page — and sent as a single email attachment or fax
// transmission. Member documents stay independently editable and
// sendable; the packet only references them by id.
//
//   GET    /admin/manual-document-packets            — list (?status)
//   POST   /admin/manual-document-packets            — create a draft
//   GET    /admin/manual-document-packets/:id        — detail (+ members)
//   PATCH  /admin/manual-document-packets/:id        — edit
//   DELETE /admin/manual-document-packets/:id        — delete (docs survive)
//   GET    /admin/manual-document-packets/:id/pdf    — combined PDF
//   POST   /admin/manual-document-packets/:id/send-email — email the PDF
//   POST   /admin/manual-document-packets/:id/send-fax   — fax the PDF
//
// Sending a packet also stamps each member document sent (and its
// signature tracking) — a CMN faxed inside a packet IS sent, and must
// show that way in the outstanding-signatures dashboard.
//
// Permission posture mirrors manual-documents: reads require
// `patients.read`, mutations require `patients.update`.
//
// PHI / log posture: member content + recipient contact are PHI. Audit
// envelopes carry ids + counts + flags only — never titles, recipient,
// or PDF bytes.

import { Router, type IRouter } from "express";
import { z } from "zod";

import { logAudit } from "@workspace/resupply-audit";
import {
  getSupabaseServiceRoleClient,
  type Json,
} from "@workspace/resupply-db";
import { createSendgridClient } from "@workspace/resupply-email";
import {
  createTelnyxFaxClient,
  TelnyxApiError,
} from "@workspace/resupply-telecom";

import { signManualDocumentPacketFaxToken } from "../../lib/fax-document-token.js";
import { logger } from "../../lib/logger.js";
import { getManualDocumentTypeDef } from "../../lib/manual-documents/catalog.js";
import {
  loadManualDocumentPacketRow,
  loadPacketDocuments,
  MANUAL_DOCUMENT_PACKET_ROW_COLUMNS,
  renderManualDocumentPacketToPdf,
  type ManualDocumentPacketRow,
} from "../../lib/manual-documents/packet-service.js";
import {
  manualDocumentSupplierName,
  type ManualDocumentRow,
} from "../../lib/manual-documents/service.js";
import { recordTrackingSent } from "../../lib/signature-tracking/service.js";
import {
  adminRateLimit,
  adminReadRateLimiter,
} from "../../middlewares/admin-rate-limit.js";
import { requirePermission } from "../../middlewares/requireAdmin.js";
import {
  getFaxPublicBaseUrl,
  isFaxConfigured,
} from "./physician-fax-outreach.js";

const router: IRouter = Router();

const E164 = /^\+[1-9]\d{6,14}$/;
const MAX_PACKET_DOCUMENTS = 25;

const idParam = z.object({ id: z.string().uuid() });

const documentIdsSchema = z
  .array(z.string().uuid())
  .min(1, "A packet needs at least one document.")
  .max(MAX_PACKET_DOCUMENTS);

const recipientSchema = {
  recipientName: z.string().trim().max(200).nullable().optional(),
  recipientAddress: z.string().trim().max(500).nullable().optional(),
  recipientEmail: z.string().trim().toLowerCase().email().nullable().optional(),
  recipientFaxE164: z
    .string()
    .trim()
    .regex(E164, "Fax must be E.164, e.g. +12155551234")
    .nullable()
    .optional(),
};

const createBody = z
  .object({
    title: z.string().trim().min(1).max(200),
    documentIds: documentIdsSchema,
    includeCoverSheet: z.boolean().optional(),
    ...recipientSchema,
  })
  .strict();

const updateBody = z
  .object({
    title: z.string().trim().min(1).max(200).optional(),
    documentIds: documentIdsSchema.optional(),
    includeCoverSheet: z.boolean().optional(),
    ...recipientSchema,
  })
  .strict()
  .refine((b) => Object.keys(b).length > 0, {
    message: "Provide at least one field to update.",
  });

const listQuery = z
  .object({ status: z.enum(["draft", "sent"]).optional() })
  .strict();

const sendEmailBody = z
  .object({
    email: z.string().trim().toLowerCase().email().optional(),
  })
  .strict();

const sendFaxBody = z
  .object({
    fax: z.string().trim().regex(E164, "Fax must be E.164").optional(),
  })
  .strict();

function invalidBody(res: import("express").Response, parsed: z.ZodError) {
  res.status(400).json({
    error: "invalid_body",
    issues: parsed.issues.map((i) => ({
      path: i.path.join("."),
      message: i.message,
    })),
  });
}

/** Dedupe while preserving the author's ordering. */
function dedupeIds(ids: string[]): string[] {
  return [...new Set(ids)];
}

/** Verify every id has a manual_documents row; returns the missing ids. */
async function findMissingDocumentIds(
  supabase: ReturnType<typeof getSupabaseServiceRoleClient>,
  ids: string[],
): Promise<string[]> {
  const { data, error } = await supabase
    .schema("resupply")
    .from("manual_documents")
    .select("id")
    .in("id", ids);
  if (error) throw error;
  const found = new Set((data ?? []).map((r) => r.id));
  return ids.filter((id) => !found.has(id));
}

/**
 * After a packet email/fax goes out, stamp each member document sent and
 * record signature tracking — a document sent inside a packet IS sent.
 * Best-effort: the transmission already happened, so failures log and
 * never 500 (a retry would re-send the packet).
 */
async function stampMemberDocumentsSent(
  supabase: ReturnType<typeof getSupabaseServiceRoleClient>,
  documents: ManualDocumentRow[],
  channel: "email" | "fax",
  nowIso: string,
): Promise<void> {
  const ids = documents.map((d) => d.id);
  const stamp =
    channel === "email"
      ? { last_emailed_at: nowIso }
      : { last_faxed_at: nowIso };
  const { error: stampErr } = await supabase
    .schema("resupply")
    .from("manual_documents")
    .update({ ...stamp, updated_at: nowIso })
    .in("id", ids);
  if (stampErr) {
    logger.warn(
      { err: stampErr },
      "manual_document_packet member stamp failed",
    );
  }
  // Status advances draft → sent; an attached document stays attached.
  const { error: statusErr } = await supabase
    .schema("resupply")
    .from("manual_documents")
    .update({ status: "sent", updated_at: nowIso })
    .in("id", ids)
    .eq("status", "draft");
  if (statusErr) {
    logger.warn(
      { err: statusErr },
      "manual_document_packet member status failed",
    );
  }
  for (const docRow of documents) {
    if (!getManualDocumentTypeDef(docRow.document_type).requiresSignature) {
      continue;
    }
    await recordTrackingSent(
      supabase,
      "manual_document",
      docRow.id,
      channel,
    ).catch((err) =>
      logger.warn({ err }, "manual_document_packet tracking_sent failed"),
    );
  }
}

/** Load packet + members; handles the shared 404/409 plumbing for the
 *  pdf/send routes. Returns null after responding on any failure. */
async function loadPacketForRender(
  supabase: ReturnType<typeof getSupabaseServiceRoleClient>,
  id: string,
  res: import("express").Response,
): Promise<{
  packet: ManualDocumentPacketRow;
  documents: ManualDocumentRow[];
} | null> {
  const packet = await loadManualDocumentPacketRow(supabase, id);
  if (!packet) {
    res.status(404).json({ error: "not_found" });
    return null;
  }
  const { documents, missingIds } = await loadPacketDocuments(supabase, packet);
  if (missingIds.length > 0 || documents.length === 0) {
    res.status(409).json({
      error: "packet_documents_missing",
      missingIds,
    });
    return null;
  }
  return { packet, documents };
}

// ── List ───────────────────────────────────────────────────────────
router.get(
  "/admin/manual-document-packets",
  adminReadRateLimiter,
  requirePermission("patients.read"),
  async (req, res) => {
    const parsed = listQuery.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json({ error: "invalid_query" });
      return;
    }
    const supabase = getSupabaseServiceRoleClient();
    let query = supabase
      .schema("resupply")
      .from("manual_document_packets")
      .select(MANUAL_DOCUMENT_PACKET_ROW_COLUMNS)
      .order("created_at", { ascending: false })
      .limit(100);
    if (parsed.data.status) {
      query = query.eq("status", parsed.data.status);
    }
    const { data, error } = await query;
    if (error) throw error;
    res.json({ packets: data ?? [] });
  },
);

// ── Create ─────────────────────────────────────────────────────────
router.post(
  "/admin/manual-document-packets",
  requirePermission("patients.update"),
  adminRateLimit({
    name: "manual_document_packets.create",
    preset: "sensitive",
  }),
  async (req, res) => {
    const parsed = createBody.safeParse(req.body ?? {});
    if (!parsed.success) {
      invalidBody(res, parsed.error);
      return;
    }
    const b = parsed.data;
    const documentIds = dedupeIds(b.documentIds);

    const supabase = getSupabaseServiceRoleClient();
    const missing = await findMissingDocumentIds(supabase, documentIds);
    if (missing.length > 0) {
      res
        .status(400)
        .json({ error: "documents_not_found", missingIds: missing });
      return;
    }

    const nowIso = new Date().toISOString();
    const { data: inserted, error } = await supabase
      .schema("resupply")
      .from("manual_document_packets")
      .insert({
        title: b.title,
        document_ids: documentIds as unknown as Json,
        include_cover_sheet: b.includeCoverSheet ?? true,
        recipient_name: b.recipientName ?? null,
        recipient_address: b.recipientAddress ?? null,
        recipient_email: b.recipientEmail ?? null,
        recipient_fax_e164: b.recipientFaxE164 ?? null,
        status: "draft",
        created_by_email: req.adminEmail ?? null,
        created_at: nowIso,
        updated_at: nowIso,
      })
      .select("id")
      .limit(1)
      .maybeSingle();
    if (error) throw error;
    if (!inserted) {
      throw new Error("manual_document_packets insert returned no rows");
    }

    await logAudit({
      action: "manual_document_packet.created",
      adminEmail: req.adminEmail ?? null,
      adminUserId: req.adminUserId ?? null,
      targetTable: "manual_document_packets",
      targetId: inserted.id,
      metadata: { document_count: documentIds.length },
      ip: req.ip ?? null,
      userAgent: req.get("user-agent") ?? null,
    }).catch((err) => {
      logger.warn({ err }, "manual_document_packet.created audit write failed");
    });

    res.status(201).json({ id: inserted.id, status: "draft" });
  },
);

// ── Detail ─────────────────────────────────────────────────────────
router.get(
  "/admin/manual-document-packets/:id",
  adminReadRateLimiter,
  requirePermission("patients.read"),
  async (req, res) => {
    const parsed = idParam.safeParse(req.params);
    if (!parsed.success) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    const supabase = getSupabaseServiceRoleClient();
    const packet = await loadManualDocumentPacketRow(supabase, parsed.data.id);
    if (!packet) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    const { documents, missingIds } = await loadPacketDocuments(
      supabase,
      packet,
    );
    res.json({
      packet,
      documents: documents.map((d) => ({
        id: d.id,
        document_type: d.document_type,
        title: d.title,
        status: d.status,
      })),
      missingDocumentIds: missingIds,
    });
  },
);

// ── Edit ───────────────────────────────────────────────────────────
router.patch(
  "/admin/manual-document-packets/:id",
  requirePermission("patients.update"),
  adminRateLimit({
    name: "manual_document_packets.update",
    preset: "sensitive",
  }),
  async (req, res) => {
    const idParsed = idParam.safeParse(req.params);
    if (!idParsed.success) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    const parsed = updateBody.safeParse(req.body ?? {});
    if (!parsed.success) {
      invalidBody(res, parsed.error);
      return;
    }
    const b = parsed.data;

    const supabase = getSupabaseServiceRoleClient();
    const existing = await loadManualDocumentPacketRow(
      supabase,
      idParsed.data.id,
    );
    if (!existing) {
      res.status(404).json({ error: "not_found" });
      return;
    }

    const patch: Record<string, unknown> = {
      updated_at: new Date().toISOString(),
    };
    if (b.title !== undefined) patch.title = b.title;
    if (b.includeCoverSheet !== undefined) {
      patch.include_cover_sheet = b.includeCoverSheet;
    }
    if (b.documentIds !== undefined) {
      const documentIds = dedupeIds(b.documentIds);
      const missing = await findMissingDocumentIds(supabase, documentIds);
      if (missing.length > 0) {
        res
          .status(400)
          .json({ error: "documents_not_found", missingIds: missing });
        return;
      }
      patch.document_ids = documentIds as unknown as Json;
    }
    if (b.recipientName !== undefined) patch.recipient_name = b.recipientName;
    if (b.recipientAddress !== undefined) {
      patch.recipient_address = b.recipientAddress;
    }
    if (b.recipientEmail !== undefined) {
      patch.recipient_email = b.recipientEmail;
    }
    if (b.recipientFaxE164 !== undefined) {
      patch.recipient_fax_e164 = b.recipientFaxE164;
    }

    const { error: updErr } = await supabase
      .schema("resupply")
      .from("manual_document_packets")
      .update(patch)
      .eq("id", idParsed.data.id);
    if (updErr) throw updErr;

    await logAudit({
      action: "manual_document_packet.updated",
      adminEmail: req.adminEmail ?? null,
      adminUserId: req.adminUserId ?? null,
      targetTable: "manual_document_packets",
      targetId: idParsed.data.id,
      metadata: {
        documents_changed: b.documentIds !== undefined,
        title_changed: b.title !== undefined,
      },
      ip: req.ip ?? null,
      userAgent: req.get("user-agent") ?? null,
    }).catch((err) => {
      logger.warn({ err }, "manual_document_packet.updated audit write failed");
    });

    res.json({ ok: true });
  },
);

// ── Delete ─────────────────────────────────────────────────────────
router.delete(
  "/admin/manual-document-packets/:id",
  requirePermission("patients.update"),
  adminRateLimit({
    name: "manual_document_packets.delete",
    preset: "destroy",
  }),
  async (req, res) => {
    const parsed = idParam.safeParse(req.params);
    if (!parsed.success) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    const supabase = getSupabaseServiceRoleClient();
    const { error } = await supabase
      .schema("resupply")
      .from("manual_document_packets")
      .delete()
      .eq("id", parsed.data.id);
    if (error) throw error;

    await logAudit({
      action: "manual_document_packet.deleted",
      adminEmail: req.adminEmail ?? null,
      adminUserId: req.adminUserId ?? null,
      targetTable: "manual_document_packets",
      targetId: parsed.data.id,
      metadata: {},
      ip: req.ip ?? null,
      userAgent: req.get("user-agent") ?? null,
    }).catch((err) => {
      logger.warn({ err }, "manual_document_packet.deleted audit write failed");
    });

    res.json({ ok: true }); // idempotent
  },
);

// ── Render + download combined PDF ─────────────────────────────────
router.get(
  "/admin/manual-document-packets/:id/pdf",
  adminReadRateLimiter,
  requirePermission("patients.read"),
  async (req, res) => {
    const parsed = idParam.safeParse(req.params);
    if (!parsed.success) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    const supabase = getSupabaseServiceRoleClient();
    const loaded = await loadPacketForRender(supabase, parsed.data.id, res);
    if (!loaded) return;
    let pdf: Buffer;
    try {
      pdf = await renderManualDocumentPacketToPdf(
        supabase,
        loaded.packet,
        loaded.documents,
      );
    } catch (err) {
      logger.warn({ err }, "manual_document_packet.pdf render failed");
      res.status(500).json({ error: "render_failed" });
      return;
    }

    await logAudit({
      action: "manual_document_packet.downloaded",
      adminEmail: req.adminEmail ?? null,
      adminUserId: req.adminUserId ?? null,
      targetTable: "manual_document_packets",
      targetId: loaded.packet.id,
      metadata: { document_count: loaded.documents.length },
      ip: req.ip ?? null,
      userAgent: req.get("user-agent") ?? null,
    }).catch((err) => {
      logger.warn(
        { err },
        "manual_document_packet.downloaded audit write failed",
      );
    });

    res.setHeader("Content-Type", "application/pdf");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="packet-${loaded.packet.id.slice(0, 8)}.pdf"`,
    );
    res.setHeader("Cache-Control", "no-store");
    res.status(200).end(pdf);
  },
);

// ── Send email ─────────────────────────────────────────────────────
router.post(
  "/admin/manual-document-packets/:id/send-email",
  requirePermission("patients.update"),
  adminRateLimit({
    name: "manual_document_packets.send_email",
    preset: "sensitive",
  }),
  async (req, res) => {
    const idParsed = idParam.safeParse(req.params);
    if (!idParsed.success) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    const parsed = sendEmailBody.safeParse(req.body ?? {});
    if (!parsed.success) {
      invalidBody(res, parsed.error);
      return;
    }
    if (!process.env.SENDGRID_API_KEY?.trim()) {
      res.status(503).json({ error: "email_not_configured" });
      return;
    }

    const supabase = getSupabaseServiceRoleClient();
    const loaded = await loadPacketForRender(supabase, idParsed.data.id, res);
    if (!loaded) return;
    const { packet, documents } = loaded;
    const to = parsed.data.email ?? packet.recipient_email;
    if (!to) {
      res.status(400).json({ error: "no_recipient_email" });
      return;
    }

    const pdf = await renderManualDocumentPacketToPdf(
      supabase,
      packet,
      documents,
    );
    const supplier = manualDocumentSupplierName();
    const text = [
      `Please find the attached document packet from ${supplier}.`,
      "",
      `Packet: ${packet.title}`,
      `Documents included: ${documents.length}`,
      "",
      "If you have any questions, simply reply to this email.",
    ].join("\n");

    try {
      const client = createSendgridClient();
      await client.sendEmail({
        to,
        subject: `${packet.title} — ${supplier}`,
        html: text
          .split("\n")
          .map((line) => (line ? `<p>${escapeHtml(line)}</p>` : "<br/>"))
          .join(""),
        text,
        attachments: [
          {
            content: pdf,
            filename: `packet-${packet.id.slice(0, 8)}.pdf`,
            contentType: "application/pdf",
          },
        ],
      });
    } catch (err) {
      logger.warn(
        { err: err instanceof Error ? err : new Error(String(err)) },
        "manual_document_packet.send_email failed",
      );
      res.status(502).json({ error: "email_send_failed" });
      return;
    }

    const nowIso = new Date().toISOString();
    // Best-effort stamp — the email already went out, so a failed status
    // write must not 500 (a retry would send a duplicate email).
    const { error: stampErr } = await supabase
      .schema("resupply")
      .from("manual_document_packets")
      .update({ last_emailed_at: nowIso, status: "sent", updated_at: nowIso })
      .eq("id", packet.id);
    if (stampErr) {
      logger.warn(
        { err: stampErr, id: packet.id },
        "manual_document_packet.send_email status stamp failed",
      );
    }
    await stampMemberDocumentsSent(supabase, documents, "email", nowIso);

    await logAudit({
      action: "manual_document_packet.emailed",
      adminEmail: req.adminEmail ?? null,
      adminUserId: req.adminUserId ?? null,
      targetTable: "manual_document_packets",
      targetId: packet.id,
      metadata: { document_count: documents.length },
      ip: req.ip ?? null,
      userAgent: req.get("user-agent") ?? null,
    }).catch((err) => {
      logger.warn({ err }, "manual_document_packet.emailed audit write failed");
    });

    res.json({ ok: true, emailed: true });
  },
);

// ── Send fax ───────────────────────────────────────────────────────
router.post(
  "/admin/manual-document-packets/:id/send-fax",
  requirePermission("patients.update"),
  adminRateLimit({
    name: "manual_document_packets.send_fax",
    preset: "sensitive",
  }),
  async (req, res) => {
    const idParsed = idParam.safeParse(req.params);
    if (!idParsed.success) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    const parsed = sendFaxBody.safeParse(req.body ?? {});
    if (!parsed.success) {
      invalidBody(res, parsed.error);
      return;
    }
    if (!isFaxConfigured()) {
      res.status(503).json({ error: "fax_not_configured" });
      return;
    }

    const supabase = getSupabaseServiceRoleClient();
    const loaded = await loadPacketForRender(supabase, idParsed.data.id, res);
    if (!loaded) return;
    const { packet, documents } = loaded;
    const to = parsed.data.fax ?? packet.recipient_fax_e164;
    if (!to) {
      res.status(400).json({ error: "no_recipient_fax" });
      return;
    }

    // isFaxConfigured() already verified getFaxPublicBaseUrl() is non-null.
    const baseUrl = getFaxPublicBaseUrl()!;
    const token = signManualDocumentPacketFaxToken(packet.id);
    const mediaUrl = `${baseUrl}/resupply-api/fax/document/${token}`;
    const statusCallbackUrl = `${baseUrl}/resupply-api/fax/webhook`;
    const fromNumber = process.env.TELNYX_FAX_FROM_NUMBER!.trim();

    let vendorRef: string;
    try {
      const faxClient = createTelnyxFaxClient();
      const result = await faxClient.sendFax({
        to,
        from: fromNumber,
        mediaUrl,
        statusCallbackUrl,
      });
      vendorRef = result.id;
    } catch (err) {
      const msg =
        err instanceof TelnyxApiError
          ? `Telnyx fax error: ${err.message}`
          : `Fax dispatch error: ${String(err)}`;
      logger.warn(
        { event: "manual_document_packet_fax_failed", id: packet.id },
        "manual_document_packet.send_fax dispatch failed",
      );
      res.status(502).json({ error: "fax_send_failed", message: msg });
      return;
    }

    const nowIso = new Date().toISOString();
    // Best-effort stamp — the fax was already dispatched, so a failed
    // status write must not 500 (a retry would send a duplicate fax).
    const { error: stampErr } = await supabase
      .schema("resupply")
      .from("manual_document_packets")
      .update({ last_faxed_at: nowIso, status: "sent", updated_at: nowIso })
      .eq("id", packet.id);
    if (stampErr) {
      logger.warn(
        { err: stampErr, id: packet.id },
        "manual_document_packet.send_fax status stamp failed",
      );
    }
    await stampMemberDocumentsSent(supabase, documents, "fax", nowIso);

    await logAudit({
      action: "manual_document_packet.faxed",
      adminEmail: req.adminEmail ?? null,
      adminUserId: req.adminUserId ?? null,
      targetTable: "manual_document_packets",
      targetId: packet.id,
      metadata: { document_count: documents.length, vendor_ref: vendorRef },
      ip: req.ip ?? null,
      userAgent: req.get("user-agent") ?? null,
    }).catch((err) => {
      logger.warn({ err }, "manual_document_packet.faxed audit write failed");
    });

    res.json({ ok: true, faxed: true, vendorRef });
  },
);

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export default router;
