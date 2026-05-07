// POST /shop/back-in-stock — public endpoint that puts a customer on
// the notify-me list for an out-of-stock SKU. Surfaced from the PDP
// when stockCount === 0.
//
// We deliberately do NOT check stock here:
//   * The catalog projection is cached for ~60s, so a customer who
//     loaded the page just before a re-stock might still see "Out of
//     stock" — refusing the signup would be confusing and lossy.
//   * The dispatch trigger fires on the admin stock-PATCH 0->positive
//     transition, so a row recorded against an in-stock SKU just sits
//     pending until the next outage. No double-email risk because the
//     partial unique index prevents a duplicate row on the same SKU.
//
// Anti-abuse:
//   * In-memory token-bucket rate limit: 10 signups per 15 min per IP
//     (the form is re-mountable across PDPs so the bucket has to be
//     more permissive than the insurance-lead one).
//   * Honeypot `website` field. Bots fill every input; humans never.
//
// Privacy: email is NOT PHI by itself, but we still keep it out of
// the request log (counts-only audit line below).

import { Router, type IRouter } from "express";
import { z } from "zod";

import { recordBackInStockSignup } from "../../lib/back-in-stock-record";

const router: IRouter = Router();

const bodySchema = z
  .object({
    productId: z
      .string()
      .trim()
      .min(3)
      .max(120)
      // Accept real Stripe ids (`prod_<base62>`) AND preview-mode
      // ids like `prod_preview_mask-nasal-pillows-medium` so the
      // notify-me flow works in dev and on demo SKUs. The `prod_`
      // prefix gate prevents arbitrary input from being treated
      // as a product reference.
      .regex(/^prod_[A-Za-z0-9_-]+$/, "must be a Stripe product id"),
    email: z.string().trim().toLowerCase().email().max(200),
    /** Honeypot — bots fill it, humans don't see it. */
    website: z.string().max(200).optional(),
  })
  .strict();

const RATE_WINDOW_MS = 15 * 60 * 1000;
const RATE_MAX = 10;
const rateBucket = new Map<string, number[]>();

// Prune stale keys every 30 minutes so the bucket doesn't accumulate
// one entry per unique IP indefinitely.
setInterval(
  () => {
    const cutoff = Date.now() - RATE_WINDOW_MS;
    for (const [key, ts] of rateBucket) {
      if (ts.every((t) => t < cutoff)) rateBucket.delete(key);
    }
  },
  30 * 60 * 1000,
).unref();

function rateLimited(key: string): boolean {
  const now = Date.now();
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

router.post("/shop/back-in-stock", async (req, res) => {
  const parse = bodySchema.safeParse(req.body);
  if (!parse.success) {
    res.status(400).json({
      error: "invalid_body",
      issues: parse.error.issues.map((i) => ({
        path: i.path.join("."),
        message: i.message,
      })),
    });
    return;
  }
  const data = parse.data;

  if (data.website && data.website.trim().length > 0) {
    req.log?.info?.({ honeypot: true }, "shop/back-in-stock: honeypot trip");
    res.json({ ok: true, status: "queued" });
    return;
  }

  const ip =
    req.ip ||
    req.socket?.remoteAddress ||
    req.headers["x-forwarded-for"]?.toString().split(",")[0]?.trim() ||
    "unknown";
  if (rateLimited(ip + ":back-in-stock")) {
    res.status(429).json({ error: "rate_limited" });
    return;
  }

  const result = await recordBackInStockSignup({
    productId: data.productId,
    email: data.email,
    submitterIp: ip === "unknown" ? null : ip,
    userAgent:
      typeof req.headers["user-agent"] === "string"
        ? req.headers["user-agent"].slice(0, 500)
        : null,
  });

  // Counts-only log — never the email.
  req.log?.info?.(
    {
      productId: data.productId,
      status: result.status,
      err: result.error,
    },
    "shop/back-in-stock: signup processed",
  );

  // We always 200 the patient — even on internal error. Re-trying
  // wouldn't help the patient (they'd just resubmit), and the row is
  // either saved or wasn't; we don't want to imply an action they
  // can take.
  res.json({ ok: true, status: result.status });
});

export default router;

export function _resetBackInStockRateBucketForTests(): void {
  rateBucket.clear();
}
