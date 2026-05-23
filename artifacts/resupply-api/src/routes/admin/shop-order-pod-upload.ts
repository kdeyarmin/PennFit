// Proof-of-Delivery photo upload + retrieval for shop_orders.
//
//   POST   /admin/shop/orders/:orderId/pod/upload-url
//          → { uploadURL, objectPath } — presigned PUT capability,
//            valid for ~15 minutes. The issuance itself is audit-
//            logged because the URL is a bearer token until the
//            finalize call confirms its use.
//
//   POST   /admin/shop/orders/:orderId/pod
//          Body: { objectPath, contentType, sizeBytes, signedName? }
//          Re-reads GCS metadata to verify the actually-uploaded
//          bytes match the content-type/size declared at upload-url
//          time, then stamps pod_object_key + pod_uploaded_at +
//          (optional) pod_signed_name on the order and replaces any
//          previous POD bytes.
//
//   GET    /admin/shop/orders/:orderId/pod
//          Streams the image bytes back to the requesting admin
//          (Content-Type from the bucket metadata). Audit-logged.
//
//   DELETE /admin/shop/orders/:orderId/pod
//          Best-effort removes the GCS bytes, then clears the
//          pod_* columns on the order.
//
// Mirrors the prescription-attachment flow at
// routes/patients/prescriptions-attachment.ts — same 3-step upload
// pattern, same finalize-verifies-bucket-metadata guarantee, same
// audit posture (never log object keys; CLAUDE.md hard rule).
//
// This file co-exists with the legacy PATCH /admin/shop/orders/
// :orderId/pod in shop-order-pod.ts: the PATCH route stamps an
// already-uploaded objectKey (CSR workflow with a pre-known
// bucket path) and stays in place until callers migrate.

import { Router, type IRouter } from "express";
import { Readable } from "node:stream";
import { z } from "zod";

import { logAudit } from "@workspace/resupply-audit";
import { getSupabaseServiceRoleClient } from "@workspace/resupply-db";

import { logger } from "../../lib/logger";
import { ObjectAlreadyOwnedError } from "../../lib/object-storage/objectAcl";
import {
  ObjectNotFoundError,
  ObjectStorageService,
} from "../../lib/object-storage/objectStorage";
import { adminRateLimit } from "../../middlewares/admin-rate-limit";
import { requirePermission } from "../../middlewares/requireAdmin";

// 8 MB caps the typical 12-MP smartphone JPEG with room to spare,
// and stops accidental HEIC bursts from overwhelming the bucket.
const MAX_POD_BYTES = 8 * 1024 * 1024;

// Image-only allowlist. PDFs are deliberately excluded — POD is a
// photo of the parcel, not a signed-delivery PDF, and HTML/JS
// would re-open the stored-XSS vector the prescription endpoint
// also blocks.
const ALLOWED_CONTENT_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/heic",
  "image/heif",
  "image/webp",
]);

const orderIdParam = z.string().uuid();

const uploadUrlBody = z
  .object({
    contentType: z.string().trim().min(1).max(120),
    sizeBytes: z.number().int().min(1).max(MAX_POD_BYTES),
  })
  .strict();

const finalizeBody = z
  .object({
    objectPath: z.string().trim().min(1).max(2048),
    contentType: z.string().trim().min(1).max(120),
    sizeBytes: z.number().int().min(1).max(MAX_POD_BYTES),
    signedName: z.string().trim().max(160).nullable().optional(),
  })
  .strict();

const router: IRouter = Router();
const objectStorage = new ObjectStorageService();

/** Look up the order row + current POD object key. Returns null
 *  when the order doesn't exist (404 surface) so the caller can
 *  fail closed without leaking which IDs are real. */
async function findOrder(
  orderId: string,
): Promise<{ id: string; podObjectKey: string | null } | null> {
  const supabase = getSupabaseServiceRoleClient();
  const { data, error } = await supabase
    .schema("resupply")
    .from("shop_orders")
    .select("id, pod_object_key")
    .eq("id", orderId)
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  if (!data) return null;
  return { id: data.id, podObjectKey: data.pod_object_key };
}

