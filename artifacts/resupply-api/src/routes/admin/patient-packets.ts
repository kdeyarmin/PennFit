// Patient signature packets — admin endpoints.
//
//   GET  /admin/patient-packet-templates            — the document catalog
//   GET  /admin/patient-packets                      — recent packets (all patients)
//   POST /admin/patient-packets                      — send to an email/phone (no patient
//                                                      selected; auto-files to the chart if
//                                                      the contact matches a patient)
//   GET  /admin/patients/:id/packets                 — a patient's packets
//   POST /admin/patients/:id/packets                 — create + send a packet
//   GET  /admin/packets/:packetId                    — packet detail
//   POST /admin/packets/:packetId/resend             — reissue link + resend email
//   POST /admin/packets/:packetId/void               — void a packet
//   GET  /admin/packets/:packetId/pdf                — download the signed PDF
//   GET  /admin/patient-packet-presets               — named document bundles
//   POST /admin/patient-packet-presets               — save a bundle preset
//   DELETE /admin/patient-packet-presets/:presetId   — delete a preset
//
// Permission posture mirrors documentation-packets: reads require
// `patients.read`, mutations require `patients.update`. The signing
// link is an HMAC token (RESUPPLY_LINK_HMAC_KEY) — see
// lib/patient-packet-token.ts.

import { Router, type IRouter } from "express";
import { z } from "zod";

import { logAudit } from "@workspace/resupply-audit";
import {
  getSupabaseServiceRoleClient,
  type Json,
} from "@workspace/resupply-db";

