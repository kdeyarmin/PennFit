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
import {
  ObjectNotFoundError,
  ObjectStorageService,
} from "../../lib/object-storage/objectStorage";
import {
  adminReadRateLimiter,
  adminWriteRateLimiter,
} from "../../middlewares/admin-rate-limit";
import { requireAdmin } from "../../middlewares/requireAdmin";

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
