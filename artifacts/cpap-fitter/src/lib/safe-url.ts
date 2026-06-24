// Guard for rendering a server/API-supplied URL into an anchor `href`.
//
// A value that reaches `href` can be a `javascript:` or `data:` URL, which the
// browser will execute on click (stored-XSS / open-redirect if the backend
// ever returns a malicious or mis-stored value). Only allow http(s) absolute
// URLs and same-origin relative paths (a single leading `/`, not `//host`).
// Anything else returns `undefined` so the caller renders an inert element.

export function safeHref(url: string | null | undefined): string | undefined {
  if (typeof url !== "string") return undefined;
  const trimmed = url.trim();
  if (trimmed.length === 0) return undefined;
  // Same-origin relative path: one leading slash, never a protocol-relative
  // "//host" or a backslash trick.
  if (trimmed.startsWith("/")) {
    return trimmed.startsWith("//") || trimmed.includes("\\")
      ? undefined
      : trimmed;
  }
  try {
    const u = new URL(trimmed, window.location.origin);
    return u.protocol === "http:" || u.protocol === "https:"
      ? trimmed
      : undefined;
  } catch {
    return undefined;
  }
}
