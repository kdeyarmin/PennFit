// /admin/manual-documents — staff-authored, manually-typed PDF documents.
//
// CSRs produce one-off documents (CMN, prescription/order, agreement,
// delivery ticket, fax cover letter, or a free-form letter) by typing
// the content themselves. Fields start BLANK; the optional /prefill
// endpoint suggests values from data already on the chart (patient
// demographics, latest prescription + provider, sleep-study diagnosis)
// so the author only types what they want to change. Each document can
// then be downloaded, emailed to a customer, faxed, and/or filed to a
// patient chart. None of those are required: a document can exist on
// its own.
//
//   GET    /admin/manual-documents/catalog       — type + field catalog
//   GET    /admin/manual-documents/prefill       — chart-sourced field
//                                                  suggestions (?patientId,
//                                                  ?documentType)
//   GET    /admin/manual-documents               — list (?patientId,?status)
//   POST   /admin/manual-documents               — create a draft
//   GET    /admin/manual-documents/:id           — detail
//   PATCH  /admin/manual-documents/:id           — edit
//   DELETE /admin/manual-documents/:id           — delete
//   GET    /admin/manual-documents/:id/pdf       — render + download PDF
//   POST   /admin/manual-documents/:id/send-email — email the PDF
//   POST   /admin/manual-documents/:id/send-fax   — fax the PDF (Telnyx)
//   POST   /admin/manual-documents/:id/attach     — file the PDF to a chart
//
// Permission posture mirrors patient-packets / physician-fax-outreach:
// reads require `patients.read`, mutations require `patients.update`.
//
// PHI / log posture: the typed content + recipient contact are PHI for
// clinical kinds. Audit envelopes carry ids + type + counts + flags
// only — never the field values, the body, the recipient, or PDF bytes.

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

import { signManualDocumentFaxToken } from "../../lib/fax-document-token.js";
import { logger } from "../../lib/logger.js";
import {
  MANUAL_DOCUMENT_CATALOG,
  getManualDocumentTypeDef,
  isManualDocumentType,
  normalizeManualDocumentFields,
  type ManualDocumentType,
} from "../../lib/manual-documents/catalog.js";
import { STANDARD_DOCUMENT_LIBRARY } from "../../lib/manual-documents/standard-documents.js";
import {
  loadManualDocumentRow,
  manualDocumentSupplierName,
  MANUAL_DOCUMENT_ROW_COLUMNS,
  renderManualDocumentRowToPdf,
} from "../../lib/manual-documents/service.js";
import {
  ObjectNotFoundError,
  ObjectStorageService,
} from "../../lib/object-storage/objectStorage.js";
import { computeRetentionUntilAt } from "../../lib/patient-documents/retention.js";
import {
  markTrackingCanceled,
  recordTrackingSent,
  registerSignatureTracking,
} from "../../lib/signature-tracking/service.js";
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
const objectStorage = new ObjectStorageService();

const E164 = /^\+[1-9]\d{6,14}$/;

const idParam = z.object({ id: z.string().uuid() });

// `fields` is a flat key→string map; values are trimmed + filtered
// against the type's catalog before persisting.
const fieldsSchema = z.record(z.string(), z.string().max(8000));

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
    documentType: z.string().refine(isManualDocumentType, {
      message: "Unknown document type",
    }),
    title: z.string().trim().min(1).max(200),
    fields: fieldsSchema.optional(),
    body: z.string().max(20000).nullable().optional(),
    ...recipientSchema,
  })
  .strict();

const updateBody = z
  .object({
    title: z.string().trim().min(1).max(200).optional(),
    fields: fieldsSchema.optional(),
    body: z.string().max(20000).nullable().optional(),
    ...recipientSchema,
  })
  .strict()
  .refine((b) => Object.keys(b).length > 0, {
    message: "Provide at least one field to update.",
  });

const listQuery = z
  .object({
    patientId: z.string().uuid().optional(),
    status: z.enum(["draft", "sent", "attached"]).optional(),
  })
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

