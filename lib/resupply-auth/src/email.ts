// Email-address normalization. Centralized here because it has to
// be applied consistently at every entry point (sign-up, sign-in,
// invite, allow-list parsing, /forgot-password lookup) — a single
// inconsistency creates either a duplicate-account bug or a
// case-sensitive lockout.
//
// We keep the rules deliberately simple: trim + toLowerCase. We do
// NOT strip dots from gmail addresses or treat `+` aliases as
// equivalent — those normalizations conflict with how some
// providers actually deliver mail.

// Use [^\s@.]+ (no dots) for each domain label so the quantifiers
// are non-overlapping and backtracking is bounded (no ReDoS).
const EMAIL_BASIC_RE =
  /^[^\s@]+@[^\s@.]+(?:\.[^\s@.]+)+$/u;

/** True if the input looks like an email at all. */
export function looksLikeEmail(input: unknown): input is string {
  return typeof input === "string" && EMAIL_BASIC_RE.test(input.trim());
}

/**
 * Normalize for storage / lookup. Throws on inputs that don't
 * look like an email — callers should validate at the API
 * boundary before passing here.
 */
export function normalizeEmail(input: string): string {
  if (!looksLikeEmail(input)) {
    throw new Error("not a valid email address");
  }
  return input.trim().toLowerCase();
}
