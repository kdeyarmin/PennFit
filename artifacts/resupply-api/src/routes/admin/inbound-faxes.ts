// /admin/inbound-faxes — CSR triage surface for the inbound fax
// queue.
//
//   GET    /admin/inbound-faxes                   — paginated list
//   GET    /admin/inbound-faxes/:id               — single fax detail
//   GET    /admin/inbound-faxes/:id/media         — stream the PDF/TIFF
//   PATCH  /admin/inbound-faxes/:id               — status transitions
//                                                     + attach fields
//
// Triage state machine (also documented in the schema file):
//   new      -> triaged | attached | archived
//   triaged  -> attached | archived | new
//   attached -> archived
//   archived -> new
//
// The `attached` transition requires `attached_patient_id` to be
// set in the same PATCH (or already on the row) — this is enforced
// here, not at the DB level, because Postgres doesn't have a
// conditional NOT NULL we can layer onto the existing nullable FK.
//
// PHI posture: list / detail responses include from_e164 (sender
// fax — physician PHI) because CSRs need it to recognize the
// originating office. Logger receives only the row id and a
// first-8 prefix of the twilio_fax_sid, never the From.

import { Router, type IRouter } from "express";
import { Readable } from "node:stream";
import { z } from "zod";

import { logAudit } from "@workspace/resupply-audit";
import {
  type Database,
  getSupabaseServiceRoleClient,
} from "@workspace/resupply-db";

import { logger } from "../../lib/logger";
import { extractFaxFields } from "../../lib/inbound-fax/ocr";
import {
  ObjectNotFoundError,
  ObjectStorageService,
} from "../../lib/object-storage/objectStorage";
import { adminRateLimit } from "../../middlewares/admin-rate-limit";
import { requirePermission } from "../../middlewares/requireAdmin";

type InboundFaxUpdate =
  Database["resupply"]["Tables"]["inbound_faxes"]["Update"];
type InboundFaxStatus = NonNullable<
  Database["resupply"]["Tables"]["inbound_faxes"]["Row"]["status"]
>;

const router: IRouter = Router();
const objectStorage = new ObjectStorageService();

const idParam = z.object({ id: z.string().uuid() });

// Allowed status transitions. `attached` requires a patient FK in
// the same PATCH (enforced in the route, not the table).
const VALID_TRANSITIONS: Record<InboundFaxStatus, readonly InboundFaxStatus[]> =
  {
    new: ["triaged", "attached", "archived"],
    triaged: ["attached", "archived", "new"],
    attached: ["archived"],
    archived: ["new"],
  };

const listQuery = z.object({
  status: z
    .enum([
      "new",
      "triaged",
      "attached",
      "archived",
      "open", // pseudo-status: not 'archived' (default)
    ])
    .optional()
    .default("open"),
  limit: z.coerce.number().int().min(1).max(100).optional().default(50),
});

const patchBody = z
  .object({
    status: z.enum(["new", "triaged", "attached", "archived"]).optional(),
    attachedPatientId: z.string().uuid().nullable().optional(),
    attachedProviderId: z.string().uuid().nullable().optional(),
    attachedPrescriptionId: z.string().uuid().nullable().optional(),
    attachedDocumentType: z
      .string()
      .trim()
      .max(64)
      .nullable()
      .optional()
      .transform((v) => (v === "" || v == null ? null : v)),
    notes: z
      .string()
      .trim()
      .max(2000)
      .nullable()
      .optional()
      .transform((v) => (v === "" || v == null ? null : v)),
  })
  .strict();

