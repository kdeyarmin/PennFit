// POST /shop/orders/mask-fit — public capture endpoint for the
// post-delivery mask-fit micro-survey (RT #22a).
//
//   POST /shop/orders/mask-fit
//        { token, comment? }
//   →    { ok: true }
//
// `token` is the HMAC-signed value the patient followed from their
// delivery-followup email; it encodes (order_id, fit_outcome, expiry).
// Verification mirrors the NPS endpoint: timing-safe HMAC, future
// expiry, order resolves to an existing shop_orders row. Multiple rows
// per order are allowed (a patient can re-answer); the RT worklist works
// the newest non-'good' outcome per order. No login — the signed token
// is the auth. No PHI in logs (outcome + flags only).

import { Router, type IRouter, type Request } from "express";
import expressRateLimit, { ipKeyGenerator } from "express-rate-limit";
import { z } from "zod";

import { getSupabaseServiceRoleClient } from "@workspace/resupply-db";

import { logger } from "../../lib/logger";
import { verifyMaskFitToken } from "../../lib/mask-fit-token";

const router: IRouter = Router();

const maskFitRateLimiter = expressRateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 20,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  keyGenerator: (req: Request) => ipKeyGenerator(req.ip ?? "0.0.0.0"),
  message: { error: "rate_limited" },
});

const body = z
  .object({
    token: z.string().min(10).max(400),
    comment: z.string().trim().max(2000).optional(),
  })
  .strict();

router.post("/shop/orders/mask-fit", maskFitRateLimiter, async (req, res) => {
  const ip =
    req.ip ||
    req.socket?.remoteAddress ||
    req.headers["x-forwarded-for"]?.toString().split(",")[0]?.trim() ||
    "unknown";

  const parsed = body.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "invalid_body" });
    return;
  }

  const verified = verifyMaskFitToken(parsed.data.token);
  if (!verified.valid) {
    res.status(400).json({ error: "invalid_token" });
    return;
  }

  const supabase = getSupabaseServiceRoleClient();
  const { data: order } = await supabase
    .schema("resupply")
    .from("shop_orders")
    .select("id, status")
    .eq("id", verified.orderId)
    .limit(1)
    .maybeSingle();
  if (!order) {
    res.status(404).json({ error: "order_not_found" });
    return;
  }

  const { error: insertErr } = await supabase
    .schema("resupply")
    .from("mask_fit_outcomes")
    .insert({
      order_id: verified.orderId,
      fit_outcome: verified.outcome,
      comment: parsed.data.comment ?? null,
      submitter_ip: ip === "unknown" ? null : ip,
      user_agent:
        typeof req.headers["user-agent"] === "string"
          ? req.headers["user-agent"].slice(0, 500)
          : null,
    });
  if (insertErr) {
    logger.warn(
      { err: insertErr.message },
      "shop/orders/mask-fit: insert failed",
    );
    res.status(500).json({ error: "insert_failed" });
    return;
  }

  logger.info(
    {
      event: "shop.mask_fit.captured",
      outcome: verified.outcome,
      withComment: Boolean(parsed.data.comment),
    },
    "mask-fit response captured",
  );

  res.json({ ok: true });
});

export default router;