const attachBody = z
  .object({
    patientId: z.string().uuid().optional(),
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

// ── Catalog ────────────────────────────────────────────────────────
router.get(
  "/admin/manual-documents/catalog",
  adminReadRateLimiter,
  requirePermission("patients.read"),
  (_req, res) => {
    res.json({
      types: MANUAL_DOCUMENT_CATALOG.map((def) => ({
        type: def.type,
        label: def.label,
        description: def.description,
        phi: def.phi,
        requiresSignature: def.requiresSignature,
        fields: def.fields,
      })),
    });
  },
);

// ── Standard payer-document library ────────────────────────────────
//
// The code-defined, Medicare/payer-aligned starting points (SWO, PAP
// CMN, ABN, AOB, supplier standards, proof of delivery, refill
// confirmation). Always available to every caller with patients.read —
// the SPA renders the library on /admin/documents and "Use" creates an
// ordinary editable draft through the existing POST.
router.get(
  "/admin/manual-documents/standard-catalog",
  adminReadRateLimiter,
  requirePermission("patients.read"),
  (_req, res) => {
    res.json({
      templates: STANDARD_DOCUMENT_LIBRARY.map((t) => ({
        key: t.key,
        label: t.label,
        documentType: t.documentType,
        description: t.description,
        title: t.title,
        fields: t.fields,
        body: t.body,
      })),
    });
  },
);

// ── Prefill from the chart ─────────────────────────────────────────
//
// Suggests field + recipient values for a new manual document from data
// already in the app (patient demographics, the latest prescription and
// its provider — falling back to the sleep study's interpreting provider
// — and the latest sleep-study diagnosis), so the author only
// types what they want to CHANGE. The physician suggestion carries the
// provider's full contact card: name, NPI, phone, fax, and practice
// address. Authoring stays fully editable — this
// endpoint returns suggestions; nothing is persisted, and the SPA only
// fills inputs the operator hasn't already typed in.
//
// Recipient suggestion follows who the document is normally addressed
// to: CMN / prescription / fax cover go TO the physician; agreements
// and delivery tickets go to the patient.
//
// PHI posture: the response is patient demographics over an authed
// admin session — same as the patient detail routes. Never logged.
const prefillQuery = z
  .object({
    patientId: z.string().uuid(),
    documentType: z.string().refine(isManualDocumentType, {
      message: "Unknown document type",
    }),
  })
  .strict();

function formatJsonAddress(raw: unknown): string {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return "";
  const r = raw as Record<string, unknown>;
  const str = (k: string) => (typeof r[k] === "string" ? (r[k] as string) : "");
  const line1 = str("line1");
  const line2 = str("line2");
  const city = str("city");
  const state = str("state");
  const zip = str("postalCode") || str("postal_code") || str("zip");
  const cityLine = [city, [state, zip].filter(Boolean).join(" ")]
    .filter(Boolean)
    .join(", ");
  return [line1, line2, cityLine].filter(Boolean).join("\n");
}

router.get(
  "/admin/manual-documents/prefill",
  adminReadRateLimiter,
  requirePermission("patients.read"),
  async (req, res) => {
    const parsed = prefillQuery.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json({ error: "invalid_query" });
      return;
    }
    const { patientId, documentType } = parsed.data;
    const supabase = getSupabaseServiceRoleClient();

    const { data: patient, error: patientErr } = await supabase
      .schema("resupply")
      .from("patients")
      .select(
        "id, legal_first_name, legal_last_name, date_of_birth, phone_e164, email, address",
      )
      .eq("id", patientId)
      .limit(1)
      .maybeSingle();
    if (patientErr) throw patientErr;
    if (!patient) {
      res.status(404).json({ error: "patient_not_found" });
      return;
    }

    const [presRes, studyRes] = await Promise.all([
      supabase
        .schema("resupply")
        .from("prescriptions")
        .select("item_sku, hcpcs_code, provider_id, status, created_at")
        .eq("patient_id", patientId)
        .order("created_at", { ascending: false })
        .limit(10),
      supabase
        .schema("resupply")
        .from("sleep_studies")
        .select("diagnosis_icd10, study_date, interpreting_provider_id")
        .eq("patient_id", patientId)
        .order("study_date", { ascending: false })
        .limit(1)
        .maybeSingle(),
    ]);
    if (presRes.error) throw presRes.error;
    if (studyRes.error) throw studyRes.error;

    const prescriptions = presRes.data ?? [];
    const activePrescriptions = prescriptions.filter(
      (p) => p.status === "active",
    );
    const relevantPrescriptions =
      activePrescriptions.length > 0 ? activePrescriptions : prescriptions;
    // Physician resolution: the latest prescription's provider first;
    // when no prescription names one, fall back to the sleep study's
    // interpreting provider so a chart with only a study still prefills.
    const providerId =
      relevantPrescriptions.find((p) => p.provider_id)?.provider_id ??
      studyRes.data?.interpreting_provider_id ??
      null;

    let provider: {
      legal_name: string | null;
      npi: string | null;
      practice_name: string | null;
      phone_e164: string | null;
      fax_e164: string | null;
      email: string | null;
      practice_address: unknown;
    } | null = null;
    if (providerId) {
      const { data, error: provErr } = await supabase
        .schema("resupply")
        .from("providers")
        .select(
          "legal_name, npi, practice_name, phone_e164, fax_e164, email, practice_address",
        )
        .eq("id", providerId)
        .limit(1)
        .maybeSingle();
      if (provErr) throw provErr;
      provider = data;
    }

    const patientName =
      `${patient.legal_first_name ?? ""} ${patient.legal_last_name ?? ""}`.trim();
    const patientAddress = formatJsonAddress(patient.address);
    const itemLines = [
      ...new Set(
        relevantPrescriptions.map((p) =>
          p.hcpcs_code ? `${p.item_sku} (HCPCS ${p.hcpcs_code})` : p.item_sku,
        ),
      ),
    ].join("\n");
    const diagnosis = studyRes.data?.diagnosis_icd10 ?? "";
    const providerAddress = formatJsonAddress(provider?.practice_address);

    // Per-type field suggestions. Only keys the type's catalog defines
    // survive (normalize below), and empty values are dropped, so the
    // SPA always receives a minimal, valid map.
    const byType: Record<ManualDocumentType, Record<string, string>> = {
      cmn: {
        patient_name: patientName,
        date_of_birth: patient.date_of_birth ?? "",
        ordering_physician: provider?.legal_name ?? "",
        physician_npi: provider?.npi ?? "",
        physician_phone: provider?.phone_e164 ?? "",
        physician_fax: provider?.fax_e164 ?? "",
        physician_address: providerAddress,
        diagnosis,
        equipment: itemLines,
      },
      prescription: {
        patient_name: patientName,
        date_of_birth: patient.date_of_birth ?? "",
        prescriber_name: provider?.legal_name ?? "",
        prescriber_npi: provider?.npi ?? "",
        prescriber_phone: provider?.phone_e164 ?? "",
        prescriber_fax: provider?.fax_e164 ?? "",
        prescriber_address: providerAddress,
        items_ordered: itemLines,
        icd10_codes: diagnosis,
      },
      agreement: {
        party_name: patientName,
      },
      delivery_ticket: {
        patient_name: patientName,
        delivery_address: patientAddress,
      },
      cover_letter: {
        attention: provider?.legal_name ?? "",
        from_name: manualDocumentSupplierName(),
      },
      other: {},
    };
    const fields = normalizeManualDocumentFields(
      documentType,
      byType[documentType],
    );

    // Recipient block: physician-addressed kinds vs patient-addressed.
    const toProvider =
      documentType === "cmn" ||
      documentType === "prescription" ||
      documentType === "cover_letter";
    const recipient =
      toProvider && provider
        ? {
            name:
              [provider.legal_name, provider.practice_name]
                .filter(Boolean)
                .join(" — ") || null,
            address: providerAddress || null,
            email: provider.email ?? null,
            fax: provider.fax_e164 ?? null,
          }
        : !toProvider
          ? {
              name: patientName || null,
              address: patientAddress || null,
              email: patient.email ?? null,
              fax: null,
            }
          : { name: null, address: null, email: null, fax: null };

    res.json({ fields, recipient });
  },
);

// ── List ───────────────────────────────────────────────────────────
router.get(
  "/admin/manual-documents",
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
      .from("manual_documents")
      .select(
        "id, document_type, title, status, patient_id, chart_document_id, " +
          "recipient_name, recipient_email, recipient_fax_e164, " +
          "last_emailed_at, last_faxed_at, attached_at, created_by_email, " +
          "created_at, updated_at",
      )
      .order("created_at", { ascending: false })
      .limit(100);
    if (parsed.data.patientId) {
      query = query.eq("patient_id", parsed.data.patientId);
    }
    if (parsed.data.status) {
      query = query.eq("status", parsed.data.status);
    }
    const { data, error } = await query;
    if (error) throw error;
    res.json({ documents: data ?? [] });
  },
);