import { getAuthDeps } from "../../lib/auth-deps";
import { logger } from "../../lib/logger";
import { resolveCompanyProfile } from "../../lib/patient-packet/company";
import {
  defaultTemplateSections,
  effectiveTemplateContent,
  findUnknownTokens,
  listMergeTokens,
  loadTemplateOverrides,
  packetSectionsSchema,
  parseStoredSections,
  renderPacketDocumentSections,
} from "../../lib/patient-packet/content";
import { buildSignedPacketPdf } from "../../lib/patient-packet/signed-pdf";
import {
  applyPacketDocumentOverrides,
  createAndSendPatientPacket,
  createAndSendPatientPacketToContact,
  deliverPacketLink,
  findInvalidOverrideKeys,
  reconcilePacketDocuments,
  resolveDocumentKeys,
  PACKET_CHANNELS,
} from "../../lib/patient-packet/send";
import {
  PACKET_TEMPLATES,
  getPacketTemplate,
  isRequiredPacketDocumentKey,
  isValidPacketDocumentKey,
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

// One-off content edits applied to this packet alone. Sections are in
// token form; unknown {{tokens}} are rejected below with the valid list.
const documentOverridesSchema = z
  .array(
    z
      .object({
        documentKey: z.string().min(1).max(64),
        title: z.string().trim().min(1).max(200).optional(),
        sections: packetSectionsSchema,
      })
      .strict(),
  )
  .max(20)
  .optional();

/** 400 helper: reject overrides whose sections carry unknown tokens. */
function findOverrideUnknownTokens(
  overrides: { sections: z.infer<typeof packetSectionsSchema> }[] | undefined,
): string[] {
  if (!overrides) return [];
  return [...new Set(overrides.flatMap((o) => findUnknownTokens(o.sections)))];
}

const createBody = z
  .object({
    documentKeys: z.array(z.string().min(1).max(64)).min(1).max(20).optional(),
    title: z.string().trim().min(1).max(160).optional(),
    documentOverrides: documentOverridesSchema,
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

// Send a packet to a typed-in email and/or phone, with no patient
// selected. The phone is accepted in any common format and normalized
// server-side. At least one of email/phone must be present.
const sendToContactBody = z
  .object({
    email: z.string().trim().toLowerCase().email().optional().nullable(),
    phone: z.string().trim().min(3).max(40).optional().nullable(),
    recipientName: z.string().trim().min(1).max(160).optional().nullable(),
    documentKeys: z.array(z.string().min(1).max(64)).min(1).max(20).optional(),
    title: z.string().trim().min(1).max(160).optional(),
    documentOverrides: documentOverridesSchema,
    channels: channelsSchema,
    deliveryDetails: deliveryDetailsSchema.optional().nullable(),
    expiresInDays: z.number().int().min(1).max(90).optional(),
  })
  .strict()
  .refine((b) => Boolean(b.email) || Boolean(b.phone), {
    message: "Provide an email address or a phone number.",
    path: ["email"],
  });

// Edit an open (unsigned) packet: change the document set, the title,
// and/or the itemized Proof of Delivery snapshot. Every field is
// optional but at least one must be present.
const updateBody = z
  .object({
    documentKeys: z.array(z.string().min(1).max(64)).min(1).max(20).optional(),
    title: z.string().trim().min(1).max(160).optional(),
    deliveryDetails: deliveryDetailsSchema.optional().nullable(),
    documentOverrides: documentOverridesSchema,
  })
  .strict()
  .refine(
    (b) =>
      b.documentKeys !== undefined ||
      b.title !== undefined ||
      b.deliveryDetails !== undefined ||
      b.documentOverrides !== undefined,
    { message: "Provide at least one field to update." },
  );

const resendBody = z.object({ channels: channelsSchema }).strict();

function signingUrl(baseUrl: string, token: string): string {
  return `${baseUrl.replace(/\/$/, "")}/patient-packet-sign?token=${encodeURIComponent(token)}`;
}

// ── Document catalog (with effective, editable content) ──────────
//
// Returns each template's EFFECTIVE content: the operator's permanent
// override when one exists, else the code default — both in token form
// ({{merge_tokens}} resolve at send/render time). `defaultSections` is
// always the code default so the editor can show a diff / offer revert.
router.get(
  "/admin/patient-packet-templates",
  adminReadRateLimiter,
  requirePermission("patients.read"),
  async (_req, res) => {
    const supabase = getSupabaseServiceRoleClient();
    const overrides = await loadTemplateOverrides(supabase);
    res.json({
      templates: PACKET_TEMPLATES.map((t) => {
        const effective = effectiveTemplateContent(t.key, overrides)!;
        const override = overrides.get(t.key);
        return {
          key: t.key,
          title: effective.title,
          defaultTitle: t.title,
          category: t.category,
          version: effective.version,
          summary: t.summary,
          requiresSignature: t.requiresSignature,
          defaultIncluded: t.defaultIncluded,
          required: isRequiredPacketDocumentKey(t.key),
          customized: effective.customized,
          sections: effective.sections,
          defaultSections: defaultTemplateSections(t.key),
          updatedAt: effective.customized
            ? (override?.updated_at ?? null)
            : null,
          updatedByEmail: effective.customized
            ? (override?.updated_by_email ?? null)
            : null,
        };
      }),
      mergeTokens: listMergeTokens(),
    });
  },
);

// ── Edit a template (permanent, all future packets) ───────────────
//
// Saves an override row for the document key; every packet sent after
// the save snapshots the new content. Already-sent packets are NEVER
// rewritten (their content was snapshotted at send time). Gated on the
// supervisor-tier tools permission — template wording affects every
// patient, unlike sending a packet.
const templateKeyParam = z.object({ key: z.string().min(1).max(64) });

const saveTemplateBody = z
  .object({
    title: z.string().trim().min(1).max(200).optional(),
    sections: packetSectionsSchema,
  })
  .strict();

/**
 * Persist a template override and append its revision-history row.
 * Shared by the PUT (save) route and the restore route so every change
 * — including a restore — lands in the same append-only history.
 * Returns the new revision number.
 */
async function saveTemplateOverride(
  supabase: ReturnType<typeof getSupabaseServiceRoleClient>,
  key: string,
  title: string,
  sections: Json,
  adminEmail: string | null,
): Promise<number> {
  const { data: existing, error: readErr } = await supabase
    .schema("resupply")
    .from("patient_packet_template_overrides")
    .select("revision")
    .eq("document_key", key)
    .limit(1)
    .maybeSingle();
  if (readErr) throw readErr;

  const revision = (existing?.revision ?? 0) + 1;
  const nowIso = new Date().toISOString();
  const { error: upsertErr } = await supabase
    .schema("resupply")
    .from("patient_packet_template_overrides")
    .upsert(
      {
        document_key: key,
        title,
        sections,
        revision,
        updated_by_email: adminEmail,
        updated_at: nowIso,
      },
      { onConflict: "document_key" },
    );
  if (upsertErr) throw upsertErr;

  // Append-only history (migration 0306). Best-effort: a history write
  // failure must not roll back the save the operator just made.
  const { error: histErr } = await supabase
    .schema("resupply")
    .from("patient_packet_template_revisions")
    .insert({
      document_key: key,
      action: "saved",
      revision,
      title,
      sections,
      changed_by_email: adminEmail,
    });
  if (histErr) {
    logger.warn(
      { err: histErr.message, document_key: key },
      "packet template revision-history write failed (save persisted)",
    );
  }

  return revision;
}

router.put(
  "/admin/patient-packet-templates/:key",
  requirePermission("admin.tools.manage"),
  adminRateLimit({
    name: "patient_packet_templates.save",
    preset: "sensitive",
  }),
  async (req, res) => {
    const keyParsed = templateKeyParam.safeParse(req.params);
    if (!keyParsed.success || !isValidPacketDocumentKey(keyParsed.data.key)) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    const key = keyParsed.data.key;
    const parsed = saveTemplateBody.safeParse(req.body ?? {});
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
    const unknownTokens = findUnknownTokens(parsed.data.sections);
    if (unknownTokens.length > 0) {
      res.status(400).json({
        error: "unknown_merge_tokens",
        unknownTokens,
        validTokens: listMergeTokens().map((t) => t.token),
      });
      return;
    }

    const template = getPacketTemplate(key)!;
    const supabase = getSupabaseServiceRoleClient();
    const revision = await saveTemplateOverride(
      supabase,
      key,
      parsed.data.title?.trim() || template.title,
      parsed.data.sections as unknown as Json,
      req.adminEmail ?? null,
    );

    await logAudit({
      action: "patient_packet_template.updated",
      adminEmail: req.adminEmail ?? null,
      adminUserId: req.adminUserId ?? null,
      targetTable: "patient_packet_template_overrides",
      targetId: key,
      // PHI-safe: the key + revision only, never the content.
      metadata: { document_key: key, revision },
      ip: req.ip ?? null,
      userAgent: req.get("user-agent") ?? null,
    }).catch((err) => {
      logger.warn(
        { err },
        "patient_packet_template.updated audit write failed",
      );
    });

    res.json({ key, revision, customized: true });
  },
);

// ── Revert a template to the built-in default ─────────────────────
router.delete(
  "/admin/patient-packet-templates/:key",
  requirePermission("admin.tools.manage"),
  adminRateLimit({
    name: "patient_packet_templates.revert",
    preset: "sensitive",
  }),
  async (req, res) => {
    const keyParsed = templateKeyParam.safeParse(req.params);
    if (!keyParsed.success || !isValidPacketDocumentKey(keyParsed.data.key)) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    const key = keyParsed.data.key;
    const supabase = getSupabaseServiceRoleClient();
    const { data: deleted, error } = await supabase
      .schema("resupply")
      .from("patient_packet_template_overrides")
      .delete()
      .eq("document_key", key)
      .select("document_key");
    if (error) throw error;

    // History row only when an override actually existed (a revert of an
    // already-default template is a no-op, not an event).
    if (deleted && deleted.length > 0) {
      const { error: histErr } = await supabase
        .schema("resupply")
        .from("patient_packet_template_revisions")
        .insert({
          document_key: key,
          action: "reverted",
          changed_by_email: req.adminEmail ?? null,
        });
      if (histErr) {
        logger.warn(
          { err: histErr.message, document_key: key },
          "packet template revision-history write failed (revert persisted)",
        );
      }
    }

    await logAudit({
      action: "patient_packet_template.reverted",
      adminEmail: req.adminEmail ?? null,
      adminUserId: req.adminUserId ?? null,
      targetTable: "patient_packet_template_overrides",
      targetId: key,
      metadata: { document_key: key },
      ip: req.ip ?? null,
      userAgent: req.get("user-agent") ?? null,
    }).catch((err) => {
      logger.warn(
        { err },
        "patient_packet_template.reverted audit write failed",
      );
    });

    res.json({ key, customized: false });
  },
);

// ── Template revision history ─────────────────────────────────────
//
// Append-only log of every save/revert (migration 0306): who changed
// which document's wording, when, and the full content of each saved
// revision — so an accidental edit is one click from recovery.
router.get(
  "/admin/patient-packet-templates/:key/history",
  adminReadRateLimiter,
  requirePermission("patients.read"),
  async (req, res) => {
    const keyParsed = templateKeyParam.safeParse(req.params);
    if (!keyParsed.success || !isValidPacketDocumentKey(keyParsed.data.key)) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    const supabase = getSupabaseServiceRoleClient();
    const { data, error } = await supabase
      .schema("resupply")
      .from("patient_packet_template_revisions")
      .select(
        "id, action, revision, title, sections, changed_by_email, created_at",
      )
      .eq("document_key", keyParsed.data.key)
      .order("created_at", { ascending: false })
      .limit(50);
    if (error) throw error;
    res.json({ revisions: data ?? [] });
  },
);

// Restore a prior saved revision: re-saves its content as a NEW
// override revision (history stays append-only; nothing is rewritten).
const restoreBody = z.object({ revisionId: z.string().uuid() }).strict();

router.post(
  "/admin/patient-packet-templates/:key/restore",
  requirePermission("admin.tools.manage"),
  adminRateLimit({
    name: "patient_packet_templates.restore",
    preset: "sensitive",
  }),
  async (req, res) => {
    const keyParsed = templateKeyParam.safeParse(req.params);
    if (!keyParsed.success || !isValidPacketDocumentKey(keyParsed.data.key)) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    const key = keyParsed.data.key;
    const parsed = restoreBody.safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(400).json({ error: "invalid_body" });
      return;
    }

    const supabase = getSupabaseServiceRoleClient();
    const { data: rev, error: revErr } = await supabase
      .schema("resupply")
      .from("patient_packet_template_revisions")
      .select("id, document_key, action, revision, title, sections")
      .eq("id", parsed.data.revisionId)
      .eq("document_key", key)
      .limit(1)
      .maybeSingle();
    if (revErr) throw revErr;
    if (!rev || rev.action !== "saved") {
      res.status(404).json({ error: "revision_not_found" });
      return;
    }
    // Stored content is validated on the way in, but defend against a
    // malformed row anyway — a restore must never save junk.
    const sections = parseStoredSections(rev.sections);
    if (!sections) {
      res.status(409).json({ error: "revision_unrestorable" });
      return;
    }

    const template = getPacketTemplate(key)!;
    const revision = await saveTemplateOverride(
      supabase,
      key,
      rev.title?.trim() || template.title,
      sections as unknown as Json,
      req.adminEmail ?? null,
    );

    await logAudit({
      action: "patient_packet_template.updated",
      adminEmail: req.adminEmail ?? null,
      adminUserId: req.adminUserId ?? null,
      targetTable: "patient_packet_template_overrides",
      targetId: key,
      metadata: {
        document_key: key,
        revision,
        restored_from_revision: rev.revision,
      },
      ip: req.ip ?? null,
      userAgent: req.get("user-agent") ?? null,
    }).catch((err) => {
      logger.warn(
        { err },
        "patient_packet_template.updated (restore) audit write failed",
      );
    });

    res.json({ key, revision, customized: true });
  },
);

// ── Preview a template as a patient would see it ──────────────────
//
// Resolves merge tokens against the live company profile and sample
// patient values so the operator can VIEW the finished document without
// sending anything. Accepts optional draft sections in the body so the
// editor can preview unsaved edits (POST, but read-only — nothing is
// persisted).
const previewBody = z
  .object({
    title: z.string().trim().min(1).max(200).optional(),
    sections: packetSectionsSchema.optional(),
  })
  .strict();

router.post(
  "/admin/patient-packet-templates/:key/preview",
  adminReadRateLimiter,
  requirePermission("patients.read"),
  async (req, res) => {
    const keyParsed = templateKeyParam.safeParse(req.params);
    if (!keyParsed.success || !isValidPacketDocumentKey(keyParsed.data.key)) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    const key = keyParsed.data.key;
    const parsed = previewBody.safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(400).json({ error: "invalid_body" });
      return;
    }
    const supabase = getSupabaseServiceRoleClient();
    const [company, overrides] = await Promise.all([
      resolveCompanyProfile(supabase),
      loadTemplateOverrides(supabase),
    ]);
    const effective = effectiveTemplateContent(key, overrides)!;
    const sections = renderPacketDocumentSections({
      documentKey: key,
      storedSections: parsed.data.sections ?? effective.sections,
      company,
      recipientName: "Jordan Sample",
      recipientEmail: "jordan@example.com",
      recipientPhone: "+12155550123",
      // A representative POD itemization so the preview shows where the
      // dynamic delivery list lands.
      deliveryDetails:
        key === "proof_of_delivery"
          ? {
              items: [
                {
                  description: "CPAP device (sample)",
                  hcpcs: "E0601",
                  quantity: 1,
                },
              ],
              deliveryDate: new Date().toISOString().slice(0, 10),
            }
          : null,
    });
    res.json({
      key,
      title: parsed.data.title?.trim() || effective.title,
      sections,
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
    const unknownTokens = findOverrideUnknownTokens(b.documentOverrides);
    if (unknownTokens.length > 0) {
      res.status(400).json({
        error: "unknown_merge_tokens",
        unknownTokens,
        validTokens: listMergeTokens().map((t) => t.token),
      });
      return;
    }

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
      documentOverrides: b.documentOverrides,
      expiresInDays: b.expiresInDays,
      createdByEmail: req.adminEmail ?? null,
    });
    if (!result.ok) {
      if (
        result.code === "invalid_document_keys" ||
        result.code === "invalid_document_overrides"
      ) {
        res.status(400).json({
          error: result.code,
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

// ── Send to a contact (no patient selected) ───────────────────────
router.post(
  "/admin/patient-packets",
  requirePermission("patients.update"),
  adminRateLimit({
    name: "patient_packets.create_contact",
    preset: "sensitive",
  }),
  async (req, res) => {
    const parsed = sendToContactBody.safeParse(req.body ?? {});
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
    const unknownTokens = findOverrideUnknownTokens(b.documentOverrides);
    if (unknownTokens.length > 0) {
      res.status(400).json({
        error: "unknown_merge_tokens",
        unknownTokens,
        validTokens: listMergeTokens().map((t) => t.token),
      });
      return;
    }

    const supabase = getSupabaseServiceRoleClient();
    const result = await createAndSendPatientPacketToContact({
      supabase,
      email: b.email,
      phone: b.phone,
      recipientName: b.recipientName,
      documentKeys: b.documentKeys,
      title: b.title,
      channels: b.channels,
      deliveryDetails: b.deliveryDetails ?? null,
      documentOverrides: b.documentOverrides,
      expiresInDays: b.expiresInDays,
      createdByEmail: req.adminEmail ?? null,
    });
    if (!result.ok) {
      if (
        result.code === "invalid_document_keys" ||
        result.code === "invalid_document_overrides"
      ) {
        res.status(400).json({
          error: result.code,
          invalidKeys: result.invalidKeys,
        });
        return;
      }
      // invalid_phone | no_recipient — both are client input problems.
      res.status(400).json({ error: result.code });
      return;
    }

    await logAudit({
      action: "patient_packet.sent",
      adminEmail: req.adminEmail ?? null,
      adminUserId: req.adminUserId ?? null,
      targetTable: "patient_packets",
      targetId: result.packetId,
      // PHI-safe: ids + counts + flags only; never the contact itself.
      metadata: {
        patient_id: result.matchedPatientId,
        linked: result.matchedPatientId != null,
        match_ambiguous: result.matchAmbiguous,
        via_contact: true,
        document_count: result.documentCount,
        email_sent: result.emailSent,
        sms_sent: result.smsSent,
      },
      ip: req.ip ?? null,
      userAgent: req.get("user-agent") ?? null,
    }).catch((err) => {
      logger.warn({ err }, "patient_packet.sent (contact) audit write failed");
    });

    res.status(201).json({
      id: result.packetId,
      status: "sent",
      emailSent: result.emailSent,
      smsSent: result.smsSent,
      signingLink: result.signingLink,
      // Lets the SPA tell the operator whether it filed to a chart.
      matchedPatientId: result.matchedPatientId,
      matchedPatientName: result.matchedPatientName,
      matchAmbiguous: result.matchAmbiguous,
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

// ── Edit an open packet (documents / title / delivery items) ──────
//
// Only packets that have not been signed (draft | sent | viewed) are
// editable; a completed or voided packet is immutable so the captured
// signature always matches the documents it was applied to. The signing
// link stays valid — the patient-facing signing UI loads the document
// set and delivery details fresh on every view, so edits are reflected
// the next time the patient opens the link.
router.patch(
  "/admin/packets/:packetId",
  requirePermission("patients.update"),
  adminRateLimit({ name: "patient_packets.update", preset: "sensitive" }),
  async (req, res) => {
    const parsed = packetIdParam.safeParse(req.params);
    if (!parsed.success) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    const bodyParsed = updateBody.safeParse(req.body ?? {});
    if (!bodyParsed.success) {
      res.status(400).json({
        error: "invalid_body",
        issues: bodyParsed.error.issues.map((i) => ({
          path: i.path.join("."),
          message: i.message,
        })),
      });
      return;
    }
    const b = bodyParsed.data;

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
    if (packet.status === "completed" || packet.status === "voided") {
      res.status(409).json({ error: "packet_closed", status: packet.status });
      return;
    }

    const unknownTokens = findOverrideUnknownTokens(b.documentOverrides);
    if (unknownTokens.length > 0) {
      res.status(400).json({
        error: "unknown_merge_tokens",
        unknownTokens,
        validTokens: listMergeTokens().map((t) => t.token),
      });
      return;
    }

    // Reconcile the document set first so an invalid key fails before any
    // write — the same validation + required-folding the send paths use.
    let documentCount: number | null = null;
    if (b.documentKeys !== undefined) {
      const docs = resolveDocumentKeys(b.documentKeys, undefined);
      if (!docs.ok) {
        res.status(400).json({
          error: "invalid_document_keys",
          invalidKeys: docs.invalidKeys,
        });
        return;
      }
      await reconcilePacketDocuments(supabase, packet.id, docs.uniqueKeys);
      documentCount = docs.uniqueKeys.length;
    }

    // One-off content edits for this packet's documents. Validated
    // against the packet's CURRENT document set (post-reconcile).
    if (b.documentOverrides !== undefined && b.documentOverrides.length > 0) {
      const { data: currentDocs, error: curErr } = await supabase
        .schema("resupply")
        .from("patient_packet_documents")
        .select("document_key")
        .eq("packet_id", packet.id);
      if (curErr) throw curErr;
      const invalidKeys = findInvalidOverrideKeys(
        b.documentOverrides,
        (currentDocs ?? []).map((d) => d.document_key),
      );
      if (invalidKeys.length > 0) {
        res
          .status(400)
          .json({ error: "invalid_document_overrides", invalidKeys });
        return;
      }
      await applyPacketDocumentOverrides(
        supabase,
        packet.id,
        b.documentOverrides,
      );
    }

    // Apply the scalar/JSONB column edits.
    const patch: {
      updated_at: string;
      title?: string;
      delivery_details?: Json | null;
    } = { updated_at: new Date().toISOString() };
    if (b.title !== undefined) patch.title = b.title;
    if (b.deliveryDetails !== undefined) {
      patch.delivery_details = b.deliveryDetails
        ? (b.deliveryDetails as unknown as Json)
        : null;
    }
    const { error: updErr } = await supabase
      .schema("resupply")
      .from("patient_packets")
      .update(patch)
      .eq("id", packet.id);
    if (updErr) throw updErr;

    await logAudit({
      action: "patient_packet.updated",
      adminEmail: req.adminEmail ?? null,
      adminUserId: req.adminUserId ?? null,
      targetTable: "patient_packets",
      targetId: packet.id,
      // PHI-safe: counts + which fields changed, never the contents.
      metadata: {
        documents_changed: b.documentKeys !== undefined,
        document_count: documentCount,
        title_changed: b.title !== undefined,
        delivery_details_changed: b.deliveryDetails !== undefined,
        content_overrides: b.documentOverrides?.length ?? 0,
      },
      ip: req.ip ?? null,
      userAgent: req.get("user-agent") ?? null,
    }).catch((err) => {
      logger.warn({ err }, "patient_packet.updated audit write failed");
    });

    res.json({ status: packet.status, documentCount });
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
        "id, patient_id, status, link_version, recipient_name, recipient_email, recipient_phone, expires_at",
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

    // Prefer the phone snapshotted on the packet at send time. Older
    // packets (created before recipient_phone existed) didn't snapshot
    // it, so fall back to the linked patient's number when present.
    let resendPhone = packet.recipient_phone ?? null;
    if (!resendPhone && packet.patient_id) {
      const { data: patient } = await supabase
        .schema("resupply")
        .from("patients")
        .select("phone_e164")
        .eq("id", packet.patient_id)
        .limit(1)
        .maybeSingle();
      resendPhone = patient?.phone_e164 ?? null;
    }

    const token = signPatientPacketToken(packet.id, nextVersion);
    const link = signingUrl(getAuthDeps().publicBaseUrl, token);

    const { emailSent, smsSent } = await deliverPacketLink({
      supabase,
      recipientName: packet.recipient_name,
      link,
      email: packet.recipient_email,
      phone: resendPhone,
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

// ── Packet bundle presets ─────────────────────────────────────────
//
// Named bundles of document keys (e.g. "Medicare new patient" vs
// "Commercial new patient") the send panel can apply with one click.
// Presets are a selection convenience only: the send path still folds
// in every compliance-required document and re-validates keys, so a
// stale preset can never produce an incomplete or invalid packet.
const presetIdParam = z.object({ presetId: z.string().uuid() });

const createPresetBody = z
  .object({
    name: z.string().trim().min(2).max(80),
    description: z.string().trim().max(300).optional().nullable(),
    documentKeys: z.array(z.string().min(1).max(64)).min(1).max(20),
    packetTitle: z.string().trim().min(1).max(160).optional().nullable(),
  })
  .strict();

router.get(
  "/admin/patient-packet-presets",
  adminReadRateLimiter,
  requirePermission("patients.read"),
  async (_req, res) => {
    const supabase = getSupabaseServiceRoleClient();
    const { data, error } = await supabase
      .schema("resupply")
      .from("patient_packet_presets")
      .select(
        "id, name, description, document_keys, packet_title, created_by_email, created_at",
      )
      .order("name", { ascending: true })
      .limit(100);
    if (error) throw error;
    res.json({ presets: data ?? [] });
  },
);

router.post(
  "/admin/patient-packet-presets",
  requirePermission("admin.tools.manage"),
  adminRateLimit({ name: "patient_packet_presets.save", preset: "sensitive" }),
  async (req, res) => {
    const parsed = createPresetBody.safeParse(req.body ?? {});
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
    const invalidKeys = b.documentKeys.filter(
      (k) => !isValidPacketDocumentKey(k),
    );
    if (invalidKeys.length > 0) {
      res.status(400).json({ error: "invalid_document_keys", invalidKeys });
      return;
    }
    // Store in catalog order with required documents folded in, so the
    // saved preset already reflects what a send would actually include.
    const resolved = resolveDocumentKeys(b.documentKeys, undefined);
    if (!resolved.ok) {
      res.status(400).json({
        error: "invalid_document_keys",
        invalidKeys: resolved.invalidKeys,
      });
      return;
    }

    const supabase = getSupabaseServiceRoleClient();
    const { data: created, error } = await supabase
      .schema("resupply")
      .from("patient_packet_presets")
      .insert({
        name: b.name,
        description: b.description?.trim() || null,
        document_keys: resolved.uniqueKeys,
        packet_title: b.packetTitle?.trim() || null,
        created_by_email: req.adminEmail ?? null,
      })
      .select("id")
      .single();
    if (error) {
      // Unique-index violation on lower(name) → friendly 409.
      if ((error as { code?: string }).code === "23505") {
        res.status(409).json({ error: "name_taken" });
        return;
      }
      throw error;
    }

    await logAudit({
      action: "patient_packet_preset.created",
      adminEmail: req.adminEmail ?? null,
      adminUserId: req.adminUserId ?? null,
      targetTable: "patient_packet_presets",
      targetId: created.id,
      metadata: { document_count: resolved.uniqueKeys.length },
      ip: req.ip ?? null,
      userAgent: req.get("user-agent") ?? null,
    }).catch((err) => {
      logger.warn({ err }, "patient_packet_preset.created audit write failed");
    });

    res.status(201).json({ id: created.id });
  },
);

router.delete(
  "/admin/patient-packet-presets/:presetId",
  requirePermission("admin.tools.manage"),
  adminRateLimit({
    name: "patient_packet_presets.delete",
    preset: "sensitive",
  }),
  async (req, res) => {
    const parsed = presetIdParam.safeParse(req.params);
    if (!parsed.success) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    const supabase = getSupabaseServiceRoleClient();
    const { error } = await supabase
      .schema("resupply")
      .from("patient_packet_presets")
      .delete()
      .eq("id", parsed.data.presetId);
    if (error) throw error;

    await logAudit({
      action: "patient_packet_preset.deleted",
      adminEmail: req.adminEmail ?? null,
      adminUserId: req.adminUserId ?? null,
      targetTable: "patient_packet_presets",
      targetId: parsed.data.presetId,
      metadata: {},
      ip: req.ip ?? null,
      userAgent: req.get("user-agent") ?? null,
    }).catch((err) => {
      logger.warn({ err }, "patient_packet_preset.deleted audit write failed");
    });

    res.json({ ok: true });
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
    // Shared loader (signed-pdf.ts) — the same bytes the auto-file hook
    // writes to the chart, so the two can never drift.
    const built = await buildSignedPacketPdf(supabase, parsed.data.packetId);
    if (!built) {
      res.status(404).json({ error: "not_found" });
      return;
    }

    res.setHeader("Content-Type", "application/pdf");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="patient-packet-${built.packet.id.slice(0, 8)}.pdf"`,
    );
    res.setHeader("Cache-Control", "no-store");
    res.status(200).end(built.pdf);
  },
);

export default router;
