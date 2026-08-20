// Post-sign-in destination for the STAFF / OPERATOR auth flow.
//
// The admin sign-in page used to hardcode `setLocation("/admin")` on success,
// so every entry point that bounced a signed-out visitor to /admin/sign-in
// silently dropped where they were actually headed.
//
// The most visible casualty was the Breathe marketing footer's "Super admin
// login" link: it points at /platform, the platform console redirects a
// signed-out visitor to /admin/sign-in, and signing in then dumped the
// operator into the TENANT console (/admin) instead of the cross-tenant
// platform console they clicked toward — so the link read as simply broken.
//
// This mirrors the storefront's existing `?redirect=` convention in
// pages/sign-in.tsx and keeps the same sanitizer posture. The two surfaces
// differ only in their default landing path and in which auth pages they
// refuse to bounce back into.

/** Where a staff sign-in lands when no (valid) destination was carried. */
export const ADMIN_DEFAULT_LANDING = "/admin";

/** The staff sign-in page itself. */
export const ADMIN_SIGN_IN_PATH = "/admin/sign-in";

// An auth page is never a valid post-sign-in destination — returning to one
// would bounce a freshly signed-in operator straight back into the flow they
// just finished.
//
// This covers the canonical staff auth pages AND the "what would someone
// type?" aliases that redirect INTO them (App.tsx): /admin/login and
// /admin/signin redirect to /admin/sign-in outright, and bare /login and
// /signin resolve there too on the platform home host. Matching only the
// canonical paths would let an alias slip through and land the operator back
// on the sign-in form.
const AUTH_PATHS: ReadonlySet<string> = new Set([
  "/admin/sign-in",
  "/admin/forgot-password",
  "/admin/reset-password",
  "/admin/verify-email",
  "/admin/login",
  "/admin/signin",
  "/login",
  "/signin",
]);

/**
 * Normalize a path for the AUTH_PATHS lookup only: lowercased, with trailing
 * slashes dropped so "/admin/sign-in/" is recognized as the auth page it is.
 *
 * Only the COMPARISON is normalized — `sanitizeAdminRedirect` returns the
 * caller's original string, so a legitimate destination keeps its exact form
 * (case, query, and hash included).
 */
function normalizeForAuthCheck(pathOnly: string): string {
  const trimmed = pathOnly.toLowerCase().replace(/\/+$/, "");
  return trimmed === "" ? "/" : trimmed;
}

/**
 * Sanitize a caller-supplied post-sign-in destination.
 *
 * Honors ONLY same-origin absolute paths: a single leading "/". Protocol-
 * relative ("//evil.com"), backslash-smuggled ("/\evil.com" — normalized to
 * "//" by some browsers), and absolute "http(s)://" targets are all rejected
 * so this can never become an open redirect. Auth pages fall back to the
 * default landing.
 */
export function sanitizeAdminRedirect(raw: string | null | undefined): string {
  if (!raw || !raw.startsWith("/")) return ADMIN_DEFAULT_LANDING;
  // The URL parser STRIPS tab / LF / CR from anywhere in a URL (WHATWG), so
  // "/\t/evil.com" reaches the browser as "//evil.com" — protocol-relative
  // after all, and the leading-slash checks below would never see it. Refuse
  // any C0 control or DEL rather than trying to predict the normalization.
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001F\u007F]/.test(raw)) return ADMIN_DEFAULT_LANDING;
  if (raw.startsWith("//") || raw.startsWith("/\\")) {
    return ADMIN_DEFAULT_LANDING;
  }
  const pathOnly = raw.split(/[?#]/)[0] ?? "";
  if (AUTH_PATHS.has(normalizeForAuthCheck(pathOnly))) {
    return ADMIN_DEFAULT_LANDING;
  }
  return raw;
}

/** Read + sanitize the `?redirect=` target off the current URL. */
export function readAdminRedirectTarget(): string {
  if (typeof window === "undefined") return ADMIN_DEFAULT_LANDING;
  return sanitizeAdminRedirect(
    new URLSearchParams(window.location.search).get("redirect"),
  );
}

/**
 * The router base wouter prepends to every navigation — `<WouterRouter
 * base={basePath}>` in App.tsx, derived from Vite's BASE_URL. Empty string
 * for a root-mounted deploy, which is the norm here (BASE_PATH defaults to
 * "/" on Railway).
 */
function routerBase(): string {
  return (import.meta.env?.BASE_URL ?? "/").replace(/\/$/, "");
}

/**
 * The router-RELATIVE path the browser is on, query + hash included.
 *
 * `window.location.pathname` already carries the router base, but wouter
 * prepends that base again to every `setLocation` / `<Redirect>` target — so
 * encoding the raw pathname would yield "/app/app/platform" on a sub-path
 * deploy and match no route. Strip the base here so what we hand to sign-in
 * is exactly what wouter expects to receive back.
 */
function currentPathWithQuery(): string {
  if (typeof window === "undefined") return "";
  const { pathname, search, hash } = window.location;
  const base = routerBase();
  // Compare case-insensitively, but only on a full segment boundary so a base
  // of "/app" doesn't chew the front off "/apples".
  const lower = pathname.toLowerCase();
  const lowerBase = base.toLowerCase();
  const onBase =
    base !== "" && (lower === lowerBase || lower.startsWith(`${lowerBase}/`));
  const relative = onBase ? pathname.slice(base.length) || "/" : pathname;
  return `${relative}${search}${hash}`;
}

/**
 * Build the sign-in href a gated console should bounce a signed-out visitor
 * to, carrying the destination they asked for so sign-in returns them there.
 *
 * Falls back to the bare sign-in path when there is nothing worth preserving
 * — a destination that sanitizes to the default landing is where sign-in goes
 * anyway, so appending it would only add URL noise.
 */
export function buildAdminSignInHref(destination?: string): string {
  const target = destination ?? currentPathWithQuery();
  if (!target || sanitizeAdminRedirect(target) === ADMIN_DEFAULT_LANDING) {
    return ADMIN_SIGN_IN_PATH;
  }
  return `${ADMIN_SIGN_IN_PATH}?redirect=${encodeURIComponent(target)}`;
}
