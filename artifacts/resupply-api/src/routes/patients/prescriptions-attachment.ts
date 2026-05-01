// Prescription document attachments — admin-only, prescription-scoped
// (W4 T-C4).
//
// Why a dedicated route group rather than a generic /storage/uploads
// surface:
//   The generic flow shipped in the object-storage skill assumes the
//   client knows what an "object path" is and finalises ACL on its
//   own. For PHI scans we want exactly the opposite: the admin UI
//   talks only about prescription IDs, the API owns every detail of
//   GCS path layout and ACL, and there is NO upload endpoint that is
//   not bound to a specific prescription. This guarantees:
//     * No orphaned uploads can ever reach the bucket from the
//       dashboard (every upload is paired with a finalize call that
//       writes the row, or it's garbage that no one can find).
//     * MIME-type and size limits are enforced server-side before
//       the presigned URL ever leaves the API.
//     * Every read/write is audit-logged with the prescription id.
//
// Four endpoints:
//   POST /patients/:id/prescriptions/:rxId/attachment/upload-url
//     -> { uploadURL, objectPath } valid for 15 minutes. The
//     issuance of this presigned PUT capability is itself audit-
//     logged; without that the URL is a bearer token whose use is
//     invisible to the API once it leaves.
//   POST /patients/:id/prescriptions/:rxId/attachment
//     Body: { objectPath, filename, contentType, sizeBytes }.
//     Verifies the object exists in GCS, RE-VALIDATES actual size
//     and content-type against the bucket's metadata (rejects and
//     deletes on mismatch — the client-declared values from
//     /upload-url are advisory only), sets ACL
//     {owner: adminUserId, visibility:"private"}, persists the
//     GCS-confirmed metadata. If a previous attachment existed on
//     this prescription, the old object's bytes are deleted best-
//     effort after the row is updated.
//   GET  /patients/:id/prescriptions/:rxId/attachment
//     Streams the bytes back to an authenticated admin.
//   DELETE /patients/:id/prescriptions/:rxId/attachment
//     Best-effort deletes the GCS object, then nulls the row's
//     attachment columns. The bucket-side delete is best-effort:
//     if it fails (transient GCS error) the row still clears so
//     the UI doesn't get stuck advertising a phantom file, and
//     the audit entry records that bytes were not removed so a
//     future sweep can reconcile.
//
// PHI retention note: one orphan source remains by design — a
// presigned PUT URL that the browser uses but where /finalize is
// never called (browser closed mid-upload, network drop). Those
// objects accumulate in the bucket with no DB reference and need
// a periodic sweep job (see docs/resupply/PHI-RETENTION.md). Not
// built yet because finalize fires immediately after PUT in the
// dashboard flow and expected volume is single-digits/week.

