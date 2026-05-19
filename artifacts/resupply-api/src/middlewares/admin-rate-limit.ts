// adminRateLimit — per-actor rate limit for admin write routes.
//
// Why this wraps the existing rateLimit():
//   ~14 admin route files already use the base `rateLimit()` factory
//   with hand-rolled options and keying on `req.adminUserId`. The
//   remaining ~87 admin route files have no rate limit at all. A
//   compromised admin session, a runaway script, or a buggy admin
//   client can drive unbounded mutations against those routes.
//
//   This wrapper:
//     1. Defaults the key extractor to `req.adminUserId` so every
//        caller doesn't reinvent the same closure.
//     2. Exposes a small set of named presets so per-route configs
//        stay consistent across the admin tree without bespoke
//        windowMs/max numbers at every call site.
//     3. Keeps the underlying response shape (429 + Retry-After
//        + {error,limiter,retryAfterSeconds,message}) unchanged
//        from rateLimit() so existing admin clients don't need
//        to learn a new error envelope.
//
// Apply AFTER requireAdmin so `req.adminUserId` is populated. A
// missing actor id (which shouldn't happen if the chain is wired
// correctly) keys to "no-actor" so a single misconfigured route
// still rate-limits as a group rather than disabling itself.

import type { RequestHandler } from "express";

import { rateLimit } from "./rate-limit";

/**
 * Named presets so admin routes don't have to pick a windowMs/max
 * pair in isolation. Add a new preset (or override `max`/`windowMs`
 * on the call site) when a route needs a non-default cap.
 *
 * Picked from the rates already in use across the 14 ad-hoc admin
 * limiters (10/hr for one-way / financial / bulk; 30/hr for
 * sensitive mutations; 60/hr for typical mutations).
 */
export type AdminRateLimitPreset = "destroy" | "bulk" | "sensitive" | "mutation";

const PRESETS: Record<
  AdminRateLimitPreset,
  { max: number; windowMs: number }
> = {
  /** One-way / financial / PHI destruction. Conservative. */
  destroy: { max: 10, windowMs: 60 * 60 * 1000 },
  /** Fan-out operations (campaign sends, mass scans). */
  bulk: { max: 10, windowMs: 60 * 60 * 1000 },
  /** Sensitive mutations (template overrides, role changes). */
  sensitive: { max: 30, windowMs: 60 * 60 * 1000 },
  /** Typical create/update — the default. */
  mutation: { max: 60, windowMs: 60 * 60 * 1000 },
};

export interface AdminRateLimitOptions {
  /**
   * Stable identifier — surfaces in the 429 body and structured
   * `rate_limit_exceeded` log line. Use `<feature>.<action>` form
   * (e.g. "shop_returns.refund") so a `grep limiter=` across logs
   * groups by route family.
   */
  name: string;
  /** Preset rate; default = "mutation" (60/hr). */
  preset?: AdminRateLimitPreset;
  /** Override max if a route needs a non-preset cap. */
  max?: number;
  /** Override window if a route needs a different period. */
  windowMs?: number;
}

/**
 * Create an Express middleware that rate-limits requests per admin actor.
 *
 * Use this after `requireAdmin` so `req.adminUserId` is populated; if the actor id
 * is missing the middleware shares a single bucket using the key `"no-actor"`.
 *
 * @param opts - Configuration for the limiter: `name` is a required stable identifier
 *   used in naming/reporting; `preset`, `max`, and `windowMs` control the cap and window.
 * @returns An Express request handler that applies the configured per-actor rate limit.
 */
export function adminRateLimit(opts: AdminRateLimitOptions): RequestHandler {
  const preset = PRESETS[opts.preset ?? "mutation"];
  return rateLimit({
    name: opts.name,
    max: opts.max ?? preset.max,
    windowMs: opts.windowMs ?? preset.windowMs,
    // Admin actor id is set by requireAdmin (see middlewares/requireAdmin).
    // Fall back to "no-actor" so a misconfigured route still applies the
    // limit as a single bucket rather than failing open.
    keyFn: (req) => req.adminUserId ?? "no-actor",
  });
}
