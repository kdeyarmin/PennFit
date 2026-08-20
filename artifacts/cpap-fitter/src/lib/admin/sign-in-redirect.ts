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
const AUTH_PATHS: ReadonlySet<string> = new Set([
  "/admin/sign-in",
  "/admin/forgot-password",
  "/admin/reset-password",
  "/admin/verify-email",
]);

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
  if (raw.startsWith("//") || raw.startsWith("/\\")) {
    return ADMIN_DEFAULT_LANDING;
  }
  const pathOnly = raw.split(/[?#]/)[0] ?? "";
  if (AUTH_PATHS.has(pathOnly)) return ADMIN_DEFAULT_LANDING;
  return raw;
}

/** Read + sanitize the `?redirect=` target off the current URL. */
export function readAdminRedirectTarget(): string {
  if (typeof window === "undefined") return ADMIN_DEFAULT_LANDING;
  return sanitizeAdminRedirect(
    new URLSearchParams(window.location.search).get("redirect"),
  );
}

/** The path the browser is on right now, query + hash included. */
function currentPathWithQuery(): string {
  if (typeof window === "undefined") return "";
  const { pathname, search, hash } = window.location;
  return `${pathname}${search}${hash}`;
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
