// IP-keyed rate-limit middleware for the in-house /auth/* router.
// Uses `express-rate-limit` so the limiter is recognised by static
// analysis (CodeQL `js/missing-rate-limiting`).
//
// This is defence-in-depth on top of the DB-backed per-email/per-IP
// login-attempt limiter in `rate-limit.ts`: we want to throttle every
// public auth verb (sign-up, sign-in, verify-email, forgot-password,
// reset-password, change-password) at the HTTP edge so a tight loop
// hammering one endpoint cannot DoS the auth path before the
// per-handler logic ever runs.
//
// The middleware deliberately does NOT include the /me, /sign-out,
// or /csrf routes — those are read-only or already gated by a session
// cookie, so rate-limiting them adds noise without security benefit.

import expressRateLimit, { ipKeyGenerator } from "express-rate-limit";
import type { Request, RequestHandler } from "express";

export interface AuthRateLimitOptions {
  /** Window length in milliseconds. */
  windowMs: number;
  /** Max requests allowed per IP per window. */
  max: number;
  /**
   * Stable name for logs and the response body. Helps ops grep across
   * many limiters in the same process.
   */
  name: string;
}

export function makeAuthRateLimiter(
  opts: AuthRateLimitOptions,
): RequestHandler {
  return expressRateLimit({
    windowMs: opts.windowMs,
    limit: opts.max,
    standardHeaders: "draft-7",
    legacyHeaders: false,
    keyGenerator: (req: Request) => ipKeyGenerator(req.ip ?? "0.0.0.0"),
    message: {
      error: "too_many_requests",
      limiter: opts.name,
      message:
        "You're going a little fast. Please wait a moment and try again.",
    },
  });
}
