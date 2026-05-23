// /shop/me/documents — patient self-service document upload.
//
// Patients upload insurance cards, prescriptions, referrals, and
// other supporting documents from their account portal. CSRs then
// review these via the admin patient-detail Documents tab.
//
// The patient is matched to a resupply.patients row by their login
// email (same strategy as /shop/me/insights). If no patient row
// exists for that email the endpoint returns an empty list / 404 as
// appropriate; document uploads are only meaningful in the context of
// an active resupply relationship.
//
// Five endpoints:
//   POST /shop/me/documents/upload-url
//     Body: { documentType, filename, contentType, sizeBytes }.
//     Validates MIME + size, returns { uploadURL, objectPath }.
//     The presigned PUT URL is a 15-minute bearer token; its issuance
//     is audit-logged just like prescription attachments.
//   POST /shop/me/documents
//     Finalize: re-validates GCS metadata, sets ACL, inserts row.
//   GET  /shop/me/documents
//     Returns the list of the patient's uploaded documents.
//   GET  /shop/me/documents/:docId
//     Streams the bytes back to the signed-in patient.
//   DELETE /shop/me/documents/:docId
//     Best-effort deletes GCS bytes, then deletes the DB row.

import { Router, type IRouter } from "express";
import { Readable } from "node:stream";
import { z } from "zod";

import { logAudit } from "@workspace/resupply-audit";
import { getSupabaseServiceRoleClient } from "@workspace/resupply-db";

import { logger } from "../../lib/logger";
import {
  ObjectNotFoundError,
  ObjectStorageService,
} from "../../lib/object-storage/objectStorage";
import { ObjectAlreadyOwnedError } from "../../lib/object-storage/objectAcl";
import { computeRetentionUntilAt } from "../../lib/patient-documents/retention";
import { requireSignedIn } from "../../middlewares/requireSignedIn";

const MAX_DOCUMENT_BYTES = 10 * 1024 * 1024; // 10 MB

const ALLOWED_CONTENT_TYPES = new Set([
  "application/pdf",
  "image/png",
  "image/jpeg",
  "image/heic",
  "image/heif",
  "image/webp",
]);

const ALLOWED_DOCUMENT_TYPES = new Set([
  "insurance_card",
  "prescription",
  "referral",
  "eob", // Explanation of Benefits
  // Patient-uploaded sleep-study report (PSG / HSAT PDF). The
  // verifications team picks these out of the document-review
  // queue and extracts the queryable findings into the
  // sleep_studies table.
  "sleep_study",
  "other",
]);

const uploadUrlBody = z
  .object({
    documentType: z.string().trim().min(1).max(64),
    filename: z.string().trim().min(1).max(255),
    contentType: z.string().trim().min(1).max(120),
    sizeBytes: z.number().int().min(1).max(MAX_DOCUMENT_BYTES),
  })
  .strict();

const finalizeBody = z
  .object({
    documentType: z.string().trim().min(1).max(64),
    objectPath: z.string().trim().min(1).max(2048),
    filename: z.string().trim().min(1).max(255),
    contentType: z.string().trim().min(1).max(120),
    sizeBytes: z.number().int().min(1).max(MAX_DOCUMENT_BYTES),
  })
  .strict();

const docIdParam = z.object({ docId: z.string().uuid() });

const router: IRouter = Router();
const objectStorage = new ObjectStorageService();

/**
 * Resolve the resupply patient row for the signed-in shop customer by
 * email. Returns null when no patient exists for that email — callers
 * return 404 rather than leaking that a patient record exists.
 *
 * Refuses to resolve when MORE than one patient row matches the
 * email (caregivers sharing an address, recycled work email, etc.):
 * arbitrarily picking the first row would let one patient see /
 * upload / delete documents on behalf of the other. The caller
 * surfaces 409 so the patient knows to contact support to
 * disambiguate; staying silent would invisibly cross-link PHI.
 */
async function findPatientByEmail(
  email: string,
): Promise<{ id: string } | "ambiguous" | null> {
  const supabase = getSupabaseServiceRoleClient();
  const { data, error } = await supabase
    .schema("resupply")
    .from("patients")
    .select("id")
    .eq("email", email)
    .limit(2);
  if (error) throw error;
  if (!data || data.length === 0) return null;
  if (data.length > 1) return "ambiguous";
  return data[0] ?? null;
}