import { and, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { Router, type IRouter } from "express";
import { Readable } from "node:stream";
import { z } from "zod";

import { logAudit } from "@workspace/resupply-audit";
import { getDbPool, prescriptions } from "@workspace/resupply-db";

import { logger } from "../../lib/logger";
import {
  ObjectNotFoundError,
  ObjectStorageService,
} from "../../lib/object-storage/objectStorage";
import { requireAdmin } from "../../middlewares/requireAdmin";

// 10 MB. Big enough for a multi-page wet-signed Rx PDF; small enough
// that an accidental video upload is rejected before it leaves the
// browser. Mirrored on the dashboard's <input> accept attribute.
const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;

// Allowlist — prescription scans should only be PDFs or document
// images. We deliberately exclude HTML/JS/etc to keep the bucket
// from becoming a vector for stored XSS even if a future serving
// path forgets to set Content-Disposition.
const ALLOWED_CONTENT_TYPES = new Set([
  "application/pdf",
  "image/png",
  "image/jpeg",
  "image/heic",
  "image/heif",
  "image/webp",
]);

const idsParam = z.object({
  id: z.string().uuid(),
  rxId: z.string().uuid(),
});

const uploadUrlBody = z
  .object({
    filename: z.string().trim().min(1).max(255),
    contentType: z.string().trim().min(1).max(120),
    sizeBytes: z.number().int().min(1).max(MAX_ATTACHMENT_BYTES),
  })
  .strict();

const finalizeBody = z
  .object({
    objectPath: z.string().trim().min(1).max(2048),
    filename: z.string().trim().min(1).max(255),
    contentType: z.string().trim().min(1).max(120),
    sizeBytes: z.number().int().min(1).max(MAX_ATTACHMENT_BYTES),
  })
  .strict();

const router: IRouter = Router();
const objectStorage = new ObjectStorageService();

/**
 * Look up the prescription row, verifying it belongs to the patient
 * named in the URL. Returns the row or null. Centralised so every
 * endpoint in this file gets the same patient-scoping check; without
 * this wrapper a malformed URL of the form
 * /patients/<wrongId>/prescriptions/<rxId> would succeed and let one
 * patient's UI accidentally enumerate another's documents.
 */
async function findPrescriptionForPatient(
  patientId: string,
  rxId: string,
): Promise<{
  id: string;
  attachmentObjectKey: string | null;
  attachmentFilename: string | null;
  attachmentContentType: string | null;
} | null> {
  const db = drizzle(getDbPool());
  const rows = await db
    .select({
      id: prescriptions.id,
      attachmentObjectKey: prescriptions.attachmentObjectKey,
      attachmentFilename: prescriptions.attachmentFilename,
      attachmentContentType: prescriptions.attachmentContentType,
    })
    .from(prescriptions)
    .where(
      and(eq(prescriptions.id, rxId), eq(prescriptions.patientId, patientId)),
    )
    .limit(1);
  return rows[0] ?? null;
}

router.post(
  "/patients/:id/prescriptions/:rxId/attachment/upload-url",
  requireAdmin,
  async (req, res) => {
    const ids = idsParam.safeParse(req.params);
    if (!ids.success) {
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

    const rx = await findPrescriptionForPatient(ids.data.id, ids.data.rxId);
    if (!rx) {
      res.status(404).json({ error: "not_found" });
      return;
    }

    try {
      const uploadURL = await objectStorage.getObjectEntityUploadURL();
      const objectPath = objectStorage.normalizeObjectEntityPath(uploadURL);

      // Audit the issuance of an upload capability — even though
      // no bytes have been uploaded yet, a presigned PUT URL is a
      // bearer token that can write to the bucket. Recording the
      // request gives us forensic visibility if a URL is later
      // abused (e.g. leaked to a third party). The actual byte
      // upload to GCS itself is outside our audit horizon (it
      // hits Google directly), so this is the last server-visible
      // checkpoint before the upload completes.
      await logAudit({
        action: "patient.prescription.attachment.upload_url_issued",
        adminEmail: req.adminEmail ?? null,
        adminUserId: req.adminUserId ?? null,
        targetTable: "prescriptions",
        targetId: rx.id,
        metadata: {
          patient_id: ids.data.id,
          declared_content_type: body.data.contentType,
          declared_size_bytes: body.data.sizeBytes,
        },
        ip: req.ip ?? null,
        userAgent: req.get("user-agent") ?? null,
      }).catch((err) => {
        logger.warn(
          { err },
          "patient.prescription.attachment.upload_url_issued audit write failed",
        );
      });

      res.json({ uploadURL, objectPath });
    } catch (err) {
      req.log.error(
        { err, prescription_id: rx.id },
        "prescription_attachment_upload_url_failed",
      );
      res.status(500).json({ error: "upload_url_failed" });
    }
  },
);

router.post(
  "/patients/:id/prescriptions/:rxId/attachment",
  requireAdmin,
  async (req, res) => {
    const ids = idsParam.safeParse(req.params);
    if (!ids.success) {
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

    const rx = await findPrescriptionForPatient(ids.data.id, ids.data.rxId);
    if (!rx) {
      res.status(404).json({ error: "not_found" });
      return;
    }

    // Set the ACL with the admin's clerk id as owner. Even though
    // download is currently gated only by `requireAdmin` (anyone on
    // the allowlist can read any prescription scan, mirroring the
    // existing rule for `details` PHI), recording an owner gives us
    // a future-proof hook to tighten access later without a data
    // migration.
    let normalizedPath: string;
    try {
      normalizedPath = await objectStorage.trySetObjectEntityAclPolicy(
        body.data.objectPath,
        {
          owner: req.adminUserId ?? "unknown",
          visibility: "private",
        },
      );
    } catch (err) {
      req.log.warn(
        { err, prescription_id: rx.id },
        "prescription_attachment_finalize_acl_failed",
      );
      // ObjectNotFoundError thrown via setObjectEntityAclPolicy means
      // the client never actually PUT the bytes. Surface as 400 so
      // the UI can prompt the user to retry.
      if (err instanceof ObjectNotFoundError) {
        res.status(400).json({ error: "object_missing" });
        return;
      }
      res.status(500).json({ error: "finalize_failed" });
      return;
    }

    // Server-side verification of what was ACTUALLY uploaded.
    // The pre-flight `/upload-url` step trusts client-declared
    // size/MIME to pick a presigned URL, but the URL itself is a
    // generic PUT — a tampered or non-browser client could
    // upload bytes that don't match the declared metadata. We
    // re-read GCS' truth here and reject before persisting the
    // row, so the database never advertises a content-type we
    // didn't actually accept.
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
        actualSize > MAX_ATTACHMENT_BYTES
      ) {
        req.log.warn(
          {
            prescription_id: rx.id,
            actual_size: actualSize,
            declared_size: body.data.sizeBytes,
          },
          "prescription_attachment_finalize_rejected_size",
        );
        await objectFile.delete().catch(() => undefined);
        res.status(400).json({ error: "object_too_large" });
        return;
      }
      if (!ALLOWED_CONTENT_TYPES.has(actualContentType)) {
        req.log.warn(
          {
            prescription_id: rx.id,
            actual_content_type: actualContentType,
          },
          "prescription_attachment_finalize_rejected_content_type",
        );
        await objectFile.delete().catch(() => undefined);
        res.status(400).json({ error: "object_invalid_content_type" });
        return;
      }
    } catch (err) {
      req.log.error(
        { err, prescription_id: rx.id },
        "prescription_attachment_finalize_metadata_check_failed",
      );
      res.status(500).json({ error: "finalize_failed" });
      return;
    }

    // Capture BEFORE the row update so the cleanup step has the old
    // path. Reading from rx (loaded earlier in the handler) is fine
    // because nothing in this handler has mutated the row yet.
    const previousObjectKey = rx.attachmentObjectKey;

    const db = drizzle(getDbPool());
    const now = new Date();
    await db
      .update(prescriptions)
      .set({
        attachmentObjectKey: normalizedPath,
        attachmentFilename: body.data.filename,
        // Persist the GCS-CONFIRMED content-type and size, not the
        // client-declared values. If those agree (the normal case)
        // this is a no-op; if they disagree, the database is the
        // source of truth for what's actually in the bucket.
        attachmentContentType: actualContentType,
        attachmentSizeBytes: actualSize,
        attachmentUploadedAt: now,
        updatedAt: now,
      })
      .where(eq(prescriptions.id, rx.id));

    // Replacement cleanup: the row now points at the NEW object, so
    // delete the bytes of the OLD object. Best-effort — if GCS is
    // having a bad day we'd rather complete the upload (the row is
    // already pointing at the new object) and leave a single orphan
    // for the future sweep job than fail an otherwise-successful
    // user action. Capture the outcome in the audit row so we can
    // reconcile later.
    let previousObjectDeleted: boolean | "errored" = false;
    if (previousObjectKey && previousObjectKey !== normalizedPath) {
      try {
        const previousFile =
          await objectStorage.getObjectEntityFile(previousObjectKey);
        await previousFile.delete();
        previousObjectDeleted = true;
      } catch (err) {
        if (err instanceof ObjectNotFoundError) {
          // The row pointed at an object that wasn't in the bucket
          // anymore (manual cleanup, prior failed write, etc).
          // Treat as success — there's nothing to delete.
          previousObjectDeleted = true;
        } else {
          req.log.warn(
            { err, previous_object_key: previousObjectKey },
            "prescription_attachment_replace_cleanup_failed",
          );
          previousObjectDeleted = "errored";
        }
      }
    }

    await logAudit({
      action: "patient.prescription.attachment.upload",
      adminEmail: req.adminEmail ?? null,
      adminUserId: req.adminUserId ?? null,
      targetTable: "prescriptions",
      targetId: rx.id,
      metadata: {
        patient_id: ids.data.id,
        // Filename can contain PHI (e.g. "Smith-John-Rx.pdf"); the
        // audit helper's denylist already strips obvious PHI keys
        // but we explicitly omit the filename here to be safe and
        // record only the bounded technical metadata.
        content_type: actualContentType,
        size_bytes: actualSize,
        replaced_existing: previousObjectKey !== null,
        // Record whether the OLD object's bytes were cleaned up.
        // `false` here means there was nothing to clean (no prior
        // attachment); `"errored"` means the previous bytes are
        // still in the bucket and a sweep is required.
        previous_object_deleted: previousObjectDeleted,
      },
      ip: req.ip ?? null,
      userAgent: req.get("user-agent") ?? null,
    }).catch((err) => {
      logger.warn(
        { err },
        "patient.prescription.attachment.upload audit write failed",
      );
    });

    res.status(200).json({ ok: true });
  },
);

router.get(
  "/patients/:id/prescriptions/:rxId/attachment",
  requireAdmin,
  async (req, res) => {
    const ids = idsParam.safeParse(req.params);
    if (!ids.success) {
      res.status(404).json({ error: "not_found" });
      return;
    }

    const rx = await findPrescriptionForPatient(ids.data.id, ids.data.rxId);
    if (!rx || !rx.attachmentObjectKey) {
      res.status(404).json({ error: "not_found" });
      return;
    }

    let file;
    try {
      file = await objectStorage.getObjectEntityFile(rx.attachmentObjectKey);
    } catch (err) {
      if (err instanceof ObjectNotFoundError) {
        // Row points to a bucket object that no longer exists. Most
        // likely a stale row from a deleted bucket during dev. Tell
        // the UI to render the "no attachment" affordance.
        res.status(404).json({ error: "not_found" });
        return;
      }
      req.log.error(
        { err, prescription_id: rx.id },
        "prescription_attachment_lookup_failed",
      );
      res.status(500).json({ error: "download_failed" });
      return;
    }

    await logAudit({
      action: "patient.prescription.attachment.download",
      adminEmail: req.adminEmail ?? null,
      adminUserId: req.adminUserId ?? null,
      targetTable: "prescriptions",
      targetId: rx.id,
      metadata: { patient_id: ids.data.id },
      ip: req.ip ?? null,
      userAgent: req.get("user-agent") ?? null,
    }).catch((err) => {
      logger.warn(
        { err },
        "patient.prescription.attachment.download audit write failed",
      );
    });

    try {
      const response = await objectStorage.downloadObject(file, 0);
      res.status(response.status);
      response.headers.forEach((value, key) => res.setHeader(key, value));
      // Surface the original filename to the browser so "Save as…"
      // pre-fills sensibly. Quote it per RFC 6266 to handle spaces
      // and other characters; ASCII-only fallback for older clients.
      if (rx.attachmentFilename) {
        const safeAscii = rx.attachmentFilename.replace(
          /[^\x20-\x7E]/g,
          "_",
        );
        const encoded = encodeURIComponent(rx.attachmentFilename);
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
        { err, prescription_id: rx.id },
        "prescription_attachment_stream_failed",
      );
      // Headers may already be sent at this point; best-effort.
      if (!res.headersSent) {
        res.status(500).json({ error: "download_failed" });
      } else {
        res.end();
      }
    }
  },
);

router.delete(
  "/patients/:id/prescriptions/:rxId/attachment",
  requireAdmin,
  async (req, res) => {
    const ids = idsParam.safeParse(req.params);
    if (!ids.success) {
      res.status(404).json({ error: "not_found" });
      return;
    }

    const rx = await findPrescriptionForPatient(ids.data.id, ids.data.rxId);
    if (!rx) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    if (!rx.attachmentObjectKey) {
      // Nothing to clear. Idempotent success — the UI's "Remove"
      // affordance can fire repeatedly without surfacing an error.
      res.status(200).json({ ok: true });
      return;
    }

    // Delete the GCS bytes BEFORE clearing the DB column. Order
    // matters here: if we cleared the DB first and then GCS failed,
    // the row would have no pointer to the orphaned bytes and the
    // future sweep job would have no way to know they should be
    // deleted (it relies on "in bucket but not referenced by any
    // row" — which would still be true for these orphans, so the
    // sweep would catch them, but having an audit record of the
    // failure makes manual reconciliation easier in the meantime).
    //
    // Best-effort: a transient GCS error must not leave the row
    // pointing at a file the user thinks they removed. We always
    // null the columns; the audit row records whether the bytes
    // were actually deleted so a future sweep can reconcile.
    // Definite assignment — every branch below sets this before
    // the audit row is written. Declared without an initializer so
    // eslint's no-useless-assignment doesn't fire on a dead `false`.
    let bytesDeleted: boolean | "errored";
    try {
      const objectFile = await objectStorage.getObjectEntityFile(
        rx.attachmentObjectKey,
      );
      await objectFile.delete();
      bytesDeleted = true;
    } catch (err) {
      if (err instanceof ObjectNotFoundError) {
        // Already gone (manual cleanup, prior failed write). The
        // user's intent — "this prescription has no document" —
        // is satisfied. Treat as success.
        bytesDeleted = true;
      } else {
        req.log.warn(
          { err, prescription_id: rx.id },
          "prescription_attachment_delete_bytes_failed",
        );
        bytesDeleted = "errored";
      }
    }

    const db = drizzle(getDbPool());
    const now = new Date();
    await db
      .update(prescriptions)
      .set({
        attachmentObjectKey: null,
        attachmentFilename: null,
        attachmentContentType: null,
        attachmentSizeBytes: null,
        attachmentUploadedAt: null,
        updatedAt: now,
      })
      .where(eq(prescriptions.id, rx.id));

    await logAudit({
      action: "patient.prescription.attachment.remove",
      adminEmail: req.adminEmail ?? null,
      adminUserId: req.adminUserId ?? null,
      targetTable: "prescriptions",
      targetId: rx.id,
      metadata: {
        patient_id: ids.data.id,
        // `true` = bytes are gone or were already gone; `"errored"`
        // = column cleared but bytes remain in the bucket and a
        // sweep is required.
        bytes_deleted: bytesDeleted,
      },
      ip: req.ip ?? null,
      userAgent: req.get("user-agent") ?? null,
    }).catch((err) => {
      logger.warn(
        { err },
        "patient.prescription.attachment.remove audit write failed",
      );
    });

    res.status(200).json({ ok: true });
  },
);

export default router;
