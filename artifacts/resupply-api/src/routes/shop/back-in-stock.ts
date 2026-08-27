// POST /shop/back-in-stock — public endpoint that puts a customer on
// the notify-me list for an out-of-stock SKU. The cash-pay PDP is gone,
// but admin inventory still tracks pending signups and auto-dispatch
// (when enabled) drains the queue on restock.
//
// We deliberately do NOT check stock here:
//   * The catalog projection may be briefly stale, so refusing a signup
//     just before a re-stock would be confusing and lossy.
//   * Dispatch fires on the admin stock 0→positive transition, so a row
//     recorded while in-stock sits pending until the next outage.
//
// Anti-abuse:
//   * In-memory token-bucket rate limit: 10 signups per 15 min per IP.
//   * Honeypot `website` field. Bots fill every input; humans never.
//
// Privacy: email is NOT PHI by itself, but we still keep it out of
// the request log (counts-only audit line below).

import { Router, type IRouter } from "express";
import { z } from "zod";

import { recordBackInStockSignup } from "../../lib/back-in-stock-record";
import { requestHost } from "../../lib/request-host";
import { resolveBrandOrgIdByHost } from "../../lib/tenant-branding";

const router: IRouter = Router();

// Warehouse SKU — same shape as /admin/catalog (PacWare-safe charset).
const SKU_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

const bodySchema = z
  .object({
    productId: z
      .string()
      .trim()
      .min(1)
      .max(64)
      .regex(SKU_RE, "must be a catalog SKU")
      .refine((id) => !id.startsWith("prod_"), {
        message: "legacy Stripe product ids are not accepted",
      }),
    email: z.string().trim().toLowerCase().email().max(200),
    /** Honeypot — bots fill it, humans don't see it. */
    website: z.string().max(200).optional(),
  })
  .strict();

const RATE_WINDOW_MS = 15 * 60 * 1000;
const RATE_MAX = 10;
const rateBucket = new Map<string, number[]>();

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

  // Public route — resolve by verified custom domain / subdomain ONLY.
  // Platform host and unbound domains return null so we never file another
  // tenant's signup under the seed org.
  const orgId = await resolveBrandOrgIdByHost(requestHost(req));
  if (!orgId) {
    res.status(503).json({ error: "tenant_unavailable" });
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
    orgId,
  });

  req.log?.info?.(
    {
      productId: data.productId,
      status: result.status,
      err: result.error,
    },
    "shop/back-in-stock: signup processed",
  );

  res.json({ ok: true, status: result.status });
});

export default router;

export function _resetBackInStockRateBucketForTests(): void {
  rateBucket.clear();
}