router.post(
  "/shop/me/documents/upload-url",
  requireSignedIn,
  async (req, res) => {
    const customerEmail = req.shopCustomerEmail;
    if (!customerEmail) {
      res.status(404).json({ error: "patient_not_found" });
      return;
    }

    const body = uploadUrlBody.safeParse(req.body);
    if (!body.success) {
      res.status(400).json({
        error: "invalid_body",
        issues: body.error.issues.map((i) => ({
          path: i.path.join("."),
          message: i.message,
        })),
      });
      return;
    }
    if (!ALLOWED_DOCUMENT_TYPES.has(body.data.documentType)) {
      res.status(400).json({
        error: "invalid_body",
        issues: [{ path: "documentType", message: "unsupported document type" }],
      });
      return;
    }
    if (!ALLOWED_CONTENT_TYPES.has(body.data.contentType)) {
      res.status(400).json({
        error: "invalid_body",
        issues: [
          {
            path: "contentType",
            message: `unsupported content type: ${body.data.contentType}`,
          },
        ],
      });
      return;
    }

    const patient = await findPatientByEmail(customerEmail);
    if (!patient) {
      res.status(404).json({ error: "patient_not_found" });
      return;
    }
    if (patient === "ambiguous") {
      // Multiple patients share this email (caregiver, recycled work
      // email, etc.). Refuse rather than arbitrarily picking the
      // first row — the SPA can surface a "contact support to link
      // your account" message.
      res.status(409).json({ error: "patient_ambiguous_email" });
      return;
    }

    try {
      const uploadURL = await objectStorage.getObjectEntityUploadURL();
      const objectPath = objectStorage.normalizeObjectEntityPath(uploadURL);

      await logAudit({
        action: "patient.document.upload_url_issued",
        adminEmail: null,
        adminUserId: null,
        targetTable: "patient_documents",
        targetId: patient.id,
        metadata: {
          customer_id: req.userCustomerId ?? null,
          document_type: body.data.documentType,
          declared_content_type: body.data.contentType,
          declared_size_bytes: body.data.sizeBytes,
        },
        ip: req.ip ?? null,
        userAgent: req.get("user-agent") ?? null,
      }).catch((err) => {
        logger.warn({ err }, "patient.document.upload_url_issued audit write failed");
      });

      res.json({ uploadURL, objectPath });
    } catch (err) {
      req.log.error({ err }, "patient_document_upload_url_failed");
      res.status(500).json({ error: "upload_url_failed" });
    }
  },
);

