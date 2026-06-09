// Admin-facing patient document endpoints.
//
// CSRs use these routes to view and download documents patients have
// uploaded via their account portal (insurance cards, prescriptions,
// referrals, etc.).  Admins can also delete a document if needed (e.g.
// wrong file uploaded by the patient).
//
// Five endpoints:
//   GET    /patients/:id/documents
//     Lists all documents the patient has uploaded, newest first.
//     Includes reviewedAt / reviewedByAdminId / reviewNote so the UI
//     can badge unreviewed docs and show CSR notes.
//   GET    /patients/:id/documents/:docId
//     Streams the document bytes to the admin browser. As a side-effect,
//     auto-marks the document reviewed (idempotent) so that simply
//     opening a file counts as an acknowledgement without requiring an
//     explicit button press.
//   PATCH  /patients/:id/documents/:docId/reviewed
//     Explicit mark-as-reviewed with an optional note. Sets
//     reviewed_at + reviewed_by_admin_id + review_note. Idempotent —
//     re-calling when already reviewed is a no-op (200). Audit-logged.
//   DELETE /patients/:id/documents/:docId
//     Best-effort deletes GCS bytes, then removes the DB row.

import { Router, type IRouter } from "express";
import { Readable } from "node:stream";
import { z } from "zod";

import { logAudit } from "@workspace/resupply-audit";
import {
  getSupabaseServiceRoleClient,
  type Database,
} from "@workspace/resupply-db";

import { logger } from "../../lib/logger";
import { ObjectAlreadyOwnedError } from "../../lib/object-storage/objectAcl";
import {
  ObjectNotFoundError,
  ObjectStorageService,
} from "../../lib/object-storage/objectStorage";
import { isChartDocumentType } from "../../lib/patient-documents/chart-document-types";
import { computeRetentionUntilAt } from "../../lib/patient-documents/retention";
import {
  lookupTrackingByCode,
  markReturnedAndCascade,
} from "../../lib/signature-tracking/service";
import {
  adminReadRateLimiter,
  adminWriteRateLimiter,
} from "../../middlewares/admin-rate-limit";
import {
  requireAdmin,
  requirePermission,
} from "../../middlewares/requireAdmin";

type PatientDocumentUpdate =
  Database["resupply"]["Tables"]["patient_documents"]["Update"];

const idsParam = z.object({
  id: z.string().uuid(),
  docId: z.string().uuid(),
});

const patientIdParam = z.object({ id: z.string().uuid() });

const reviewedBody = z
  .object({
    note: z.string().trim().max(500).optional(),
  })
  .strict();

// ── Scan / upload to chart ─────────────────────────────────────────
const MAX_DOCUMENT_BYTES = 10 * 1024 * 1024; // 10 MB

// Same allowlist as the patient portal (routes/shop/me-documents.ts):
// scanned pages come back as images, generated paperwork as PDF.
const ALLOWED_CONTENT_TYPES = new Set([
  "application/pdf",
  "image/png",
  "image/jpeg",
  "image/heic",
  "image/heif",
  "image/webp",
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
    // When the scan IS a signed copy coming back, the CSR can pass the
    // tracking code printed (as a barcode) on the document we sent out;
    // we mark that signature returned and advance its source document.
    signatureTrackingCode: z.string().trim().min(3).max(64).optional(),
  })
  .strict();

function invalidDocType(res: import("express").Response): void {
  res.status(400).json({
    error: "invalid_body",
    issues: [{ path: "documentType", message: "unsupported document type" }],
  });
}

function invalidContentType(res: import("express").Response, ct: string): void {
  res.status(400).json({
    error: "invalid_body",
    issues: [
      { path: "contentType", message: `unsupported content type: ${ct}` },
    ],
  });
}

async function patientExists(id: string): Promise<boolean> {
  const supabase = getSupabaseServiceRoleClient();
  const { data, error } = await supabase
    .schema("resupply")
    .from("patients")
    .select("id")
    .eq("id", id)
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  return data !== null;
}

const router: IRouter = Router();
const objectStorage = new ObjectStorageService();

/**
 * Idempotent helper: marks a document reviewed if not already.
 * Uses an atomic conditional UPDATE (WHERE reviewed_at IS NULL) so two
 * concurrent CSR actions cannot both "win" and overwrite each other's
 * reviewer/timestamp. Returns { found, updated } where updated=false
 * means the row was already reviewed (or not found).
 */
