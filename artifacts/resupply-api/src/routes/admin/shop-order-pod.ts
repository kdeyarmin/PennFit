// /admin/shop/orders/:orderId/pod — proof-of-delivery upload.
//
//   PATCH /admin/shop/orders/:orderId/pod
//        Body: { objectKey, signedName? }
//        Stamps pod_object_key + pod_uploaded_at + (optional)
//        pod_signed_name on the order. Image upload itself goes to
//        App Storage via the existing object-upload flow.

import { Router, type IRouter } from "express";
import { z } from "zod";

import { logAudit } from "@workspace/resupply-audit";
import { getOrgScopedClient } from "@workspace/resupply-db";

import { redactDbErr } from "../../lib/redact-db-err";
import { logger } from "../../lib/logger";
import { ObjectAlreadyOwnedError } from "../../lib/object-storage/objectAcl";
import {
  ObjectNotFoundError,
  ObjectStorageService,
} from "../../lib/object-storage/objectStorage";
import { adminRateLimit } from "../../middlewares/admin-rate-limit";
import { requirePermission } from "../../middlewares/requireAdmin";

const objectStorage = new ObjectStorageService();

const router: IRouter = Router();

const body = z
  .object({
    objectKey: z.string().trim().min(1).max(500),
    signedName: z.string().trim().max(160).nullable().optional(),
  })
  .strict();

router.patch(
  "/admin/shop/orders/:orderId/pod",
  requirePermission("returns.manage"),
  adminRateLimit({ name: "shop_orders.pod_update", preset: "mutation" }),
  async (req, res) => {
    const idParse = z.string().uuid().safeParse(req.params.orderId);
    if (!idParse.success) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    const parsed = body.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "invalid_body" });
      return;
    }
    const orgId = req.orgId;
    if (!orgId) {
      res.status(500).json({ error: "tenant_context_missing" });
      return;
    }
    // Atomically CLAIM the object's ACL before binding it to the order — the
    // same guard the newer POST-finalize flow uses. Without this the legacy
    // PATCH would bind ANY object key (e.g. another patient's already-finalized
    // upload) onto this order, which a buyer who knows the order's Stripe
    // session id could then fetch via GET /shop/orders/:sessionId/pod —
    // a cross-patient PHI leak. trySetObjectEntityAclPolicy throws
    // ObjectAlreadyOwnedError when the object is already owned (so it can't be
    // re-pointed) and ObjectNotFoundError when it doesn't exist.
    let normalizedPath: string;
    try {
      normalizedPath = await objectStorage.trySetObjectEntityAclPolicy(
        parsed.data.objectKey,
        { owner: req.adminUserId ?? "unknown", visibility: "private" },
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
      throw err;
    }
    const supabase = getOrgScopedClient(orgId);
    const { error } = await supabase
      .from("shop_orders")
      .update({
        pod_object_key: normalizedPath,
        pod_uploaded_at: new Date().toISOString(),
        pod_signed_name: parsed.data.signedName ?? null,
      })
      .eq("id", idParse.data);
    if (error) throw error;
    await logAudit({
      action: "shop.order.pod.uploaded",
      adminEmail: req.adminEmail ?? null,
      adminUserId: req.adminUserId ?? null,
      targetTable: "shop_orders",
      targetId: idParse.data,
      // Hard rule from CLAUDE.md: never log image bytes / image paths.
      // The object key is a GCS path; treat as sensitive and omit.
      metadata: {
        signed_name_set: !!parsed.data.signedName,
      },
      ip: req.ip ?? null,
      userAgent: req.get("user-agent") ?? null,
    }).catch((err) => {
      logger.warn(
        { err: redactDbErr(err) },
        "shop.order.pod.uploaded audit failed",
      );
    });
    res.json({ ok: true });
  },
);

export default router;
