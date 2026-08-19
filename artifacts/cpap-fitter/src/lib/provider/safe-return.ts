// Where a provider goes after finishing something they were sent to do.
//
// Lives in its own module because it is a security boundary, not a piece
// of page state: the value arrives in a query string, so it is
// attacker-supplied by construction and the one thing it must never
// become is an open redirect off this origin.

/** Only paths inside the provider portal are acceptable destinations. */
const ALLOWED_PREFIX = "/provider/";

/**
 * Narrow a `?return=` parameter to a safe same-origin path, or null.
 *
 * Deliberately a prefix test rather than a `new URL()` parse. Parsing
 * invites the classic mistakes — `//evil.example` and `/\evil.example`
 * are protocol-relative to a browser and would resolve off-origin, and
 * `https://evil.example` parses perfectly well. An allowlisted absolute
 * prefix cannot express any of those.
 */
export function safeReturnTo(search: string): string | null {
  const raw = new URLSearchParams(search).get("return");
  if (!raw) return null;
  // `//host` and `/\host` are protocol-relative; neither survives the
  // prefix test, but they are checked explicitly so the intent is on the
  // page rather than implied.
  if (raw.startsWith("//") || raw.startsWith("/\\")) return null;
  if (!raw.startsWith(ALLOWED_PREFIX)) return null;
  return raw;
}