// Inbound-fax triage queue — CSR work. `conversations.manage`
// matches the rest of the inbox-tier surface (product-questions,
// reviews, customer-followups).
router.get(
  "/admin/inbound-faxes",
  requirePermission("conversations.manage"),
  async (req, res) => {
    const q = listQuery.safeParse(req.query);
    if (!q.success) {
      res.status(400).json({ error: "invalid_query" });
      return;
    }
    const supabase = getSupabaseServiceRoleClient();
    let query = supabase
      .schema("resupply")
      .from("inbound_faxes")
      .select(
        "id, twilio_fax_sid, from_e164, to_e164, received_at, num_pages, media_object_key, media_content_type, media_size_bytes, status, attached_patient_id, attached_provider_id, attached_prescription_id, attached_document_type, assigned_admin_user_id, triaged_at, notes, created_at, tracking_code_detected, auto_file_status, auto_filed_at, signature_tracking_id, chart_document_id",
      )
      .order("received_at", { ascending: false })
      .limit(q.data.limit);
    if (q.data.status === "open") {
      query = query.not("status", "eq", "archived");
    } else {
      query = query.eq("status", q.data.status);
    }
    const { data, error } = await query;
    if (error) throw error;

    res.json({
      faxes: (data ?? []).map((r) => ({
        id: r.id,
        twilioFaxSid: r.twilio_fax_sid,
        fromE164: r.from_e164,
        toE164: r.to_e164,
        receivedAt: r.received_at,
        numPages: r.num_pages,
        hasMedia: r.media_object_key !== null,
        mediaContentType: r.media_content_type,
        mediaSizeBytes: r.media_size_bytes,
        status: r.status,
        attachedPatientId: r.attached_patient_id,
        attachedProviderId: r.attached_provider_id,
        attachedPrescriptionId: r.attached_prescription_id,
        attachedDocumentType: r.attached_document_type,
        notes: r.notes,
        createdAt: r.created_at,
        triagedAt: r.triaged_at,
        // Barcode auto-file outcome (migration 0258). Null when the
        // `fax.auto_file_signed` flag is off or no scan ran.
        trackingCodeDetected: r.tracking_code_detected,
        autoFileStatus: r.auto_file_status,
        autoFiledAt: r.auto_filed_at,
        signatureTrackingId: r.signature_tracking_id,
        chartDocumentId: r.chart_document_id,
      })),
    });
  },
);

router.get(
  "/admin/inbound-faxes/:id",
  requirePermission("conversations.manage"),
  async (req, res) => {
    const params = idParam.safeParse(req.params);
    if (!params.success) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    const supabase = getSupabaseServiceRoleClient();
    const { data: row, error } = await supabase
      .schema("resupply")
      .from("inbound_faxes")
      .select("*")
      .eq("id", params.data.id)
      .limit(1)
      .maybeSingle();
    if (error) throw error;
    if (!row) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    res.json({
      id: row.id,
      twilioFaxSid: row.twilio_fax_sid,
      fromE164: row.from_e164,
      toE164: row.to_e164,
      receivedAt: row.received_at,
      numPages: row.num_pages,
      hasMedia: row.media_object_key !== null,
      mediaContentType: row.media_content_type,
      mediaSizeBytes: row.media_size_bytes,
      status: row.status,
      attachedPatientId: row.attached_patient_id,
      attachedProviderId: row.attached_provider_id,
      attachedPrescriptionId: row.attached_prescription_id,
      attachedDocumentType: row.attached_document_type,
      notes: row.notes,
      createdAt: row.created_at,
      triagedAt: row.triaged_at,
      triagedByUserId: row.triaged_by_user_id,
      assignedAdminUserId: row.assigned_admin_user_id,
      ocrStatus: row.ocr_status,
      ocrExtraction: row.ocr_extraction,
      ocrExtractedAt: row.ocr_extracted_at,
      // Barcode auto-file outcome (migration 0258).
      trackingCodeDetected: row.tracking_code_detected,
      autoFileStatus: row.auto_file_status,
      autoFiledAt: row.auto_filed_at,
      signatureTrackingId: row.signature_tracking_id,
      chartDocumentId: row.chart_document_id,
    });
  },
);

router.get(
  "/admin/inbound-faxes/:id/media",
  // Per-attachment media URLs (one-shot signed object-storage links;
  // the fax bytes were mirrored from Telnyx at ingest time).
  // Same scope as the list/detail above.
  requirePermission("conversations.manage"),
  async (req, res) => {
    const params = idParam.safeParse(req.params);
    if (!params.success) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    const supabase = getSupabaseServiceRoleClient();
    const { data: row, error } = await supabase
      .schema("resupply")
      .from("inbound_faxes")
      .select("id, media_object_key, media_content_type, twilio_fax_sid")
      .eq("id", params.data.id)
      .limit(1)
      .maybeSingle();
    if (error) throw error;
    if (!row || !row.media_object_key) {
      res.status(404).json({ error: "media_not_persisted" });
      return;
    }

    let file;
    try {
      file = await objectStorage.getObjectEntityFile(row.media_object_key);
    } catch (err) {
      if (err instanceof ObjectNotFoundError) {
        res.status(404).json({ error: "media_not_found" });
        return;
      }
      throw err;
    }

    await logAudit({
      action: "fax.inbound_media.admin_download",
      adminEmail: req.adminEmail ?? null,
      adminUserId: req.adminUserId ?? null,
      targetTable: "inbound_faxes",
      targetId: row.id,
      metadata: {
        twilio_fax_sid: row.twilio_fax_sid,
      },
      ip: req.ip ?? null,
      userAgent: req.get("user-agent") ?? null,
    }).catch((err) => {
      logger.warn({ err }, "fax.inbound_media.admin_download audit failed");
    });

    try {
      const response = await objectStorage.downloadObject(file, 0);
      res.status(response.status);
      response.headers.forEach((value, key) => res.setHeader(key, value));
      if (row.media_content_type) {
        res.setHeader("Content-Type", row.media_content_type);
      }
      res.setHeader(
        "Content-Disposition",
        `inline; filename="fax-${row.id.slice(0, 8)}.pdf"`,
      );
      res.setHeader("Cache-Control", "no-store");
      if (response.body) {
        const nodeStream = Readable.fromWeb(
          response.body as unknown as ReadableStream<Uint8Array>,
        );
        nodeStream.pipe(res);
      } else {
        res.end();
      }
    } catch (err) {
      logger.error({ err, row_id: row.id }, "fax_inbound_media_stream_failed");
      res.status(500).json({ error: "download_failed" });
    }
  },
);