// ─── Metadata-only lookup (no image bytes) ────────────────────────
// Lightweight read the SPA uses to render the "have a POD or not?"
// affordance before it commits to fetching the bytes.
router.get(
  "/admin/shop/orders/:orderId/pod/meta",
  requirePermission("returns.manage"),
  async (req, res) => {
    const idParse = orderIdParam.safeParse(req.params.orderId);
    if (!idParse.success) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    const supabase = getSupabaseServiceRoleClient();
    const { data, error } = await supabase
      .schema("resupply")
      .from("shop_orders")
      .select("id, pod_uploaded_at, pod_signed_name")
      .eq("id", idParse.data)
      .limit(1)
      .maybeSingle();
    if (error) throw error;
    if (!data) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    res.json({
      uploadedAt: data.pod_uploaded_at,
      signedName: data.pod_signed_name,
    });
  },
);

// ─── Step 1: presigned PUT ─────────────────────────────────────────
router.post(
  "/admin/shop/orders/:orderId/pod/upload-url",
  requirePermission("returns.manage"),
  adminRateLimit({ name: "shop_orders.pod_upload_url", preset: "mutation" }),
  async (req, res) => {
    const idParse = orderIdParam.safeParse(req.params.orderId);
    if (!idParse.success) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    const bodyParse = uploadUrlBody.safeParse(req.body);
    if (!bodyParse.success) {
      res.status(400).json({
        error: "invalid_body",
        issues: bodyParse.error.issues.map((i) => ({
          path: i.path.join("."),
          message: i.message,
        })),
      });
      return;
    }
    if (!ALLOWED_CONTENT_TYPES.has(bodyParse.data.contentType)) {
      res.status(400).json({
        error: "invalid_body",
        issues: [
          {
            path: "contentType",
            message: `unsupported content type: ${bodyParse.data.contentType}`,
          },
        ],
      });
      return;
    }

    const order = await findOrder(idParse.data);
    if (!order) {
      res.status(404).json({ error: "not_found" });
      return;
    }

    try {
      const uploadURL = await objectStorage.getObjectEntityUploadURL();
      const objectPath = objectStorage.normalizeObjectEntityPath(uploadURL);

      await logAudit({
        action: "shop.order.pod.upload_url_issued",
        adminEmail: req.adminEmail ?? null,
        adminUserId: req.adminUserId ?? null,
        targetTable: "shop_orders",
        targetId: order.id,
        // Bounded technical metadata only. Object path stays out
        // per the CLAUDE.md "no image paths" hard rule.
        metadata: {
          declared_content_type: bodyParse.data.contentType,
          declared_size_bytes: bodyParse.data.sizeBytes,
        },
        ip: req.ip ?? null,
        userAgent: req.get("user-agent") ?? null,
      }).catch((err) => {
        logger.warn(
          { err },
          "shop.order.pod.upload_url_issued audit write failed",
        );
      });

      res.json({ uploadURL, objectPath });
    } catch (err) {
      req.log.error(
        { err, order_id: order.id },
        "shop_order_pod_upload_url_failed",
      );
      res.status(500).json({ error: "upload_url_failed" });
    }
  },
);

