// Shared client-side email-shape check for inline form validation.
//
// This is a *format* guard for UX only (it powers the inline
// aria-invalid / aria-describedby field errors on the auth + consent
// forms) — it is NOT an authority on deliverability. The server still
// re-validates every address. The pattern mirrors the one consent.tsx
// shipped first: a single `local@domain.tld` shape with no embedded
// whitespace, which rejects the overwhelming majority of typos without
// the false-negatives a stricter RFC-5322 regex produces.

export const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** True when `value` (trimmed) looks like a well-formed email address. */
export function isValidEmail(value: string): boolean {
  return EMAIL_RE.test(value.trim());
}
