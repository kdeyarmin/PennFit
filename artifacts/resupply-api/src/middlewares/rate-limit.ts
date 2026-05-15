// rateLimit — in-memory IP-based sliding-window rate limiter.
//
// Why this lives here (and not behind nginx / a Redis bucket):
//   The resupply-api is a single-instance Node process today. The
//   platform's reverse proxy passes through traffic without rate
//   limiting of its own. We're not trying to repel a sustained
//   DDoS — that's a CDN/WAF concern — we're trying to prevent
//   accidental abuse of an unauthenticated endpoint creating
//   unbounded Stripe sessions and shop_orders rows.
//
// Algorithm:
//   Plain fixed-window counter, keyed by IP. Cheaper and simpler
//   than a token bucket; the visible behavior (X requests per
//   window, then 429 with Retry-After until the window resets) is
//   what callers actually expect.
//
// Memory:
//   We sweep expired keys on each request that we look up — no
//   timer thread. In the worst case (many distinct IPs) the map
//   grows to ~one entry per active IP per window. For our scale
//   that's a few KB.

import type { RequestHandler } from "express";

interface Bucket {
  count: number;
  resetAt: number;
}

export interface RateLimitOptions {
  /** Window length in milliseconds. */
  windowMs: number;
  /** Max requests allowed per key per window. */
  max: number;
  /**
   * Stable name for logs and the response body. Helps ops grep
   * across many limiters in the same process.
   */
  name: string;
  /**
   * Custom key extractor. Defaults to `req.ip` (IP-based limiting).
   * Override to key by phone number, user ID, or any other dimension.
   * Return a stable string; an empty string falls back to "unknown".
   */
  keyFn?: (req: import("express").Request) => string;
}

export function rateLimit(opts: RateLimitOptions): RequestHandler {
  const buckets = new Map<string, Bucket>();

  return (req, res, next) => {
    const now = Date.now();
    const key = opts.keyFn
      ? (opts.keyFn(req) || "unknown")
      : (req.ip ?? req.socket.remoteAddress ?? "unknown");

    let bucket = buckets.get(key);
    if (!bucket || bucket.resetAt <= now) {
      bucket = { count: 0, resetAt: now + opts.windowMs };
      buckets.set(key, bucket);
    }

    bucket.count += 1;
    const remaining = Math.max(0, opts.max - bucket.count);
    res.setHeader("X-RateLimit-Limit", String(opts.max));
    res.setHeader("X-RateLimit-Remaining", String(remaining));
    res.setHeader(
      "X-RateLimit-Reset",
      String(Math.ceil(bucket.resetAt / 1000)),
    );

    if (bucket.count > opts.max) {
      const retryAfterSec = Math.max(
        1,
        Math.ceil((bucket.resetAt - now) / 1000),
      );
      res.setHeader("Retry-After", String(retryAfterSec));
      req.log?.warn(
        { event: "rate_limit_exceeded", limiter: opts.name, ip: key },
        "rate limit exceeded",
      );
      res.status(429).json({
        error: "too_many_requests",
        limiter: opts.name,
        retryAfterSeconds: retryAfterSec,
        message:
          "You're going a little fast. Please wait a moment and try again.",
      });
      return;
    }

    // Periodic janitor: every ~100 lookups, sweep entries whose
    // window has already elapsed. Stops the map from growing
    // unboundedly under churn from one-off IPs.
    if (buckets.size > 100 && Math.random() < 0.01) {
      for (const [k, v] of buckets) {
        if (v.resetAt <= now) buckets.delete(k);
      }
    }

    next();
  };
}

/**
 * Defense-in-depth IP rate limit applied at the app level on
 * mutating `/admin/*` requests across both mount prefixes. Mirrors
 * the architecture of `requireCsrfOnAdminMutations`: pass-through
 * for safe methods (GET/HEAD/OPTIONS) and non-admin paths; a single
 * shared bucket otherwise.
 *
 * Why path-aware at the app level: per the 5/13 app review (P0.7),
 * only 12 of ~89 admin route files defined their own per-route
 * limiter. Touching the remaining 77 individually is fragile; one
 * global cap covers them all and any new admin router that lands
 * later is automatically gated.
 *
 * Why IP and not adminUserId: this middleware runs BEFORE the
 * per-router `requireAdmin` middleware that populates
 * `req.adminUserId`, so an IP key is what's actually available
 * here. Per-route limiters that need a tighter, admin-scoped
 * budget keep their existing keyFn — they fire AFTER `requireAdmin`
 * and apply on top of this safety net.
 *
 * Default budget: 300 requests / 60 seconds (5 RPS sustained) per
 * IP across all admin mutations on this process. Well above any
 * honest CSR workflow; well below what a session-stealing attacker
 * needs to flood any single endpoint.
 */
const ADMIN_SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);
// See the matching constants in middlewares/csrf.ts for the rationale.
// Express routes are case-insensitive by default, but `req.path`
// preserves the original casing — a mixed-case URL otherwise bypasses
// this gate.
const ADMIN_LC_PATH_PREFIXES = ["/api/admin", "/resupply-api/admin"] as const;

function isAdminMutationRequest(req: import("express").Request): boolean {
  if (ADMIN_SAFE_METHODS.has(req.method)) return false;
  const lc = req.path.toLowerCase();
  for (const prefix of ADMIN_LC_PATH_PREFIXES) {
    if (lc === prefix || lc.startsWith(`${prefix}/`)) return true;
  }
  return false;
}

export function adminMutationLooseLimit(): RequestHandler {
  const inner = rateLimit({
    windowMs: 60 * 1000,
    max: 300,
    name: "admin_mutation_loose_ip",
  });
  return (req, res, next) => {
    if (!isAdminMutationRequest(req)) {
      next();
      return;
    }
    inner(req, res, next);
  };
}