router.post(
  "/shop/me/documents",
  requireSignedIn,
  async (req, res) => {
    const customerEmail = req.shopCustomerEmail;
    if (!customerEmail) {
      res.status(404).json({ error: "patient_not_found" });
      return;
    }

    const body = finalizeBody.safeParse(req.body);
    if (!body.success) {
      res.status(400).json({
        error: "invalid_body",
        issues: body.error.issues.map((i) => ({
          path: i.path.join("."),
          message: i.message,
        })),
      });
      return;
    }
    if (!ALLOWED_DOCUMENT_TYPES.has(body.data.documentType)) {
      res.status(400).json({
        error: "invalid_body",
        issues: [{ path: "documentType", message: "unsupported document type" }],
      });
      return;
    }
    if (!ALLOWED_CONTENT_TYPES.has(body.data.contentType)) {
      res.status(400).json({
        error: "invalid_body",
        issues: [
          {
            path: "contentType",
            message: `unsupported content type: ${body.data.contentType}`,
          },
        ],
      });
      return;
    }

    const patient = await findPatientByEmail(customerEmail);
    if (!patient) {
      res.status(404).json({ error: "patient_not_found" });
      return;
    }
    if (patient === "ambiguous") {
      // Multiple patients share this email (caregiver, recycled work
      // email, etc.). Refuse rather than arbitrarily picking the
      // first row — the SPA can surface a "contact support to link
      // your account" message.
      res.status(409).json({ error: "patient_ambiguous_email" });
      return;
    }

    let normalizedPath: string;
    try {
      normalizedPath = await objectStorage.trySetObjectEntityAclPolicy(
        body.data.objectPath,
        {
          owner: patient.id,
          visibility: "private",
        },
      );
    } catch (err) {
      if (err instanceof ObjectNotFoundError) {
        res.status(400).json({ error: "object_missing" });
        return;
      }
      if (err instanceof ObjectAlreadyOwnedError) {
        res.status(403).json({ error: "object_already_claimed" });
        return;
      }
      req.log.warn({ err }, "patient_document_finalize_acl_failed");
      res.status(500).json({ error: "finalize_failed" });
      return;
    }

    let actualSize: number;
    let actualContentType: string;
    try {
      const objectFile = await objectStorage.getObjectEntityFile(normalizedPath);
      const [meta] = await objectFile.getMetadata();
      actualSize =
        typeof meta.size === "string"
          ? Number.parseInt(meta.size, 10)
          : Number(meta.size ?? 0);
      actualContentType =
        typeof meta.contentType === "string" ? meta.contentType : "";

      if (
        !Number.isFinite(actualSize) ||
        actualSize <= 0 ||
        actualSize > MAX_DOCUMENT_BYTES
      ) {
        await objectFile.delete().catch(() => undefined);
        res.status(400).json({ error: "object_too_large" });
        return;
      }
      if (!ALLOWED_CONTENT_TYPES.has(actualContentType)) {
        await objectFile.delete().catch(() => undefined);
        res.status(400).json({ error: "object_invalid_content_type" });
        return;
      }
    } catch (err) {
      req.log.error({ err }, "patient_document_finalize_metadata_check_failed");
      res.status(500).json({ error: "finalize_failed" });
      return;
    }

    const supabase = getSupabaseServiceRoleClient();
    const nowIso = new Date().toISOString();
    // Compute retention horizon at upload time. The nightly sweep
    // backfills legacy rows; new rows get the column populated
    // here so the catalog applies from day one.
    const retentionUntilAt = computeRetentionUntilAt({
      createdAt: new Date(nowIso),
      documentType: body.data.documentType,
    }).toISOString();
    const { data: insertedRow, error: insertErr } = await supabase
      .schema("resupply")
      .from("patient_documents")
      .insert({
        patient_id: patient.id,
        object_key: normalizedPath,
        document_type: body.data.documentType,
        filename: body.data.filename,
        content_type: actualContentType,
        size_bytes: actualSize,
        retention_until_at: retentionUntilAt,
        created_at: nowIso,
        updated_at: nowIso,
      })
      .select("id")
      .limit(1)
      .maybeSingle();
    if (insertErr) throw insertErr;
    const docId = insertedRow?.id ?? "unknown";

    await logAudit({
      action: "patient.document.upload",
      adminEmail: null,
      adminUserId: null,
      targetTable: "patient_documents",
      targetId: docId,
      metadata: {
        customer_id: req.userCustomerId ?? null,
        patient_id: patient.id,
        document_type: body.data.documentType,
        content_type: actualContentType,
        size_bytes: actualSize,
      },
      ip: req.ip ?? null,
      userAgent: req.get("user-agent") ?? null,
    }).catch((err) => {
      logger.warn({ err }, "patient.document.upload audit write failed");
    });

    res.status(201).json({ ok: true, id: docId });
  },
);

router.get(
  "/shop/me/documents",
  requireSignedIn,
  async (req, res) => {
    const customerEmail = req.shopCustomerEmail;
    if (!customerEmail) {
      res.json({ documents: [] });
      return;
    }

    const patient = await findPatientByEmail(customerEmail);
    if (!patient || patient === "ambiguous") {
      res.json({ documents: [] });
      return;
    }

    const supabase = getSupabaseServiceRoleClient();
    const { data: rows, error } = await supabase
      .schema("resupply")
      .from("patient_documents")
      .select(
        "id, document_type, filename, content_type, size_bytes, created_at, reviewed_at",
      )
      .eq("patient_id", patient.id)
      .order("created_at", { ascending: false })
      .limit(100);
    if (error) throw error;

    res.json({
      documents: (rows ?? []).map((r) => ({
        id: r.id,
        documentType: r.document_type,
        filename: r.filename,
        contentType: r.content_type,
        sizeBytes: r.size_bytes,
        createdAt: r.created_at,
        reviewedAt: r.reviewed_at,
      })),
    });
  },
);

