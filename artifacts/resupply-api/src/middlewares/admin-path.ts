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
