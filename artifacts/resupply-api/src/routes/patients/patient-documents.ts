// Admin-facing patient document endpoints.
//
// CSRs use these routes to view and download documents patients have
// uploaded via their account portal (insurance cards, prescriptions,
// referrals, etc.).  Admins can also delete a document if needed (e.g.
// wrong file uploaded by the patient).
//
// Four endpoints:
//   GET    /patients/:id/documents
//     Lists all documents the patient has uploaded, newest first.
//     Includes reviewedAt / reviewedByAdminId so the UI can badge
//     unreviewed docs.
//   GET    /patients/:id/documents/:docId
//     Streams the document bytes to the admin browser.
//   PATCH  /patients/:id/documents/:docId/reviewed
//     Idempotent mark-as-reviewed: sets reviewed_at + reviewed_by_admin_id
//     when the CSR opens / acknowledges the document. Re-calling when
//     already reviewed is a no-op (200). Audit-logged.
//   DELETE /patients/:id/documents/:docId
//     Best-effort deletes GCS bytes, then removes the DB row.

import { and, desc, eq } from "drizzle-orm";
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

const router: IRouter = Router();
const objectStorage = new ObjectStorageService();

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

    const db = drizzle(getDbPool());
    const rows = await db
      .select({
        id: patientDocuments.id,
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

    // Idempotent: already reviewed, nothing to do.
    if (doc.reviewedAt !== null) {
      res.status(200).json({ ok: true, alreadyReviewed: true });
      return;
    }

    const now = new Date();
    await db
      .update(patientDocuments)
      .set({
        reviewedAt: now,
        reviewedByAdminId: req.adminUserId ?? null,
        updatedAt: now,
      })
      .where(eq(patientDocuments.id, doc.id));

    await logAudit({
      action: "patient.document.admin_reviewed",
      adminEmail: req.adminEmail ?? null,
      adminUserId: req.adminUserId ?? null,
      targetTable: "patient_documents",
      targetId: doc.id,
      metadata: { patient_id: ids.data.id },
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