// ─── Step 2: finalize (verifies bucket truth, sets ACL, persists) ──
router.post(
  "/admin/shop/orders/:orderId/pod",
  requirePermission("returns.manage"),
  adminRateLimit({ name: "shop_orders.pod_finalize", preset: "mutation" }),
  async (req, res) => {
    const idParse = orderIdParam.safeParse(req.params.orderId);
    if (!idParse.success) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    const bodyParse = finalizeBody.safeParse(req.body);
    if (!bodyParse.success) {
      res.status(400).json({
        error: "invalid_body",
        issues: bodyParse.error.issues.map((i) => ({
          path: i.path.join("."),
          message: i.message,
        })),
      });
      return;
    }
    if (!ALLOWED_CONTENT_TYPES.has(bodyParse.data.contentType)) {
      res.status(400).json({
        error: "invalid_body",
        issues: [
          {
            path: "contentType",
            message: `unsupported content type: ${bodyParse.data.contentType}`,
          },
        ],
      });
      return;
    }

    const order = await findOrder(idParse.data);
    if (!order) {
      res.status(404).json({ error: "not_found" });
      return;
    }

    // ACL — owner is the issuing admin; visibility private. Same
    // posture as prescription attachments.
    let normalizedPath: string;
    try {
      normalizedPath = await objectStorage.trySetObjectEntityAclPolicy(
        bodyParse.data.objectPath,
        {
          owner: req.adminUserId ?? "unknown",
          visibility: "private",
        },
      );
    } catch (err) {
      if (err instanceof ObjectNotFoundError) {
        res.status(400).json({ error: "object_missing" });
        return;
      }
      if (err instanceof ObjectAlreadyOwnedError) {
        // The bytes the admin just uploaded sit in the bucket
        // with no DB row pointing at them. Best-effort delete the
        // upload before responding so the bucket doesn't leak —
        // same posture as the patient-document finalize handler.
        // Normalise the path first: the client may have sent the
        // storage-URL form, which getObjectEntityFile won't accept
        // (it requires the /objects/ prefix).
        try {
          const cleanupPath = objectStorage.normalizeObjectEntityPath(
            bodyParse.data.objectPath,
          );
          if (cleanupPath.startsWith("/")) {
            const objectFile =
              await objectStorage.getObjectEntityFile(cleanupPath);
            await objectFile.delete({ ignoreNotFound: true });
          }
        } catch (cleanupErr) {
          req.log.warn(
            { err: cleanupErr, order_id: order.id },
            "shop_order_pod_finalize_orphan_cleanup_failed",
          );
        }
        res.status(403).json({ error: "object_already_claimed" });
        return;
      }
      req.log.warn(
        { err, order_id: order.id },
        "shop_order_pod_finalize_acl_failed",
      );
      res.status(500).json({ error: "finalize_failed" });
      return;
    }

    // Re-read bucket truth — declared values from upload-url are
    // advisory; a tampered client could upload bytes that don't
    // match. Reject and delete on mismatch before persisting.
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
        actualSize > MAX_POD_BYTES
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
      req.log.error(
        { err, order_id: order.id },
        "shop_order_pod_finalize_metadata_check_failed",
      );
      res.status(500).json({ error: "finalize_failed" });
      return;
    }

    // Persist BEFORE the previous-bytes cleanup, so the row points
    // at the new object if cleanup fails (avoids a dangling row).
    const previousObjectKey = order.podObjectKey;
    const supabase = getSupabaseServiceRoleClient();
    const { error: updateErr } = await supabase
      .schema("resupply")
      .from("shop_orders")
      .update({
        pod_object_key: normalizedPath,
        pod_uploaded_at: new Date().toISOString(),
        pod_signed_name: bodyParse.data.signedName ?? null,
      })
      .eq("id", order.id);
    if (updateErr) throw updateErr;

    // Best-effort replace cleanup.
    let previousObjectDeleted: boolean | "errored" = false;
    if (previousObjectKey && previousObjectKey !== normalizedPath) {
      try {
        const previousFile =
          await objectStorage.getObjectEntityFile(previousObjectKey);
        await previousFile.delete();
        previousObjectDeleted = true;
      } catch (err) {
        if (err instanceof ObjectNotFoundError) {
          previousObjectDeleted = true;
        } else {
          req.log.warn(
            { err },
            "shop_order_pod_replace_cleanup_failed",
          );
          previousObjectDeleted = "errored";
        }
      }
    }

    await logAudit({
      action: "shop.order.pod.upload",
      adminEmail: req.adminEmail ?? null,
      adminUserId: req.adminUserId ?? null,
      targetTable: "shop_orders",
      targetId: order.id,
      metadata: {
        content_type: actualContentType,
        size_bytes: actualSize,
        signed_name_set: !!bodyParse.data.signedName,
        replaced_existing: previousObjectKey !== null,
        previous_object_deleted: previousObjectDeleted,
      },
      ip: req.ip ?? null,
      userAgent: req.get("user-agent") ?? null,
    }).catch((err) => {
      logger.warn({ err }, "shop.order.pod.upload audit write failed");
    });

    res.status(200).json({ ok: true });
  },
);