// POST /admin/inbound-faxes/:id/ocr — run AI field extraction on the
// fax media and persist the structured result so the triage form can
// pre-fill (CSR #C2). Fail-soft: returns 200 with status:"offline" when
// no model key is configured. The model never sees a logged copy of the
// page bytes; only counts/status are logged.
router.post(
  "/admin/inbound-faxes/:id/ocr",
  requirePermission("conversations.manage"),
  adminRateLimit({ name: "inbound_faxes.ocr", preset: "mutation" }),
  async (req, res) => {
    const params = idParam.safeParse(req.params);
    if (!params.success) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    const supabase = getSupabaseServiceRoleClient();
    const { data: row, error } = await supabase
      .schema("resupply")
      .from("inbound_faxes")
      .select("id, media_object_key, media_content_type, twilio_fax_sid")
      .eq("id", params.data.id)
      .limit(1)
      .maybeSingle();
    if (error) throw error;
    if (!row) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    if (!row.media_object_key) {
      res.status(404).json({ error: "media_not_persisted" });
      return;
    }

    // Pull the bytes from object storage (same source the preview pane
    // streams). arrayBuffer() so we can base64 them for the model.
    let bytes: Buffer;
    try {
      const file = await objectStorage.getObjectEntityFile(
        row.media_object_key,
      );
      const response = await objectStorage.downloadObject(file, 0);
      bytes = Buffer.from(await response.arrayBuffer());
    } catch (err) {
      if (err instanceof ObjectNotFoundError) {
        res.status(404).json({ error: "media_not_found" });
        return;
      }
      throw err;
    }

    const result = await extractFaxFields({
      bytes,
      contentType: row.media_content_type,
    });

    // Persist the outcome. Only the 'extracted' case carries fields; the
    // others record the status so the UI can explain why there's nothing
    // to pre-fill (and so we don't silently re-charge the model).
    const update: InboundFaxUpdate = {
      ocr_status: result.status,
      ocr_extraction: result.status === "extracted" ? result.fields : null,
      ocr_extracted_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
    const { error: upErr } = await supabase
      .schema("resupply")
      .from("inbound_faxes")
      .update(update)
      .eq("id", row.id);
    if (upErr) throw upErr;

    await logAudit({
      action: "fax.inbound.ocr",
      adminEmail: req.adminEmail ?? null,
      adminUserId: req.adminUserId ?? null,
      targetTable: "inbound_faxes",
      targetId: row.id,
      // PHI-safe: status + sid prefix only, never the extracted fields.
      metadata: {
        ocr_status: result.status,
        twilio_fax_sid: row.twilio_fax_sid,
      },
      ip: req.ip ?? null,
      userAgent: req.get("user-agent") ?? null,
    }).catch((err) => {
      logger.warn({ err }, "fax.inbound.ocr audit failed");
    });

    res.json({
      id: row.id,
      status: result.status,
      fields: result.status === "extracted" ? result.fields : null,
    });
  },
);

router.patch(
  "/admin/inbound-faxes/:id",
  requirePermission("conversations.manage"),
  adminRateLimit({ name: "inbound_faxes.update", preset: "mutation" }),
  async (req, res) => {
    const params = idParam.safeParse(req.params);
    if (!params.success) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    const parsed = patchBody.safeParse(req.body);
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
    const fields = parsed.data;
    if (Object.keys(fields).length === 0) {
      res.status(200).json({ changed: false });
      return;
    }

    const supabase = getSupabaseServiceRoleClient();
    const { data: existing, error: getErr } = await supabase
      .schema("resupply")
      .from("inbound_faxes")
      .select("id, status, attached_patient_id")
      .eq("id", params.data.id)
      .limit(1)
      .maybeSingle();
    if (getErr) throw getErr;
    if (!existing) {
      res.status(404).json({ error: "not_found" });
      return;
    }

    // Validate status transition.
    if (fields.status !== undefined && fields.status !== existing.status) {
      const allowed = VALID_TRANSITIONS[existing.status as InboundFaxStatus];
      if (!allowed.includes(fields.status)) {
        res.status(400).json({
          error: "invalid_transition",
          message: `Cannot transition fax from "${existing.status}" to "${fields.status}".`,
        });
        return;
      }
      // Attached requires a patient — either being set in this PATCH or
      // already present on the row.
      if (fields.status === "attached") {
        const willHavePatient =
          fields.attachedPatientId !== undefined
            ? fields.attachedPatientId !== null
            : existing.attached_patient_id !== null;
        if (!willHavePatient) {
          res.status(400).json({
            error: "missing_patient",
            message: "Cannot mark a fax 'attached' without linking a patient.",
          });
          return;
        }
      }
    }

    const updates: InboundFaxUpdate = {};
    if (fields.status !== undefined) updates.status = fields.status;
    if (fields.attachedPatientId !== undefined)
      updates.attached_patient_id = fields.attachedPatientId;
    if (fields.attachedProviderId !== undefined)
      updates.attached_provider_id = fields.attachedProviderId;
    if (fields.attachedPrescriptionId !== undefined)
      updates.attached_prescription_id = fields.attachedPrescriptionId;
    if (fields.attachedDocumentType !== undefined)
      updates.attached_document_type = fields.attachedDocumentType;
    if (fields.notes !== undefined) updates.notes = fields.notes;
    // Stamp the triaged_at + triaged_by_user_id on the first transition
    // out of `new`. Once stamped, leave alone — these track WHO first
    // owned the fax, not subsequent edits.
    if (
      fields.status !== undefined &&
      existing.status === "new" &&
      fields.status !== "new"
    ) {
      updates.triaged_at = new Date().toISOString();
      updates.triaged_by_user_id = req.adminUserId ?? null;
    }

    const { error: updErr } = await supabase
      .schema("resupply")
      .from("inbound_faxes")
      .update(updates)
      .eq("id", params.data.id);
    if (updErr) throw updErr;

    await logAudit({
      action: "fax.inbound.triage",
      adminEmail: req.adminEmail ?? null,
      adminUserId: req.adminUserId ?? null,
      targetTable: "inbound_faxes",
      targetId: params.data.id,
      metadata: {
        from_status: existing.status,
        to_status: fields.status ?? existing.status,
        updated_fields: Object.keys(fields),
      },
      ip: req.ip ?? null,
      userAgent: req.get("user-agent") ?? null,
    }).catch((err) => {
      logger.warn({ err }, "fax.inbound.triage audit write failed");
    });

    res.status(200).json({ id: params.data.id, changed: true });
  },
);

// GET /admin/inbound-faxes/:id/suggested-patients — saves CSRs a
// search step by surfacing patient candidates that share the fax
// sender's phone number (or its last 7 digits for fuzzy matches
// when the country code is rewritten).
router.get(
  "/admin/inbound-faxes/:id/suggested-patients",
  // Sender-phone-based patient suggestions for the CSR triage
  // workflow. Same scope as the rest of the inbound-fax surface.
  requirePermission("conversations.manage"),
  async (req, res) => {
    const params = z.object({ id: z.string().uuid() }).safeParse(req.params);
    if (!params.success) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    const supabase = getSupabaseServiceRoleClient();
    const { data: fax } = await supabase
      .schema("resupply")
      .from("inbound_faxes")
      .select("id, from_e164")
      .eq("id", params.data.id)
      .limit(1)
      .maybeSingle();
    if (!fax) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    if (!fax.from_e164) {
      res.json({ candidates: [] });
      return;
    }
    // First try exact-match, then fall back to last-7-digit
    // contains. Capping at 10 keeps the response small.
    const exact = await supabase
      .schema("resupply")
      .from("patients")
      .select("id, legal_first_name, legal_last_name, email, phone_e164")
      .eq("phone_e164", fax.from_e164)
      .limit(10);
    const candidates = (exact.data ?? []).slice();
    if (candidates.length === 0) {
      const tail = fax.from_e164.slice(-7);
      if (tail.length === 7) {
        const fuzzy = await supabase
          .schema("resupply")
          .from("patients")
          .select("id, legal_first_name, legal_last_name, email, phone_e164")
          .ilike("phone_e164", `%${tail}%`)
          .limit(10);
        candidates.push(...(fuzzy.data ?? []));
      }
    }
    res.json({
      faxFromE164: fax.from_e164,
      candidates: candidates.map((p) => ({
        id: p.id,
        legalFirstName: p.legal_first_name,
        legalLastName: p.legal_last_name,
        email: p.email,
        phoneE164: p.phone_e164,
      })),
    });
  },
);

export default router;