async function markReviewedIfNeeded(
  docId: string,
  patientId: string,
  adminUserId: string | null,
  note?: string,
): Promise<{ found: boolean; updated: boolean }> {
  const supabase = getSupabaseServiceRoleClient();
  const nowIso = new Date().toISOString();

  const updates: PatientDocumentUpdate = {
    reviewed_at: nowIso,
    reviewed_by_admin_id: adminUserId ?? null,
    updated_at: nowIso,
  };
  if (note !== undefined) updates.review_note = note;

  const { data: touched, error: updateErr } = await supabase
    .schema("resupply")
    .from("patient_documents")
    .update(updates)
    .eq("id", docId)
    .eq("patient_id", patientId)
    .is("reviewed_at", null)
    .select("id");
  if (updateErr) throw updateErr;
  if ((touched ?? []).length > 0) return { found: true, updated: true };

  // 0 rows updated — either already reviewed or doesn't exist.
  const { data: existing, error: existsErr } = await supabase
    .schema("resupply")
    .from("patient_documents")
    .select("id")
    .eq("id", docId)
    .eq("patient_id", patientId)
    .limit(1)
    .maybeSingle();
  if (existsErr) throw existsErr;

  return { found: existing !== null, updated: false };
}

router.get(
  "/patients/:id/documents",
  adminReadRateLimiter,
  requireAdmin,
  async (req, res) => {
    const param = patientIdParam.safeParse(req.params);
    if (!param.success) {
      res.status(404).json({ error: "not_found" });
      return;
    }

    const supabase = getSupabaseServiceRoleClient();
    const { data: rows, error } = await supabase
      .schema("resupply")
      .from("patient_documents")
      .select(
        "id, document_type, filename, content_type, size_bytes, created_at, reviewed_at, reviewed_by_admin_id, review_note",
      )
      .eq("patient_id", param.data.id)
      .order("created_at", { ascending: false });
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
        reviewedByAdminId: r.reviewed_by_admin_id,
        reviewNote: r.review_note,
      })),
    });
  },
);

