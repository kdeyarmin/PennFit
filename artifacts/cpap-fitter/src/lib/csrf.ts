// Shared CSRF helper for hand-rolled fetch wrappers under
// `artifacts/cpap-fitter/src/lib/`.
//
// The admin SPA's app-level `requireCsrfOnAdminMutations` middleware
// (artifacts/resupply-api/src/middlewares/csrf.ts) rejects any
// POST/PATCH/PUT/DELETE to `/api/admin/*` or `/resupply-api/admin/*`
// without a matching `X-PF-CSRF` header. The shared admin/storefront
// `customFetch` wrappers attach the header automatically; hand-rolled
// fetch wrappers do not, and must call `csrfHeader()` themselves.
//
// Existing duplicates of this helper (account-api.ts, shop-api.ts,
// fitter-leads-api.ts, rt-overview-api.ts) predate this module; new
// wrappers should import from here instead of duplicating the body.

function getCsrfToken(): string | null {
  if (typeof document === "undefined") return null;
  const match = document.cookie
    .split("; ")
    .find((row) => row.startsWith("pf_csrf="));
  return match ? decodeURIComponent(match.split("=")[1]) : null;
}

/**
 * Returns `{ "X-PF-CSRF": <token> }` when the `pf_csrf` cookie is
 * present, or `{}` otherwise. Spread into the `headers` of any
 * state-changing fetch to an admin-tree path.
 */
export function csrfHeader(): Record<string, string> {
  const token = getCsrfToken();
  return token ? { "X-PF-CSRF": token } : {};
}
