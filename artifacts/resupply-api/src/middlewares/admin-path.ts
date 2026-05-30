// Shared admin-path matcher used by both the app-level CSRF gate
// (middlewares/csrf.ts: requireCsrfOnAdminMutations) and the
// app-level loose IP rate limit (middlewares/rate-limit.ts:
// adminMutationLooseLimit).
//
// Pulled out as a separate module because the two middlewares MUST
// agree on what counts as an admin mutation. If one of them drifts
// (e.g., a new admin tree prefix lands in one but not the other),
// requests could be CSRF-gated but not rate-limited (or vice versa)
// — a silent security gap that's hard to catch in review. A single
// source of truth eliminates the drift.
//
// Why path matching (not Express route metadata):
//   The two middlewares mount at the app level, BEFORE any router
//   resolves the request to a specific handler. We don't yet know
//   which router will match. Path-prefix matching is the only
//   information available at that mount point.
//
// Why lowercase-normalized:
//   Express's default routing is case-insensitive (`case sensitive
//   routing` is off), so a request to `POST /API/ADMIN/users/invite`
//   still hits the route registered at `/api/admin/users/invite` —
//   but `req.path` preserves the original casing. A naive
//   case-sensitive `startsWith` would miss the mixed-case request
//   and silently bypass the gate.

import type { Request } from "express";

/** HTTP methods that don't change state and therefore don't need
 *  CSRF or per-request rate limiting at the admin gate. */
export const ADMIN_SAFE_HTTP_METHODS: ReadonlySet<string> = new Set([
  "GET",
  "HEAD",
  "OPTIONS",
]);

/** Lowercase prefixes of the two admin mount trees. */
export const ADMIN_PATH_PREFIXES = [
  "/api/admin",
  "/resupply-api/admin",
] as const;

/** Lowercase prefixes of the two shop mount trees. Shop routes mix
 *  anonymous traffic (guest checkout, public product browse) with
 *  signed-in customer traffic; the CSRF gate paired with this matcher
 *  is conditional (`requireCsrfWhenSession`) so anonymous callers stay
 *  unaffected. */
export const SHOP_PATH_PREFIXES = ["/api/shop", "/resupply-api/shop"] as const;

/** Lowercase prefixes of the patient-portal (`/me/...`) mount tree.
 *  These routes (e.g. `POST /api/me/payments/checkout-session`,
 *  `POST /api/me/sleep-coach`) authenticate purely via the `pf_session`
 *  cookie through the storefront `attachSignedIn` shim — exactly like
 *  the shop tree — so a signed-in `/me/*` mutation needs the same
 *  conditional-CSRF gate. They are mounted at `/api` (NOT under
 *  `/api/shop`), so `isShopMutationRequest` alone missed them, leaving
 *  cookie-authed state-changing endpoints with no CSRF protection. */
export const ME_PATH_PREFIXES = ["/api/me", "/resupply-api/me"] as const;

/**
 * True iff `req` is a state-changing request to an admin-tree path.
 *
 * Match rules:
 *   * Method must NOT be in `ADMIN_SAFE_HTTP_METHODS`.
 *   * Lowercased `req.path` must either equal one of
 *     `ADMIN_PATH_PREFIXES` exactly (defensive: no route mounts at
 *     the bare admin path today, but the contract should hold) or
 *     start with `<prefix>/...`. Look-alikes like `/api/admin-export`
 *     correctly fall through.
 */
export function isAdminMutationRequest(req: Request): boolean {
  if (ADMIN_SAFE_HTTP_METHODS.has(req.method)) return false;
  const lc = req.path.toLowerCase();
  for (const prefix of ADMIN_PATH_PREFIXES) {
    if (lc === prefix || lc.startsWith(`${prefix}/`)) return true;
  }
  return false;
}

/**
 * True iff `req` is a state-changing request to a shop-tree path.
 *
 * Same matcher contract as `isAdminMutationRequest`. Used by the
 * app-level conditional-CSRF gate; signed-in traffic must carry the
 * `X-PF-CSRF` header (the storefront SPA already attaches it on every
 * non-GET fetch — see lib/api-client-react/src/storefront/custom-fetch.ts
 * and artifacts/cpap-fitter/src/lib/shop-api.ts), while anonymous
 * callers (no `pf_session` cookie) pass through unchallenged.
 */
export function isShopMutationRequest(req: Request): boolean {
  if (ADMIN_SAFE_HTTP_METHODS.has(req.method)) return false;
  const lc = req.path.toLowerCase();
  for (const prefix of SHOP_PATH_PREFIXES) {
    if (lc === prefix || lc.startsWith(`${prefix}/`)) return true;
  }
  return false;
}

/**
 * True iff `req` is a state-changing request to a storefront tree that
 * accepts `pf_session` cookie auth: the shop tree (`/api/shop`, mixed
 * guest + signed-in) OR the patient-portal tree (`/api/me`, signed-in
 * only). Used by the app-level conditional-CSRF gate so that EVERY
 * cookie-authed storefront mutation — shop and `/me/*` alike — must
 * carry the `X-PF-CSRF` header. Same exact-or-prefixed matcher contract
 * as the sibling matchers (look-alikes like `/api/men` fall through).
 */
export function isStorefrontSessionMutationRequest(req: Request): boolean {
  if (ADMIN_SAFE_HTTP_METHODS.has(req.method)) return false;
  if (isShopMutationRequest(req)) return true;
  const lc = req.path.toLowerCase();
  for (const prefix of ME_PATH_PREFIXES) {
    if (lc === prefix || lc.startsWith(`${prefix}/`)) return true;
  }
  return false;
}