router.get(
  "/shop/me/documents/:docId",
  requireSignedIn,
  async (req, res) => {
    const param = docIdParam.safeParse(req.params);
    if (!param.success) {
      res.status(404).json({ error: "not_found" });
      return;
    }

    const customerEmail = req.shopCustomerEmail;
    if (!customerEmail) {
      res.status(404).json({ error: "not_found" });
      return;
    }

    const patient = await findPatientByEmail(customerEmail);
    if (!patient || patient === "ambiguous") {
      res.status(404).json({ error: "not_found" });
      return;
    }

    const supabase = getSupabaseServiceRoleClient();
    const { data: doc, error } = await supabase
      .schema("resupply")
      .from("patient_documents")
      .select("id, object_key, filename, content_type")
      .eq("id", param.data.docId)
      .eq("patient_id", patient.id)
      .limit(1)
      .maybeSingle();
    if (error) throw error;
    if (!doc) {
      res.status(404).json({ error: "not_found" });
      return;
    }

    let file;
    try {
      file = await objectStorage.getObjectEntityFile(doc.object_key);
    } catch (err) {
      if (err instanceof ObjectNotFoundError) {
        res.status(404).json({ error: "not_found" });
        return;
      }
      req.log.error({ err, doc_id: doc.id }, "patient_document_lookup_failed");
      res.status(500).json({ error: "download_failed" });
      return;
    }

    await logAudit({
      action: "patient.document.download",
      adminEmail: null,
      adminUserId: null,
      targetTable: "patient_documents",
      targetId: doc.id,
      metadata: { customer_id: req.userCustomerId ?? null, patient_id: patient.id },
      ip: req.ip ?? null,
      userAgent: req.get("user-agent") ?? null,
    }).catch((err) => {
      logger.warn({ err }, "patient.document.download audit write failed");
    });

    try {
      const response = await objectStorage.downloadObject(file, 0);
      res.status(response.status);
      response.headers.forEach((value, key) => res.setHeader(key, value));
      if (doc.filename) {
        // Strip non-printable / non-ASCII for the legacy `filename="..."`
        // form, AND additionally strip the quoting characters `"` and
        // `\` so a filename like `evil"; attachment; filename="other.pdf`
        // can't break out of the quoted string and inject sibling
        // Content-Disposition fields. The RFC 5987-style
        // `filename*=UTF-8''...` value is encodeURIComponent-safe.
        const safeAscii = doc.filename
          .replace(/[^\x20-\x7E]/g, "_")
          .replace(/["\\]/g, "_");
        const encoded = encodeURIComponent(doc.filename);
        res.setHeader(
          "Content-Disposition",
          `attachment; filename="${safeAscii}"; filename*=UTF-8''${encoded}`,
        );
      }
      if (response.body) {
        const nodeStream = Readable.fromWeb(
          response.body as ReadableStream<Uint8Array>,
        );
        nodeStream.pipe(res);
      } else {
        res.end();
      }
    } catch (err) {
      req.log.error({ err, doc_id: doc.id }, "patient_document_stream_failed");
      if (!res.headersSent) {
        res.status(500).json({ error: "download_failed" });
      } else {
        res.end();
      }
    }
  },
);

router.delete(
  "/shop/me/documents/:docId",
  requireSignedIn,
  async (req, res) => {
    const param = docIdParam.safeParse(req.params);
    if (!param.success) {
      res.status(404).json({ error: "not_found" });
      return;
    }

    const customerEmail = req.shopCustomerEmail;
    if (!customerEmail) {
      res.status(404).json({ error: "not_found" });
      return;
    }

    const patient = await findPatientByEmail(customerEmail);
    if (!patient || patient === "ambiguous") {
      res.status(404).json({ error: "not_found" });
      return;
    }

    const supabase = getSupabaseServiceRoleClient();
    const { data: doc, error } = await supabase
      .schema("resupply")
      .from("patient_documents")
      .select("id, object_key")
      .eq("id", param.data.docId)
      .eq("patient_id", patient.id)
      .limit(1)
      .maybeSingle();
    if (error) throw error;
    if (!doc) {
      res.status(200).json({ ok: true }); // idempotent
      return;
    }

    let bytesDeleted: boolean | "errored";
    try {
      const objectFile = await objectStorage.getObjectEntityFile(doc.object_key);
      await objectFile.delete();
      bytesDeleted = true;
    } catch (err) {
      if (err instanceof ObjectNotFoundError) {
        bytesDeleted = true;
      } else {
        req.log.warn({ err, doc_id: doc.id }, "patient_document_delete_bytes_failed");
        bytesDeleted = "errored";
      }
    }

    const { error: deleteErr } = await supabase
      .schema("resupply")
      .from("patient_documents")
      .delete()
      .eq("id", doc.id);
    if (deleteErr) throw deleteErr;

    await logAudit({
      action: "patient.document.remove",
      adminEmail: null,
      adminUserId: null,
      targetTable: "patient_documents",
      targetId: doc.id,
      metadata: {
        customer_id: req.userCustomerId ?? null,
        patient_id: patient.id,
        bytes_deleted: bytesDeleted,
      },
      ip: req.ip ?? null,
      userAgent: req.get("user-agent") ?? null,
    }).catch((err) => {
      logger.warn({ err }, "patient.document.remove audit write failed");
    });

    res.status(200).json({ ok: true });
  },
);

export default router;