// ── Create ─────────────────────────────────────────────────────────
router.post(
  "/admin/manual-documents",
  requirePermission("patients.update"),
  adminRateLimit({ name: "manual_documents.create", preset: "sensitive" }),
  async (req, res) => {
    const parsed = createBody.safeParse(req.body ?? {});
    if (!parsed.success) {
      invalidBody(res, parsed.error);
      return;
    }
    const b = parsed.data;
    const type = b.documentType as ManualDocumentType;
    const fields = normalizeManualDocumentFields(type, b.fields);

    const supabase = getSupabaseServiceRoleClient();
    const nowIso = new Date().toISOString();
    const { data: inserted, error } = await supabase
      .schema("resupply")
      .from("manual_documents")
      .insert({
        document_type: type,
        title: b.title,
        fields: fields as unknown as Json,
        body: b.body ?? null,
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
    if (!inserted) throw new Error("manual_documents insert returned no rows");

    // Signable document kinds (CMN, prescription, agreement, delivery
    // ticket) get a signature-tracking row + barcode so they show up in
    // the outstanding-signatures dashboard and a returned fax can be
    // scanned and filed. Non-signable kinds (cover letter, free-form) do
    // not. Best-effort — never fail the create on a tracking error.
    let trackingCode: string | null = null;
    if (getManualDocumentTypeDef(type).requiresSignature) {
      try {
        const reg = await registerSignatureTracking(supabase, {
          kind: "manual_document",
          documentId: inserted.id,
          title: b.title,
          providerLabel: b.recipientName ?? null,
          returnFaxE164: b.recipientFaxE164 ?? null,
          createdByEmail: req.adminEmail ?? null,
        });
        trackingCode = reg.trackingCode;
      } catch (err) {
        logger.warn({ err }, "manual_document.tracking_register failed");
      }
    }

    await logAudit({
      action: "manual_document.created",
      adminEmail: req.adminEmail ?? null,
      adminUserId: req.adminUserId ?? null,
      targetTable: "manual_documents",
      targetId: inserted.id,
      metadata: {
        document_type: type,
        field_count: Object.keys(fields).length,
      },
      ip: req.ip ?? null,
      userAgent: req.get("user-agent") ?? null,
    }).catch((err) => {
      logger.warn({ err }, "manual_document.created audit write failed");
    });

    res.status(201).json({ id: inserted.id, status: "draft", trackingCode });
  },
);

// ── Detail ─────────────────────────────────────────────────────────
router.get(
  "/admin/manual-documents/:id",
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
      .from("manual_documents")
      .select(MANUAL_DOCUMENT_ROW_COLUMNS)
      .eq("id", parsed.data.id)
      .limit(1)
      .maybeSingle();
    if (error) throw error;
    if (!data) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    res.json({ document: data });
  },
);

// ── Edit ───────────────────────────────────────────────────────────
router.patch(
  "/admin/manual-documents/:id",
  requirePermission("patients.update"),
  adminRateLimit({ name: "manual_documents.update", preset: "sensitive" }),
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
    const { data: existing, error: loadErr } = await supabase
      .schema("resupply")
      .from("manual_documents")
      .select("id, document_type")
      .eq("id", idParsed.data.id)
      .limit(1)
      .maybeSingle();
    if (loadErr) throw loadErr;
    if (!existing || !isManualDocumentType(existing.document_type)) {
      res.status(404).json({ error: "not_found" });
      return;
    }

    const patch: Record<string, unknown> = {
      updated_at: new Date().toISOString(),
    };
    if (b.title !== undefined) patch.title = b.title;
    if (b.body !== undefined) patch.body = b.body;
    if (b.fields !== undefined) {
      patch.fields = normalizeManualDocumentFields(
        existing.document_type,
        b.fields,
      ) as unknown as Json;
    }
    if (b.recipientName !== undefined) patch.recipient_name = b.recipientName;
    if (b.recipientAddress !== undefined) {
      patch.recipient_address = b.recipientAddress;
    }
    if (b.recipientEmail !== undefined)
      patch.recipient_email = b.recipientEmail;
    if (b.recipientFaxE164 !== undefined) {
      patch.recipient_fax_e164 = b.recipientFaxE164;
    }

    const { error: updErr } = await supabase
      .schema("resupply")
      .from("manual_documents")
      .update(patch)
      .eq("id", idParsed.data.id);
    if (updErr) throw updErr;

    await logAudit({
      action: "manual_document.updated",
      adminEmail: req.adminEmail ?? null,
      adminUserId: req.adminUserId ?? null,
      targetTable: "manual_documents",
      targetId: idParsed.data.id,
      metadata: {
        fields_changed: b.fields !== undefined,
        title_changed: b.title !== undefined,
        body_changed: b.body !== undefined,
      },
      ip: req.ip ?? null,
      userAgent: req.get("user-agent") ?? null,
    }).catch((err) => {
      logger.warn({ err }, "manual_document.updated audit write failed");
    });

    res.json({ ok: true });
  },
);

