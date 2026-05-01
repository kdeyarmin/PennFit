// Double-submit CSRF token helpers.
//
// At sign-in we issue both `pf_session` (HttpOnly) and `pf_csrf`
// (readable). For state-changing requests, the SPA reads `pf_csrf`
// and echoes it as the `X-PF-CSRF` header. The server checks that
// the header value equals the cookie value, in constant time.
//
// Why double-submit and not a per-request token rotated server-
// side: rotation creates race conditions between concurrent tabs.
// Double-submit gives identical security against the threat we
// actually face (cross-site forgeries via cookie auto-attach)
// while staying stateless.

import { timingSafeEqual } from "node:crypto";
import type { Request } from "express";

import { CSRF_COOKIE, CSRF_HEADER, readCookie } from "./cookies";

export interface CsrfCheckResult {
  ok: boolean;
  reason?: "missing_cookie" | "missing_header" | "mismatch";
}

/**
 * Verify that the request carries matching `pf_csrf` cookie and
 * `X-PF-CSRF` header values. Uses constant-time equality.
 *
 * Returns `ok:false` rather than throwing — the handler decides the
 * 4xx response shape. We keep the failure REASON internal (logged,
 * not surfaced to the browser) to avoid leaking which half was
 * missing.
 */
export function checkCsrf(req: Request): CsrfCheckResult {
  const cookie = readCookie(req, CSRF_COOKIE);
  if (!cookie) return { ok: false, reason: "missing_cookie" };
  const headerRaw = req.headers[CSRF_HEADER];
  const header = Array.isArray(headerRaw) ? headerRaw[0] : headerRaw;
  if (!header) return { ok: false, reason: "missing_header" };

  const a = Buffer.from(cookie, "utf8");
  const b = Buffer.from(header, "utf8");
  if (a.length !== b.length) {
    return { ok: false, reason: "mismatch" };
  }
  return timingSafeEqual(a, b)
    ? { ok: true }
    : { ok: false, reason: "mismatch" };
}
