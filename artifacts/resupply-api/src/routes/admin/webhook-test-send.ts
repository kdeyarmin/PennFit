// POST /admin/webhook-subscriptions/:id/test-send
//
// Fires a synthetic webhook delivery against the subscriber's URL
// so admins can validate signature handling + HTTPS reachability
// before going live.
//
// The synthetic event uses type 'webhook.test' (not in the catalog,
// excluded from the create-validator). It still flows through the
// dispatcher path (HMAC signed, retries, audit row) — verifying
// the full pipeline end-to-end, not just network reachability.

import { Router, type IRouter } from "express";
import { z } from "zod";

import { logAudit } from "@workspace/resupply-audit";
import {
  type Json,
  getSupabaseServiceRoleClient,
} from "@workspace/resupply-db";

import { logger } from "../../lib/logger";
import { adminRateLimit } from "../../middlewares/admin-rate-limit";
import { requireAdminOnly } from "../../middlewares/requireAdmin";

const router: IRouter = Router();

const idParam = z.object({ id: z.string().uuid() });

router.post(
  "/admin/webhook-subscriptions/:id/test-send",
  requireAdminOnly,
  adminRateLimit({
    name: "webhook_subscriptions.test_send",
    preset: "mutation",
  }),
  async (req, res) => {
    const parsed = idParam.safeParse(req.params);
    if (!parsed.success) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    const supabase = getSupabaseServiceRoleClient();
    const { data: sub } = await supabase
      .schema("resupply")
      .from("webhook_subscriptions")
      .select("id, name, is_active, target_url")
      .eq("id", parsed.data.id)
      .limit(1)
      .maybeSingle();
    if (!sub) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    if (!sub.is_active) {
      res.status(409).json({
        error: "subscription_inactive",
        message: "activate the subscription before sending a test event",
      });
      return;
    }
    if (!sub.target_url.startsWith("https://")) {
      res.status(409).json({
        error: "non_https_target",
        message: "target_url must be https://",
      });
      return;
    }

    const payload = {
      type: "webhook.test",
      timestamp: new Date().toISOString(),
      data: {
        subscription_id: sub.id,
        subscription_name: sub.name,
        sent_by: req.adminEmail ?? "unknown",
        note: "synthetic test event — safe to ignore in your processor",
      },
    };
    const { data: row, error } = await supabase
      .schema("resupply")
      .from("webhook_deliveries")
      .insert({
        subscription_id: sub.id,
        event_type: "webhook.test",
        event_payload: payload as unknown as Json,
      })
      .select("id")
      .single();
    if (error) throw error;
    await logAudit({
      action: "webhook_subscription.test_send",
      adminEmail: req.adminEmail ?? null,
      adminUserId: req.adminUserId ?? null,
      targetTable: "webhook_subscriptions",
      targetId: sub.id,
      metadata: { delivery_id: row.id, target_url: sub.target_url },
      ip: req.ip ?? null,
      userAgent: req.get("user-agent") ?? null,
    }).catch((err) => {
      logger.warn(
        { err },
        "webhook_subscription.test_send audit write failed",
      );
    });
    res.status(202).json({
      ok: true,
      deliveryId: row.id,
      note: "queued; the dispatcher will attempt within ~60 seconds",
    });
  },
);

export default router;