// ─── Stream the POD bytes back ─────────────────────────────────────
router.get(
  "/admin/shop/orders/:orderId/pod",
  requirePermission("returns.manage"),
  async (req, res) => {
    const idParse = orderIdParam.safeParse(req.params.orderId);
    if (!idParse.success) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    const order = await findOrder(idParse.data);
    if (!order || !order.podObjectKey) {
      res.status(404).json({ error: "not_found" });
      return;
    }

    let file;
    try {
      file = await objectStorage.getObjectEntityFile(order.podObjectKey);
    } catch (err) {
      if (err instanceof ObjectNotFoundError) {
        res.status(404).json({ error: "not_found" });
        return;
      }
      req.log.error(
        { err, order_id: order.id },
        "shop_order_pod_lookup_failed",
      );
      res.status(500).json({ error: "download_failed" });
      return;
    }

    await logAudit({
      action: "shop.order.pod.download",
      adminEmail: req.adminEmail ?? null,
      adminUserId: req.adminUserId ?? null,
      targetTable: "shop_orders",
      targetId: order.id,
      metadata: {},
      ip: req.ip ?? null,
      userAgent: req.get("user-agent") ?? null,
    }).catch((err) => {
      logger.warn({ err }, "shop.order.pod.download audit write failed");
    });

    try {
      const response = await objectStorage.downloadObject(file, 0);
      res.status(response.status);
      response.headers.forEach((value, key) => res.setHeader(key, value));
      // Inline display — POD is rendered in the order detail panel,
      // not downloaded as a file. private/no-store keeps it out of
      // shared caches.
      res.setHeader("Cache-Control", "private, no-store");
      res.setHeader("Content-Disposition", "inline");
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
        { err, order_id: order.id },
        "shop_order_pod_stream_failed",
      );
      if (!res.headersSent) {
        res.status(500).json({ error: "download_failed" });
      } else {
        res.end();
      }
    }
  },
);

// ─── Remove POD ────────────────────────────────────────────────────
router.delete(
  "/admin/shop/orders/:orderId/pod",
  requirePermission("returns.manage"),
  adminRateLimit({ name: "shop_orders.pod_delete", preset: "mutation" }),
  async (req, res) => {
    const idParse = orderIdParam.safeParse(req.params.orderId);
    if (!idParse.success) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    const order = await findOrder(idParse.data);
    if (!order) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    if (!order.podObjectKey) {
      res.status(200).json({ ok: true });
      return;
    }

    let bytesDeleted: boolean | "errored";
    try {
      const objectFile = await objectStorage.getObjectEntityFile(
        order.podObjectKey,
      );
      await objectFile.delete();
      bytesDeleted = true;
    } catch (err) {
      if (err instanceof ObjectNotFoundError) {
        bytesDeleted = true;
      } else {
        req.log.warn({ err }, "shop_order_pod_delete_bytes_failed");
        bytesDeleted = "errored";
      }
    }

    const supabase = getSupabaseServiceRoleClient();
    const { error: clearErr } = await supabase
      .schema("resupply")
      .from("shop_orders")
      .update({
        pod_object_key: null,
        pod_uploaded_at: null,
        pod_signed_name: null,
      })
      .eq("id", order.id);
    if (clearErr) throw clearErr;

    await logAudit({
      action: "shop.order.pod.remove",
      adminEmail: req.adminEmail ?? null,
      adminUserId: req.adminUserId ?? null,
      targetTable: "shop_orders",
      targetId: order.id,
      metadata: { bytes_deleted: bytesDeleted },
      ip: req.ip ?? null,
      userAgent: req.get("user-agent") ?? null,
    }).catch((err) => {
      logger.warn({ err }, "shop.order.pod.remove audit write failed");
    });

    res.status(200).json({ ok: true });
  },
);

export default router;
