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

import { and, desc, eq, isNull } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { Router, type IRouter } from "express";
import { Readable } from "node:stream";
import { z } from "zod";

import { logAudit } from "@workspace/resupply-audit";
import { getDbPool, patientDocuments } from "@workspace/resupply-db";

import { logger } from "../../lib/logger";
import {
  ObjectNotFoundError,
  ObjectStorageService,
} from "../../lib/object-storage/objectStorage";
import { requireAdmin } from "../../middlewares/requireAdmin";

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
  const db = drizzle(getDbPool());
  const now = new Date();

  const touched = await db
    .update(patientDocuments)
    .set({
      reviewedAt: now,
      reviewedByAdminId: adminUserId ?? null,
      ...(note !== undefined ? { reviewNote: note } : {}),
      updatedAt: now,
    })
    .where(
      and(
        eq(patientDocuments.id, docId),
        eq(patientDocuments.patientId, patientId),
        isNull(patientDocuments.reviewedAt),
      ),
    )
    .returning({ id: patientDocuments.id });

  if (touched.length > 0) return { found: true, updated: true };

  // 0 rows updated — either already reviewed or doesn't exist.
  const exists = await db
    .select({ id: patientDocuments.id })
    .from(patientDocuments)
    .where(
      and(
        eq(patientDocuments.id, docId),
        eq(patientDocuments.patientId, patientId),
      ),
    )
    .limit(1);

  return { found: exists.length > 0, updated: false };
}

router.get("/patients/:id/documents", requireAdmin, async (req, res) => {
  const param = patientIdParam.safeParse(req.params);
  if (!param.success) {
    res.status(404).json({ error: "not_found" });
    return;
  }

  const db = drizzle(getDbPool());
  const rows = await db
    .select({
      id: patientDocuments.id,
      documentType: patientDocuments.documentType,
      filename: patientDocuments.filename,
      contentType: patientDocuments.contentType,
      sizeBytes: patientDocuments.sizeBytes,
      createdAt: patientDocuments.createdAt,
      reviewedAt: patientDocuments.reviewedAt,
      reviewedByAdminId: patientDocuments.reviewedByAdminId,
      reviewNote: patientDocuments.reviewNote,
    })
    .from(patientDocuments)
    .where(eq(patientDocuments.patientId, param.data.id))
    .orderBy(desc(patientDocuments.createdAt));

  res.json({ documents: rows });
});

router.get(
  "/patients/:id/documents/:docId",
  requireAdmin,
  async (req, res) => {
    const ids = idsParam.safeParse(req.params);
    if (!ids.success) {
      res.status(404).json({ error: "not_found" });
      return;
    }

    const db = drizzle(getDbPool());
    const rows = await db
      .select({
        id: patientDocuments.id,
        objectKey: patientDocuments.objectKey,
        filename: patientDocuments.filename,
        reviewedAt: patientDocuments.reviewedAt,
      })
      .from(patientDocuments)
      .where(
        and(
          eq(patientDocuments.id, ids.data.docId),
          eq(patientDocuments.patientId, ids.data.id),
        ),
      )
      .limit(1);

    const doc = rows[0];
    if (!doc) {
      res.status(404).json({ error: "not_found" });
      return;
    }

    let file;
    try {
      file = await objectStorage.getObjectEntityFile(doc.objectKey);
    } catch (err) {
      if (err instanceof ObjectNotFoundError) {
        res.status(404).json({ error: "not_found" });
        return;
      }
      req.log.error({ err, doc_id: doc.id }, "admin_patient_document_lookup_failed");
      res.status(500).json({ error: "download_failed" });
      return;
    }

    // Auto-mark reviewed on download. Best-effort: failure never blocks the stream.
    void markReviewedIfNeeded(doc.id, ids.data.id, req.adminUserId ?? null).catch(
      (err) => {
        logger.warn({ err, doc_id: doc.id }, "admin_patient_document_auto_review_failed");
      },
    );

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
      logger.warn({ err }, "patient.document.admin_download audit write failed");
    });

    try {
      const response = await objectStorage.downloadObject(file, 0);
      res.status(response.status);
      response.headers.forEach((value, key) => res.setHeader(key, value));
      if (doc.filename) {
        const safeAscii = doc.filename.replace(/[^\x20-\x7E]/g, "_");
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
      req.log.error({ err, doc_id: doc.id }, "admin_patient_document_stream_failed");
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
      res.status(200).json({ ok: true, alreadyReviewed: true });
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
      logger.warn({ err }, "patient.document.admin_reviewed audit write failed");
    });

    res.status(200).json({ ok: true, alreadyReviewed: false });
  },
);

router.delete(
  "/patients/:id/documents/:docId",
  requireAdmin,
  async (req, res) => {
    const ids = idsParam.safeParse(req.params);
    if (!ids.success) {
      res.status(404).json({ error: "not_found" });
      return;
    }

    const db = drizzle(getDbPool());
    const rows = await db
      .select({
        id: patientDocuments.id,
        objectKey: patientDocuments.objectKey,
      })
      .from(patientDocuments)
      .where(
        and(
          eq(patientDocuments.id, ids.data.docId),
          eq(patientDocuments.patientId, ids.data.id),
        ),
      )
      .limit(1);

    const doc = rows[0];
    if (!doc) {
      res.status(200).json({ ok: true }); // idempotent
      return;
    }

    let bytesDeleted: boolean | "errored";
    try {
      const objectFile = await objectStorage.getObjectEntityFile(doc.objectKey);
      await objectFile.delete();
      bytesDeleted = true;
    } catch (err) {
      if (err instanceof ObjectNotFoundError) {
        bytesDeleted = true;
      } else {
        req.log.warn({ err, doc_id: doc.id }, "admin_patient_document_delete_bytes_failed");
        bytesDeleted = "errored";
      }
    }

    await db
      .delete(patientDocuments)
      .where(eq(patientDocuments.id, doc.id));

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
