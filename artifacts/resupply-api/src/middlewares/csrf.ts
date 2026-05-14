// requireCsrf — Express middleware that gates state-changing requests
// on a double-submit CSRF check.
//
// The check itself lives in `@workspace/resupply-auth.checkCsrf` (see
// `lib/resupply-auth/src/csrf.ts`). It compares the `pf_csrf` cookie
// to the `X-PF-CSRF` header in constant time. We wrap it here so route
// files can compose it with `requireSignedIn` / `requireAdmin` without
// each handler reinventing the same try/catch + 403 envelope.
//
// Why this middleware now: storefront state-changing routes (POST
// /api/orders, the storefront-mounted admin endpoints, etc.) accept
// cookie-based session auth but had no CSRF gate — see P1.3 in
// `docs/app-review-2026-05-13.md`. The cpap-fitter storefront SPA
// already attaches the `X-PF-CSRF` header on POST/PATCH/DELETE/PUT
// via `lib/api-client-react/src/storefront/custom-fetch.ts`, so
// enabling this middleware is purely a server-side gate addition with
// no client coordination needed.
//
// What we deliberately DON'T do here:
//   * Issue tokens. Token seeding is the auth flow's job
//     (`GET /auth/csrf` + sign-in handlers).
//   * Apply this to anonymous mutation endpoints. A request with no
//     session cookie has nothing for an attacker to replay; double-
//     submit on those routes would just block honest no-cookie
//     callers.
//   * Apply this to capability-token-gated routes (e.g.
//     `/reminders/manage`) — the URL-bound token IS the auth, and
//     cookies aren't consulted.

import type { NextFunction, Request, RequestHandler, Response } from "express";

import {
  checkCsrf,
  readCookie,
  SESSION_COOKIE,
} from "@workspace/resupply-auth";

function denyCsrf(req: Request, res: Response, reason?: string): void {
  // Best-effort structured log so ops can grep by reason without the
  // browser ever seeing it. `req.log` is the pino-http child logger
  // attached in app.ts; it's present on every real request but may be
  // undefined in unit tests that synthesize a Request.
  req.log?.warn?.(
    {
      event: "csrf_failed",
      reason,
      method: req.method,
      path: req.path,
    },
    "csrf check failed",
  );
  res.status(403).json({
    error: "csrf_failed",
    message:
      "Your request failed a security check. Please refresh the page and try again.",
  });
}

/**
 * Gate a route on a successful double-submit CSRF check. Apply AFTER
 * the session-attach middleware so the route's auth gate runs first.
 *
 * Use this on routes that REQUIRE an authenticated session (admin
 * endpoints, signed-in customer mutations). For routes that mix
 * authenticated and anonymous traffic (e.g. `POST /api/orders`,
 * which lets anonymous patients submit mask orders), use
 * `requireCsrfWhenSession` instead — a request with no session cookie
 * has no cookie-replay attack surface and shouldn't be blocked.
 *
 * On failure: 403 with `{ error: "csrf_failed", message: "..." }`.
 * The exact reason (missing cookie, missing header, mismatch) is
 * logged via `req.log` (when present) but NOT included in the
 * response body, matching the policy in `lib/resupply-auth/src/csrf.ts`.
 *
 * Example:
 *   router.post(
 *     "/admin/users/invite",
 *     requireAdminOnly,
 *     requireCsrf,
 *     async (req, res) => { ... },
 *   );
 */
export const requireCsrf: RequestHandler = (
  req: Request,
  res: Response,
  next: NextFunction,
): void => {
  const result = checkCsrf(req);
  if (result.ok) {
    next();
    return;
  }
  denyCsrf(req, res, result.reason);
};

/**
 * Conditional variant: enforce double-submit CSRF only when the
 * request carries a session cookie (`pf_session`). Pass-through for
 * anonymous requests.
 *
 * Rationale: the cookie-replay threat model requires an attacker to
 * ride on a victim's already-authenticated session. A request with no
 * `pf_session` cookie carries no auth, has nothing to ride, and
 * blocking it on CSRF would also block legitimate anonymous callers
 * (e.g. a guest patient submitting an order). For mixed-auth routes
 * like `POST /api/orders`, this preserves the anonymous flow while
 * still protecting signed-in customers from cross-origin forgery.
 *
 * Pairs naturally with `attachSignedIn` (the storefront's soft-auth
 * middleware) which similarly proceeds when no session is present.
 */
export const requireCsrfWhenSession: RequestHandler = (
  req: Request,
  res: Response,
  next: NextFunction,
): void => {
  if (!readCookie(req, SESSION_COOKIE)) {
    next();
    return;
  }
  const result = checkCsrf(req);
  if (result.ok) {
    next();
    return;
  }
  denyCsrf(req, res, result.reason);
};
