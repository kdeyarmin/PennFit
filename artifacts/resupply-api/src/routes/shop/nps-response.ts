// POST /shop/orders/nps — public capture endpoint for the
// post-delivery follow-up NPS rating.
//
// Surface
// -------
//   POST /shop/orders/nps
//        { token, comment? }
//   →    { ok: true }
//
// The token is the HMAC-signed `t` query param the patient followed
// from their delivery-followup email. It encodes (order_id, score,
// expiry). Verification:
//
//   1. timingSafeEqual on the HMAC.
//   2. expiry is in the future.
//   3. order_id resolves to an existing shop_orders row that has
//      a delivered_at stamp (we only accept ratings on truly-
//      delivered orders).
//
// Comment is optional — most clicks won't include one (the patient
// scored from the email's tap-rating row), but the result page on
// the SPA does invite a free-text follow-up.
//
// No deduplication: the schema allows multiple rows per (order,
// score). A patient who clicks a score, decides to change it, and
// clicks a different one persists both — admin analytics dedups by
// (order_id, MAX(created_at)) when "most recent rating per order"
// is what's needed.

import { Router, type IRouter } from "express";
import { z } from "zod";

import { getSupabaseServiceRoleClient } from "@workspace/resupply-db";

import { logger } from "../../lib/logger";
import { verifyNpsToken } from "../../lib/nps-token";

const router: IRouter = Router();

const RATE_WINDOW_MS = 15 * 60 * 1000;
const RATE_MAX = 20;
const rateBucket = new Map<string, number[]>();
const RATE_SWEEP_EVERY = 200;
let rateBucketSweepCounter = 0;

function sweepRateBucket(now: number): void {
  for (const [key, timestamps] of rateBucket) {
    if (timestamps.every((t) => now - t >= RATE_WINDOW_MS)) {
      rateBucket.delete(key);
    }
  }
}

function rateLimited(key: string): boolean {
  const now = Date.now();
  if (++rateBucketSweepCounter % RATE_SWEEP_EVERY === 0) {
    sweepRateBucket(now);
  }
  const arr = (rateBucket.get(key) ?? []).filter(
    (t) => now - t < RATE_WINDOW_MS,
  );
  if (arr.length >= RATE_MAX) {
    rateBucket.set(key, arr);
    return true;
  }
  arr.push(now);
  rateBucket.set(key, arr);
  return false;
}

const body = z
  .object({
    token: z.string().min(10).max(400),
    comment: z.string().trim().max(2000).optional(),
  })
  .strict();

router.post("/shop/orders/nps", async (req, res) => {
  const ip =
    req.ip ||
    req.socket?.remoteAddress ||
    req.headers["x-forwarded-for"]?.toString().split(",")[0]?.trim() ||
    "unknown";
  if (rateLimited(ip + ":nps")) {
    res.status(429).json({ error: "rate_limited" });
    return;
  }

  const parsed = body.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({
      error: "invalid_body",
      issues: parsed.error.issues.map((i) => ({
        path: i.path.join("."),
        message: i.message,
      })),
    });
    return;
  }

  const verified = verifyNpsToken(parsed.data.token);
  if (!verified.valid) {
    res.status(400).json({ error: "invalid_token" });
    return;
  }

  const supabase = getSupabaseServiceRoleClient();

  // Confirm the order exists and is actually delivered. The token's
  // HMAC was minted by the dispatcher when the parcel was already
  // marked delivered, but the order could have been refunded /
  // cancelled in the meantime; we still record the rating in that
  // case (the patient's feedback is valid regardless), but log a
  // warning so analytics can filter if needed.
  const { data: order } = await supabase
    .schema("resupply")
    .from("shop_orders")
    .select("id, status, delivered_at")
    .eq("id", verified.orderId)
    .limit(1)
    .maybeSingle();
  if (!order) {
    res.status(404).json({ error: "order_not_found" });
    return;
  }

  const { error: insertErr } = await supabase
    .schema("resupply")
    .from("shop_order_nps_responses")
    .insert({
      order_id: verified.orderId,
      score: verified.score,
      comment: parsed.data.comment ?? null,
      submitter_ip: ip === "unknown" ? null : ip,
      user_agent:
        typeof req.headers["user-agent"] === "string"
          ? req.headers["user-agent"].slice(0, 500)
          : null,
    });
  if (insertErr) {
    logger.warn(
      { err: insertErr.message, orderId: verified.orderId },
      "shop/orders/nps: insert failed",
    );
    res.status(500).json({ error: "insert_failed" });
    return;
  }

  logger.info(
    {
      event: "shop.nps.captured",
      score: verified.score,
      orderStatus: order.status,
      withComment: Boolean(parsed.data.comment),
    },
    "nps response captured",
  );

  res.json({ ok: true });
});

export default router;

// Test-only seam — clears the in-memory rate bucket between vitest runs.
export function _resetNpsRateBucketForTests(): void {
  rateBucket.clear();
  rateBucketSweepCounter = 0;
}
