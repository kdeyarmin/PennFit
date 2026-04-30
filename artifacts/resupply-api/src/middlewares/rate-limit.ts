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
  /** Max requests allowed per IP per window. */
  max: number;
  /**
   * Stable name for logs and the response body. Helps ops grep
   * across many limiters in the same process.
   */
  name: string;
}

export function rateLimit(opts: RateLimitOptions): RequestHandler {
  const buckets = new Map<string, Bucket>();

  return (req, res, next) => {
    const now = Date.now();
    // Express's `req.ip` honors `trust proxy`; if the app hasn't
    // opted in, fall back to the socket address. We never want to
    // throw here (a logging hiccup mustn't 500 a production call).
    const key = req.ip ?? req.socket.remoteAddress ?? "unknown";

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
