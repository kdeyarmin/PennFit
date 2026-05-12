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
import { getSupabaseServiceRoleClient } from "@workspace/resupply-db";

import { logger } from "../../lib/logger";
import { requireAdmin } from "../../middlewares/requireAdmin";

const router: IRouter = Router();

const body = z
  .object({
    objectKey: z.string().trim().min(1).max(500),
    signedName: z.string().trim().max(160).nullable().optional(),
  })
  .strict();

router.patch(
  "/admin/shop/orders/:orderId/pod",
  requireAdmin,
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
    const supabase = getSupabaseServiceRoleClient();
    const { error } = await supabase
      .schema("resupply")
      .from("shop_orders")
      .update({
        pod_object_key: parsed.data.objectKey,
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
      logger.warn({ err }, "shop.order.pod.uploaded audit failed");
    });
    res.json({ ok: true });
  },
);

export default router;
