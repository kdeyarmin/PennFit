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

import { and, desc, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { Router, type IRouter } from "express";
import { Readable } from "node:stream";
import { z } from "zod";

import { logAudit } from "@workspace/resupply-audit";
import {
  getDbPool,
  patientDocuments,
  patients,
} from "@workspace/resupply-db";

import { logger } from "../../lib/logger";
import {
  ObjectNotFoundError,
  ObjectStorageService,
} from "../../lib/object-storage/objectStorage";
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
 */
async function findPatientByEmail(
  email: string,
): Promise<{ id: string } | null> {
  const db = drizzle(getDbPool());
  const rows = await db
    .select({ id: patients.id })
    .from(patients)
    .where(eq(patients.email, email))
    .limit(1);
  return rows[0] ?? null;
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

    const db = drizzle(getDbPool());
    const now = new Date();
    const rows = await db
      .insert(patientDocuments)
      .values({
        patientId: patient.id,
        objectKey: normalizedPath,
        documentType: body.data.documentType,
        filename: body.data.filename,
        contentType: actualContentType,
        sizeBytes: actualSize,
        createdAt: now,
        updatedAt: now,
      })
      .returning({ id: patientDocuments.id });

    const docId = rows[0]?.id ?? "unknown";

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
    if (!patient) {
      res.json({ documents: [] });
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
      })
      .from(patientDocuments)
      .where(eq(patientDocuments.patientId, patient.id))
      .orderBy(desc(patientDocuments.createdAt))
      .limit(100);

    res.json({ documents: rows });
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
    if (!patient) {
      res.status(404).json({ error: "not_found" });
      return;
    }

    const db = drizzle(getDbPool());
    const rows = await db
      .select({
        id: patientDocuments.id,
        objectKey: patientDocuments.objectKey,
        filename: patientDocuments.filename,
        contentType: patientDocuments.contentType,
      })
      .from(patientDocuments)
      .where(
        and(
          eq(patientDocuments.id, param.data.docId),
          eq(patientDocuments.patientId, patient.id),
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
    if (!patient) {
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
          eq(patientDocuments.id, param.data.docId),
          eq(patientDocuments.patientId, patient.id),
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
        req.log.warn({ err, doc_id: doc.id }, "patient_document_delete_bytes_failed");
        bytesDeleted = "errored";
      }
    }

    await db
      .delete(patientDocuments)
      .where(eq(patientDocuments.id, doc.id));

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
