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

import { rateLimit as expressRateLimit } from "express-rate-limit";

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
export type AdminRateLimitPreset =
  | "destroy"
  | "bulk"
  | "sensitive"
  | "mutation"
  | "query";

const PRESETS: Record<AdminRateLimitPreset, { max: number; windowMs: number }> =
  {
    /** One-way / financial / PHI destruction. Conservative. */
    destroy: { max: 10, windowMs: 60 * 60 * 1000 },
    /** Fan-out operations (campaign sends, mass scans). */
    bulk: { max: 10, windowMs: 60 * 60 * 1000 },
    /** Sensitive mutations (template overrides, role changes). */
    sensitive: { max: 30, windowMs: 60 * 60 * 1000 },
    /** Typical create/update — the default. */
    mutation: { max: 60, windowMs: 60 * 60 * 1000 },
    /**
     * Read endpoints (dashboard lists / worklists). A generous cap so
     * normal SPA polling never trips it, while keeping an authorized
     * GET from being truly unbounded (CodeQL "missing rate limiting" /
     * "sensitive data read from GET"). 600/hr per actor.
     */
    query: { max: 600, windowMs: 60 * 60 * 1000 },
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

// Shared read-endpoint limiter for admin GETs.
//
// Built DIRECTLY from `express-rate-limit` (not the local ./rate-limit
// wrapper or the adminRateLimit factory above) and placed BEFORE the
// auth gate on read routes. CodeQL's js/missing-rate-limiting query only
// recognizes the upstream express-rate-limit middleware at the call
// site — it can't trace our factory wrappers — so the wrapped limiters
// kept re-flagging authenticated GET handlers as "missing rate
// limiting" / "sensitive data read from GET". This direct instance is
// recognized, while a generous 600/window cap means normal dashboard
// polling never trips it. Keyed per admin actor (req.adminUserId) once
// auth runs, with an IP fallback for the pre-auth window.
export const adminReadRateLimiter: RequestHandler = expressRateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: 600,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) =>
    (req as { adminUserId?: string }).adminUserId ??
    req.ip ??
    req.socket.remoteAddress ??
    "unknown",
});

// Shared write-endpoint limiter for admin MUTATIONS (POST/PATCH/PUT/
// DELETE) on routers mounted OUTSIDE the `/admin` path prefix — the
// conversation, patient, episode, and email-send routers under
// `/resupply-api/*`. Those never match the app-level
// `adminMutationLooseLimit` (which is keyed off the `/admin` prefix),
// so before this they had no rate limiter at all.
//
// Same construction + rationale as `adminReadRateLimiter`: built
// DIRECTLY from `express-rate-limit` (not the local `rateLimit()` /
// `adminRateLimit()` wrappers) because CodeQL's js/missing-rate-limiting
// query only recognises the upstream middleware at the call site. Just
// as importantly, it must be mounted BEFORE `requireAdmin`: that gate
// performs a DB-backed session lookup, so a limiter placed AFTER it
// leaves the session read unprotected (CodeQL flags the `requireAdmin`
// line, and a stolen-session flood still hits the DB). Running first
// also caps an unauthenticated flood before it reaches the auth lookup.
//
// Keyed per admin actor once auth runs, with an IP fallback for the
// pre-auth window (the same posture the mfa.ts IP limiter uses).
// 300/hr is well above any honest CSR mutation cadence while bounding a
// runaway client or a stolen session. Routes that need a tighter,
// action-specific budget (e.g. episodes/bulk-send's 10/hr per-admin cap)
// keep their own limiter AFTER `requireAdmin`, layered on top of this net.
export const adminWriteRateLimiter: RequestHandler = expressRateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: 300,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) =>
    (req as { adminUserId?: string }).adminUserId ??
    req.ip ??
    req.socket.remoteAddress ??
    "unknown",
});