// Step 1 of a chart upload: hand the browser a short-lived presigned PUT
// URL. The SPA PUTs the file straight to object storage, then calls the
// finalize endpoint below. Mirrors the patient-portal upload contract
// (routes/shop/me-documents.ts) but admin-gated and patient-targeted.
router.post(
  "/patients/:id/documents/upload-url",
  adminWriteRateLimiter,
  requirePermission("patients.update"),
  async (req, res) => {
    const param = patientIdParam.safeParse(req.params);
    if (!param.success) {
      res.status(404).json({ error: "not_found" });
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
    if (!isChartDocumentType(body.data.documentType)) {
      invalidDocType(res);
      return;
    }
    if (!ALLOWED_CONTENT_TYPES.has(body.data.contentType)) {
      invalidContentType(res, body.data.contentType);
      return;
    }
    if (!(await patientExists(param.data.id))) {
      res.status(404).json({ error: "patient_not_found" });
      return;
    }

    try {
      const uploadURL = await objectStorage.getObjectEntityUploadURL();
      const objectPath = objectStorage.normalizeObjectEntityPath(uploadURL);
      await logAudit({
        action: "patient.document.admin_upload_url_issued",
        adminEmail: req.adminEmail ?? null,
        adminUserId: req.adminUserId ?? null,
        targetTable: "patient_documents",
        targetId: param.data.id,
        metadata: {
          patient_id: param.data.id,
          document_type: body.data.documentType,
          declared_content_type: body.data.contentType,
          declared_size_bytes: body.data.sizeBytes,
        },
        ip: req.ip ?? null,
        userAgent: req.get("user-agent") ?? null,
      }).catch((err) => {
        logger.warn({ err }, "patient.document.admin_upload_url audit failed");
      });
      res.json({ uploadURL, objectPath });
    } catch (err) {
      req.log.error({ err }, "admin_patient_document_upload_url_failed");
      res.status(500).json({ error: "upload_url_failed" });
    }
  },
);

// Step 2 of a chart upload: claim the uploaded object for the patient,
// validate its real size/type, insert the patient_documents row (tagged
// + retention-stamped), and — when a signature tracking code is supplied
// — mark that outstanding signature returned & signed.
router.post(
  "/patients/:id/documents",
  adminWriteRateLimiter,
  requirePermission("patients.update"),
  async (req, res) => {
    const param = patientIdParam.safeParse(req.params);
    if (!param.success) {
      res.status(404).json({ error: "not_found" });
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
    if (!isChartDocumentType(body.data.documentType)) {
      invalidDocType(res);
      return;
    }
    if (!ALLOWED_CONTENT_TYPES.has(body.data.contentType)) {
      invalidContentType(res, body.data.contentType);
      return;
    }
    if (!(await patientExists(param.data.id))) {
      res.status(404).json({ error: "patient_not_found" });
      return;
    }

    let normalizedPath: string;
    try {
      normalizedPath = await objectStorage.trySetObjectEntityAclPolicy(
        body.data.objectPath,
        { owner: param.data.id, visibility: "private" },
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
      req.log.warn({ err }, "admin_patient_document_finalize_acl_failed");
      res.status(500).json({ error: "finalize_failed" });
      return;
    }

    let actualSize: number;
    let actualContentType: string;
    try {
      const objectFile =
        await objectStorage.getObjectEntityFile(normalizedPath);
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
      req.log.error({ err }, "admin_patient_document_finalize_metadata_failed");
      res.status(500).json({ error: "finalize_failed" });
      return;
    }

    const supabase = getSupabaseServiceRoleClient();
    const nowIso = new Date().toISOString();
    const retentionUntilAt = computeRetentionUntilAt({
      createdAt: new Date(nowIso),
      documentType: body.data.documentType,
    }).toISOString();
    const { data: insertedRow, error: insertErr } = await supabase
      .schema("resupply")
      .from("patient_documents")
      .insert({
        patient_id: param.data.id,
        object_key: normalizedPath,
        document_type: body.data.documentType,
        filename: body.data.filename,
        content_type: actualContentType,
        size_bytes: actualSize,
        // Staff-uploaded documents are reviewed by definition — the CSR
        // is looking at it as they file it — so stamp them reviewed to
        // keep them out of the unreviewed queue.
        reviewed_at: nowIso,
        reviewed_by_admin_id: req.adminUserId ?? null,
        retention_until_at: retentionUntilAt,
        created_at: nowIso,
        updated_at: nowIso,
      })
      .select("id")
      .limit(1)
      .maybeSingle();
    if (insertErr) throw insertErr;
    const docId = insertedRow?.id ?? "unknown";

    // Optional: this scan is the signed return for a tracked document.
    let signatureMarkedReturned = false;
    if (body.data.signatureTrackingCode) {
      const tracking = await lookupTrackingByCode(
        supabase,
        body.data.signatureTrackingCode,
      ).catch(() => null);
      if (tracking && tracking.status === "awaiting_signature") {
        await markReturnedAndCascade(supabase, tracking).catch((err) => {
          logger.warn({ err }, "admin_patient_document.mark_returned failed");
        });
        signatureMarkedReturned = true;
      }
    }

    await logAudit({
      action: "patient.document.admin_upload",
      adminEmail: req.adminEmail ?? null,
      adminUserId: req.adminUserId ?? null,
      targetTable: "patient_documents",
      targetId: docId,
      metadata: {
        patient_id: param.data.id,
        document_type: body.data.documentType,
        content_type: actualContentType,
        size_bytes: actualSize,
        signature_marked_returned: signatureMarkedReturned,
      },
      ip: req.ip ?? null,
      userAgent: req.get("user-agent") ?? null,
    }).catch((err) => {
      logger.warn({ err }, "patient.document.admin_upload audit write failed");
    });

    res.status(201).json({ ok: true, id: docId, signatureMarkedReturned });
  },
);

router.get(
  "/patients/:id/documents/:docId",
  adminReadRateLimiter,
  requireAdmin,
  async (req, res) => {
    const ids = idsParam.safeParse(req.params);
    if (!ids.success) {
      res.status(404).json({ error: "not_found" });
      return;
    }

    const supabase = getSupabaseServiceRoleClient();
    const { data: doc, error } = await supabase
      .schema("resupply")
      .from("patient_documents")
      .select("id, object_key, filename, reviewed_at")
      .eq("id", ids.data.docId)
      .eq("patient_id", ids.data.id)
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
      req.log.error(
        { err, doc_id: doc.id },
        "admin_patient_document_lookup_failed",
      );
      res.status(500).json({ error: "download_failed" });
      return;
    }

    // Auto-mark reviewed on download. Best-effort: failure never blocks the stream.
    void markReviewedIfNeeded(
      doc.id,
      ids.data.id,
      req.adminUserId ?? null,
    ).catch((err) => {
      logger.warn(
        { err, doc_id: doc.id },
        "admin_patient_document_auto_review_failed",
      );
    });

    await logAudit({
      action: "patient.document.admin_download",
      adminEmail: req.adminEmail ?? null,
      adminUserId: req.adminUserId ?? null,
      targetTable: "patient_documents",
      targetId: doc.id,
      metadata: { patient_id: ids.data.id },
      ip: req.ip ?? null,
      userAgent: req.get("user-agent") ?? null,
    }).catch((err) => {
      logger.warn(
        { err },
        "patient.document.admin_download audit write failed",
      );
    });

    try {
      const response = await objectStorage.downloadObject(file, 0);
      res.status(response.status);
      response.headers.forEach((value, key) => res.setHeader(key, value));
      if (doc.filename) {
        // Strip non-printable / non-ASCII AND the quoting chars `"`
        // and `\` so a filename like `evil"; attachment; filename="
        // can't break out of the quoted string. encodeURIComponent
        // handles the RFC 5987 form.
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
      req.log.error(
        { err, doc_id: doc.id },
        "admin_patient_document_stream_failed",
      );
      if (!res.headersSent) {
        res.status(500).json({ error: "download_failed" });
      } else {
        res.end();
      }
    }
  },
);

router.patch(
  "/patients/:id/documents/:docId/reviewed",
  adminWriteRateLimiter,
  requireAdmin,
  async (req, res) => {
    const ids = idsParam.safeParse(req.params);
    if (!ids.success) {
      res.status(404).json({ error: "not_found" });
      return;
    }

    const body = reviewedBody.safeParse(req.body ?? {});
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

    const { found, updated } = await markReviewedIfNeeded(
      ids.data.docId,
      ids.data.id,
      req.adminUserId ?? null,
      body.data.note,
    );

    if (!found) {
      res.status(404).json({ error: "not_found" });
      return;
    }

    if (!updated) {
      // The row is already reviewed by an earlier CSR. We deliberately
      // do NOT silently discard the new note — that produced a 200
      // response that LOOKED successful while the reviewer's note was
      // dropped. Surface 409 so the SPA can render an "already
      // reviewed; add a comment instead" UX. Future change: persist
      // follow-up notes via a separate notes-history table.
      res.status(409).json({
        ok: false,
        error: "already_reviewed",
        message:
          "This document was already reviewed. Add a comment via the notes panel instead.",
      });
      return;
    }

    await logAudit({
      action: "patient.document.admin_reviewed",
      adminEmail: req.adminEmail ?? null,
      adminUserId: req.adminUserId ?? null,
      targetTable: "patient_documents",
      targetId: ids.data.docId,
      metadata: {
        patient_id: ids.data.id,
        has_note: body.data.note !== undefined && body.data.note.length > 0,
      },
      ip: req.ip ?? null,
      userAgent: req.get("user-agent") ?? null,
    }).catch((err) => {
      logger.warn(
        { err },
        "patient.document.admin_reviewed audit write failed",
      );
    });

    res.status(200).json({ ok: true, alreadyReviewed: false });
  },
);

router.delete(
  "/patients/:id/documents/:docId",
  adminWriteRateLimiter,
  requireAdmin,
  async (req, res) => {
    const ids = idsParam.safeParse(req.params);
    if (!ids.success) {
      res.status(404).json({ error: "not_found" });
      return;
    }

    const supabase = getSupabaseServiceRoleClient();
    const { data: doc, error } = await supabase
      .schema("resupply")
      .from("patient_documents")
      .select("id, object_key")
      .eq("id", ids.data.docId)
      .eq("patient_id", ids.data.id)
      .limit(1)
      .maybeSingle();
    if (error) throw error;
    if (!doc) {
      res.status(200).json({ ok: true }); // idempotent
      return;
    }

    let bytesDeleted: boolean | "errored";
    try {
      const objectFile = await objectStorage.getObjectEntityFile(
        doc.object_key,
      );
      await objectFile.delete();
      bytesDeleted = true;
    } catch (err) {
      if (err instanceof ObjectNotFoundError) {
        bytesDeleted = true;
      } else {
        req.log.warn(
          { err, doc_id: doc.id },
          "admin_patient_document_delete_bytes_failed",
        );
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
      action: "patient.document.admin_remove",
      adminEmail: req.adminEmail ?? null,
      adminUserId: req.adminUserId ?? null,
      targetTable: "patient_documents",
      targetId: doc.id,
      metadata: {
        patient_id: ids.data.id,
        bytes_deleted: bytesDeleted,
      },
      ip: req.ip ?? null,
      userAgent: req.get("user-agent") ?? null,
    }).catch((err) => {
      logger.warn({ err }, "patient.document.admin_remove audit write failed");
    });

    res.status(200).json({ ok: true });
  },
);

export default router;
