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

import {
  isAdminMutationRequest,
  isStorefrontSessionMutationRequest,
} from "./admin-path";

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

/**
 * App-level CSRF gate for admin mutations. Pass-through on:
 *   * safe methods (GET / HEAD / OPTIONS) — no state change to forge.
 *   * absolute paths that are not under an admin tree (`/api/admin/*`
 *     or `/resupply-api/admin/*`). The non-admin storefront paths
 *     either are anonymous (and have no session cookie to replay) or
 *     opt in to CSRF on their own via `requireCsrf` /
 *     `requireCsrfWhenSession`.
 *
 * Mount once at app level *before* the route routers so every new
 * admin mutation that lands in the future is gated automatically —
 * no per-router `requireCsrf` audit needed. The admin SPA already
 * attaches the `X-PF-CSRF` header on every state-changing fetch
 * (see lib/api-client-react/src/admin/custom-fetch.ts), so this is
 * a server-only addition with no client coordination.
 *
 * Both per-router and app-level gates can co-exist; double-checking
 * is harmless because the middleware short-circuits on success.
 *
 * The path+method matcher lives in `./admin-path` so this gate and
 * the loose-IP rate limit gate in `./rate-limit` stay in lockstep
 * on what counts as an admin mutation.
 */
export const requireCsrfOnAdminMutations: RequestHandler = (
  req: Request,
  res: Response,
  next: NextFunction,
): void => {
  if (!isAdminMutationRequest(req)) {
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

/**
 * App-level conditional CSRF gate for storefront-tree mutations (the
 * shop tree AND the patient-portal `/me/*` tree).
 *
 * Difference from `requireCsrfOnAdminMutations`: the storefront mixes
 * anonymous traffic (guest checkout, public product browse) with
 * signed-in customer traffic (`/shop/me/*`, `/me/*`). Anonymous requests
 * carry no `pf_session` cookie to replay, so requiring CSRF on them
 * would block legitimate no-cookie callers without any security benefit.
 * `requireCsrfWhenSession` semantics handle both: pass-through when
 * no session cookie is present, enforce when one is.
 *
 * Covers BOTH `/api/shop` and `/api/me` (see
 * `isStorefrontSessionMutationRequest`): the patient-portal payment and
 * sleep-coach routers are mounted at `/api/me/*`, NOT under `/api/shop`,
 * so the original shop-only matcher left e.g.
 * `POST /api/me/payments/checkout-session` as a cookie-authed mutation
 * with no CSRF protection.
 *
 * Mount once at app level *before* the storefront routers so any future
 * `/shop/...` or `/me/...` mutation is gated automatically. The
 * cpap-fitter SPA's hand-rolled fetch helpers
 * (artifacts/cpap-fitter/src/lib/shop-api.ts and me-billing-api.ts) and
 * the generated client
 * (lib/api-client-react/src/storefront/custom-fetch.ts) attach the
 * `X-PF-CSRF` header on every state-changing fetch.
 *
 * Per-router `requireCsrf` calls remain — double-checking is harmless
 * because the middleware short-circuits on success.
 */
export const requireCsrfWhenSessionOnShopMutations: RequestHandler = (
  req: Request,
  res: Response,
  next: NextFunction,
): void => {
  if (!isStorefrontSessionMutationRequest(req)) {
    next();
    return;
  }
  // No session cookie ⇒ anonymous traffic ⇒ no cookie-replay attack
  // surface. Pass through so guest checkout / unauthenticated form
  // submissions still work.
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
