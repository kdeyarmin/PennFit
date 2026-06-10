// Cookie helpers — keeps the `pf_session` and `pf_csrf` cookie
// formats in one place so the handlers and the middleware can't
// disagree about names, flags, or expiry.

import type { Request, Response } from "express";

export const SESSION_COOKIE = "pf_session";
export const CSRF_COOKIE = "pf_csrf";
export const CSRF_HEADER = "x-pf-csrf";

export interface CookieOptions {
  /** Pass NODE_ENV !== 'development' here. */
  secure: boolean;
  /** Cookie max-age in seconds. */
  maxAgeSeconds: number;
  /**
   * Cookie path. Defaults to "/" so the cookie travels with every
   * sub-route under the app. We do NOT scope to /auth — the
   * dashboard reads /auth/me from anywhere, so the cookie has to be
   * sent on every same-origin request.
   */
  path?: string;
}

/**
 * Build the `Set-Cookie` value for the session cookie. Centralized
 * so the flags are uniform across every issue site.
 *
 * - HttpOnly: blocks JS from reading the value (xss defense).
 * - Secure: cookie only sent over HTTPS in production.
 * - SameSite=Lax: defends against classic CSRF on top-level GET
 *   navigations while still allowing the cookie to ride along on
 *   same-origin fetches.
 */
export function buildSessionCookie(
  rawToken: string,
  opts: CookieOptions,
): string {
  return [
    `${SESSION_COOKIE}=${rawToken}`,
    "HttpOnly",
    opts.secure ? "Secure" : "",
    "SameSite=Lax",
    `Path=${opts.path ?? "/"}`,
    `Max-Age=${opts.maxAgeSeconds}`,
  ]
    .filter(Boolean)
    .join("; ");
}

/**
 * Build the CSRF companion cookie. Crucially NOT HttpOnly — the SPA
 * has to read its value to echo into the X-PF-CSRF header. SameSite
 * Lax is sufficient: an attacker on a cross-site origin cannot
 * read the cookie (browser same-origin policy) and therefore can't
 * forge the matching header.
 */
export function buildCsrfCookie(rawToken: string, opts: CookieOptions): string {
  return [
    `${CSRF_COOKIE}=${rawToken}`,
    opts.secure ? "Secure" : "",
    "SameSite=Lax",
    `Path=${opts.path ?? "/"}`,
    `Max-Age=${opts.maxAgeSeconds}`,
  ]
    .filter(Boolean)
    .join("; ");
}

/** Set-Cookie header that clears the session cookie immediately. */
export function buildClearCookies(opts: { secure: boolean }): string[] {
  const flags = `Path=/; Max-Age=0; ${opts.secure ? "Secure; " : ""}SameSite=Lax`;
  return [
    `${SESSION_COOKIE}=; HttpOnly; ${flags}`,
    `${CSRF_COOKIE}=; ${flags}`,
  ];
}

/**
 * Read a single cookie value out of the `Cookie` request header.
 * We avoid `cookie-parser` (or `req.cookies`) so this lib doesn't
 * impose middleware-order requirements on consumers.
 */
export function readCookie(req: Request, name: string): string | null {
  const header = req.headers.cookie;
  if (!header) return null;
  // Parse minimally: split on `; `, find `name=`. Cookie values
  // may contain `=` (e.g. base64 padding), so we split on the
  // first `=` only.
  for (const part of header.split(";")) {
    const trimmed = part.trim();
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq);
    if (key === name) {
      const raw = trimmed.slice(eq + 1);
      // decodeURIComponent throws URIError on malformed percent-escapes
      // (e.g. a `pf_session=%` set by another app on a shared parent
      // domain or a buggy intermediary). readCookie feeds requireSession,
      // checkCsrf, AND sign-out — an uncaught throw turns all three into
      // persistent 500s and the clear-cookie path never runs, wedging
      // the browser until cookies are cleared by hand. Our own cookie
      // values are base64url and never need decoding, so falling back
      // to the raw slice is safe (it then simply fails session lookup
      // as a 401, the correct outcome for a corrupt cookie).
      try {
        return decodeURIComponent(raw);
      } catch {
        return raw;
      }
    }
  }
  return null;
}

/** Append a `Set-Cookie` value to the response without clobbering existing ones. */
export function appendSetCookie(res: Response, value: string | string[]): void {
  const existing = res.getHeader("Set-Cookie");
  const next: string[] = [];
  if (Array.isArray(existing)) {
    next.push(...existing.map(String));
  } else if (typeof existing === "string") {
    next.push(existing);
  }
  if (Array.isArray(value)) {
    next.push(...value);
  } else {
    next.push(value);
  }
  res.setHeader("Set-Cookie", next);
}
