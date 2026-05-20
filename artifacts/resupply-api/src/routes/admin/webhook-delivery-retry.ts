// POST /admin/webhook-deliveries/:id/retry-now
//
// Manually re-queue an exhausted or failed delivery for immediate
// dispatch. Resets attempt_count to 0 and next_attempt_at to now
// so the dispatcher's tick (every minute) picks it up.

import { Router, type IRouter } from "express";
import { z } from "zod";

import { logAudit } from "@workspace/resupply-audit";
import { getSupabaseServiceRoleClient } from "@workspace/resupply-db";

import { logger } from "../../lib/logger";
import { adminRateLimit } from "../../middlewares/admin-rate-limit";
import { requireAdminOnly } from "../../middlewares/requireAdmin";

const router: IRouter = Router();

const idParam = z.object({ id: z.string().uuid() });

router.post(
  "/admin/webhook-deliveries/:id/retry-now",
  requireAdminOnly,
  adminRateLimit({ name: "webhook_deliveries.retry", preset: "mutation" }),
  async (req, res) => {
    const parsed = idParam.safeParse(req.params);
    if (!parsed.success) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    const supabase = getSupabaseServiceRoleClient();
    const { data: delivery } = await supabase
      .schema("resupply")
      .from("webhook_deliveries")
      .select("id, status, subscription_id")
      .eq("id", parsed.data.id)
      .limit(1)
      .maybeSingle();
    if (!delivery) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    if (delivery.status === "delivered") {
      res.status(409).json({
        error: "already_delivered",
        message: "delivery already succeeded",
      });
      return;
    }
    await supabase
      .schema("resupply")
      .from("webhook_deliveries")
      .update({
        status: "queued",
        attempt_count: 0,
        next_attempt_at: new Date().toISOString(),
        last_error: null,
        updated_at: new Date().toISOString(),
      })
      .eq("id", delivery.id);
    await logAudit({
      action: "webhook_delivery.retry_now",
      adminEmail: req.adminEmail ?? null,
      adminUserId: req.adminUserId ?? null,
      targetTable: "webhook_deliveries",
      targetId: delivery.id,
      metadata: {
        from_status: delivery.status,
        subscription_id: delivery.subscription_id,
      },
      ip: req.ip ?? null,
      userAgent: req.get("user-agent") ?? null,
    }).catch((err) => {
      logger.warn({ err }, "webhook_delivery.retry_now audit write failed");
    });
    res.status(202).json({
      ok: true,
      note: "requeued; dispatcher will attempt within ~60 seconds",
    });
  },
);

export default router;