// ── Delete ─────────────────────────────────────────────────────────
router.delete(
  "/admin/manual-documents/:id",
  requirePermission("patients.update"),
  adminRateLimit({ name: "manual_documents.delete", preset: "destroy" }),
  async (req, res) => {
    const parsed = idParam.safeParse(req.params);
    if (!parsed.success) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    const supabase = getSupabaseServiceRoleClient();
    const { error } = await supabase
      .schema("resupply")
      .from("manual_documents")
      .delete()
      .eq("id", parsed.data.id);
    if (error) throw error;

    await markTrackingCanceled(
      supabase,
      "manual_document",
      parsed.data.id,
    ).catch((err) =>
      logger.warn({ err }, "manual_document.tracking_canceled failed"),
    );

    await logAudit({
      action: "manual_document.deleted",
      adminEmail: req.adminEmail ?? null,
      adminUserId: req.adminUserId ?? null,
      targetTable: "manual_documents",
      targetId: parsed.data.id,
      metadata: {},
      ip: req.ip ?? null,
      userAgent: req.get("user-agent") ?? null,
    }).catch((err) => {
      logger.warn({ err }, "manual_document.deleted audit write failed");
    });

    res.json({ ok: true }); // idempotent
  },
);

// ── Render + download PDF ──────────────────────────────────────────
router.get(
  "/admin/manual-documents/:id/pdf",
  adminReadRateLimiter,
  requirePermission("patients.read"),
  async (req, res) => {
    const parsed = idParam.safeParse(req.params);
    if (!parsed.success) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    const supabase = getSupabaseServiceRoleClient();
    const row = await loadManualDocumentRow(supabase, parsed.data.id);
    if (!row) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    const pdf = await renderManualDocumentRowToPdf(supabase, row);

    await logAudit({
      action: "manual_document.downloaded",
      adminEmail: req.adminEmail ?? null,
      adminUserId: req.adminUserId ?? null,
      targetTable: "manual_documents",
      targetId: row.id,
      metadata: { document_type: row.document_type },
      ip: req.ip ?? null,
      userAgent: req.get("user-agent") ?? null,
    }).catch((err) => {
      logger.warn({ err }, "manual_document.downloaded audit write failed");
    });

    res.setHeader("Content-Type", "application/pdf");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="${row.document_type}-${row.id.slice(0, 8)}.pdf"`,
    );
    res.setHeader("Cache-Control", "no-store");
    res.status(200).end(pdf);
  },
);

// ── Send email ─────────────────────────────────────────────────────
router.post(
  "/admin/manual-documents/:id/send-email",
  requirePermission("patients.update"),
  adminRateLimit({ name: "manual_documents.send_email", preset: "sensitive" }),
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
    const row = await loadManualDocumentRow(supabase, idParsed.data.id);
    if (!row) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    const to = parsed.data.email ?? row.recipient_email;
    if (!to) {
      res.status(400).json({ error: "no_recipient_email" });
      return;
    }

    const pdf = await renderManualDocumentRowToPdf(supabase, row);
    const supplier = manualDocumentSupplierName();
    const text = [
      `Please find the attached document from ${supplier}.`,
      "",
      `Document: ${row.title}`,
      "",
      "If you have any questions, simply reply to this email.",
    ].join("\n");

    try {
      const client = createSendgridClient();
      await client.sendEmail({
        to,
        subject: `${row.title} — ${supplier}`,
        html: text
          .split("\n")
          .map((line) => (line ? `<p>${escapeHtml(line)}</p>` : "<br/>"))
          .join(""),
        text,
        attachments: [
          {
            content: pdf,
            filename: `${row.document_type}-${row.id.slice(0, 8)}.pdf`,
            contentType: "application/pdf",
          },
        ],
      });
    } catch (err) {
      logger.warn({ err }, "manual_document.send_email failed");
      res.status(502).json({ error: "email_send_failed" });
      return;
    }

    const nowIso = new Date().toISOString();
    // Best-effort stamp — the email already went out, so a failed status
    // write must not 500 (a retry would send a duplicate email).
    const { error: emailStampErr } = await supabase
      .schema("resupply")
      .from("manual_documents")
      .update({
        last_emailed_at: nowIso,
        status: row.status === "attached" ? "attached" : "sent",
        updated_at: nowIso,
      })
      .eq("id", row.id);
    if (emailStampErr) {
      logger.warn(
        { err: emailStampErr, id: row.id },
        "manual_document.send_email status stamp failed",
      );
    }

    await recordTrackingSent(
      supabase,
      "manual_document",
      row.id,
      "email",
    ).catch((err) =>
      logger.warn({ err }, "manual_document.tracking_sent failed"),
    );

    await logAudit({
      action: "manual_document.emailed",
      adminEmail: req.adminEmail ?? null,
      adminUserId: req.adminUserId ?? null,
      targetTable: "manual_documents",
      targetId: row.id,
      metadata: { document_type: row.document_type },
      ip: req.ip ?? null,
      userAgent: req.get("user-agent") ?? null,
    }).catch((err) => {
      logger.warn({ err }, "manual_document.emailed audit write failed");
    });

    res.json({ ok: true, emailed: true });
  },
);

// ── Send fax ───────────────────────────────────────────────────────
router.post(
  "/admin/manual-documents/:id/send-fax",
  requirePermission("patients.update"),
  adminRateLimit({ name: "manual_documents.send_fax", preset: "sensitive" }),
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
    const row = await loadManualDocumentRow(supabase, idParsed.data.id);
    if (!row) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    const to = parsed.data.fax ?? row.recipient_fax_e164;
    if (!to) {
      res.status(400).json({ error: "no_recipient_fax" });
      return;
    }

    // isFaxConfigured() already verified getFaxPublicBaseUrl() is non-null.
    const baseUrl = getFaxPublicBaseUrl()!;
    const token = signManualDocumentFaxToken(row.id);
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
        { event: "manual_document_fax_failed", id: row.id },
        "manual_document.send_fax dispatch failed",
      );
      res.status(502).json({ error: "fax_send_failed", message: msg });
      return;
    }

    const nowIso = new Date().toISOString();
    // Best-effort stamp — the fax was already dispatched, so a failed
    // status write must not 500 (a retry would send a duplicate fax).
    const { error: faxStampErr } = await supabase
      .schema("resupply")
      .from("manual_documents")
      .update({
        last_faxed_at: nowIso,
        status: row.status === "attached" ? "attached" : "sent",
        updated_at: nowIso,
      })
      .eq("id", row.id);
    if (faxStampErr) {
      logger.warn(
        { err: faxStampErr, id: row.id },
        "manual_document.send_fax status stamp failed",
      );
    }

    await recordTrackingSent(supabase, "manual_document", row.id, "fax").catch(
      (err) => logger.warn({ err }, "manual_document.tracking_sent failed"),
    );

    await logAudit({
      action: "manual_document.faxed",
      adminEmail: req.adminEmail ?? null,
      adminUserId: req.adminUserId ?? null,
      targetTable: "manual_documents",
      targetId: row.id,
      metadata: { document_type: row.document_type, vendor_ref: vendorRef },
      ip: req.ip ?? null,
      userAgent: req.get("user-agent") ?? null,
    }).catch((err) => {
      logger.warn({ err }, "manual_document.faxed audit write failed");
    });

    res.json({ ok: true, faxed: true, vendorRef });
  },
);

// ── Attach to a patient chart ──────────────────────────────────────
router.post(
  "/admin/manual-documents/:id/attach",
  requirePermission("patients.update"),
  adminRateLimit({ name: "manual_documents.attach", preset: "sensitive" }),
  async (req, res) => {
    const idParsed = idParam.safeParse(req.params);
    if (!idParsed.success) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    const parsed = attachBody.safeParse(req.body ?? {});
    if (!parsed.success) {
      invalidBody(res, parsed.error);
      return;
    }

    const supabase = getSupabaseServiceRoleClient();
    const row = await loadManualDocumentRow(supabase, idParsed.data.id);
    if (!row) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    const patientId = parsed.data.patientId ?? row.patient_id;
    if (!patientId) {
      res.status(400).json({ error: "patient_required" });
      return;
    }

    // Confirm the chart exists before we render/upload anything.
    const { data: patient, error: patientErr } = await supabase
      .schema("resupply")
      .from("patients")
      .select("id")
      .eq("id", patientId)
      .limit(1)
      .maybeSingle();
    if (patientErr) throw patientErr;
    if (!patient) {
      res.status(404).json({ error: "patient_not_found" });
      return;
    }

    const pdf = await renderManualDocumentRowToPdf(supabase, row);

    // Upload the rendered PDF to private object storage, owned by the
    // patient — same pattern as the inbound-fax / portal-upload paths.
    let objectKey: string;
    try {
      const uploadUrl = await objectStorage.getObjectEntityUploadURL();
      const putResp = await fetch(uploadUrl, {
        method: "PUT",
        headers: { "Content-Type": "application/pdf" },
        body: pdf,
      });
      if (!putResp.ok) {
        res.status(502).json({ error: "upload_failed" });
        return;
      }
      objectKey = await objectStorage.trySetObjectEntityAclPolicy(uploadUrl, {
        owner: patientId,
        visibility: "private",
      });
    } catch (err) {
      if (err instanceof ObjectNotFoundError) {
        res.status(502).json({ error: "upload_failed" });
        return;
      }
      logger.warn({ err }, "manual_document.attach upload failed");
      res.status(502).json({ error: "upload_failed" });
      return;
    }

    const nowIso = new Date().toISOString();
    const filename = `${row.document_type}-${row.id.slice(0, 8)}.pdf`;
    const retentionUntilAt = computeRetentionUntilAt({
      createdAt: new Date(nowIso),
      documentType: row.document_type,
    }).toISOString();

    const { data: docRow, error: insertErr } = await supabase
      .schema("resupply")
      .from("patient_documents")
      .insert({
        patient_id: patientId,
        object_key: objectKey,
        document_type: row.document_type,
        filename,
        content_type: "application/pdf",
        size_bytes: pdf.byteLength,
        retention_until_at: retentionUntilAt,
        created_at: nowIso,
        updated_at: nowIso,
      })
      .select("id")
      .limit(1)
      .maybeSingle();
    if (insertErr) throw insertErr;

    const { error: attachErr } = await supabase
      .schema("resupply")
      .from("manual_documents")
      .update({
        patient_id: patientId,
        chart_document_id: docRow?.id ?? null,
        status: "attached",
        attached_at: nowIso,
        updated_at: nowIso,
      })
      .eq("id", row.id);
    if (attachErr) throw attachErr;

    await logAudit({
      action: "manual_document.attached",
      adminEmail: req.adminEmail ?? null,
      adminUserId: req.adminUserId ?? null,
      targetTable: "manual_documents",
      targetId: row.id,
      metadata: {
        document_type: row.document_type,
        patient_id: patientId,
        patient_document_id: docRow?.id ?? null,
      },
      ip: req.ip ?? null,
      userAgent: req.get("user-agent") ?? null,
    }).catch((err) => {
      logger.warn({ err }, "manual_document.attached audit write failed");
    });

    res.status(201).json({
      ok: true,
      patientId,
      patientDocumentId: docRow?.id ?? null,
    });
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
