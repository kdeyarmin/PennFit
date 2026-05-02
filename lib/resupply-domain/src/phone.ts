/**
 * Phone-number normalization to strict E.164.
 *
 * Lives in resupply-domain (pure, no I/O) because callers across the
 * worker, the API, and CSV import paths all need the same parsing
 * rules. Earlier revisions kept this colocated with the (now-deleted)
 * phone-HMAC helpers in resupply-db; with the HMAC table gone, the
 * lone normalization function belongs in the domain layer.
 */

/**
 * Normalize an arbitrary phone-number string to strict E.164
 * (`+<digits>`).
 *
 * Accepts:
 *   - Already-E.164 strings: `+12155551212` → `+12155551212`
 *   - 10-digit NANP numbers:  `2155551212`  → `+12155551212`
 *   - 11-digit NANP w/ leading 1: `12155551212` → `+12155551212`
 *   - Punctuation/whitespace: `(215) 555-1212`, `215-555-1212`,
 *     `+1 (215) 555-1212` all normalize to `+12155551212`.
 *
 * Returns `null` for anything that does not parse cleanly. We
 * deliberately do NOT throw — callers (especially the inbound-
 * webhook path) want to branch on "could not normalize" without
 * catching exceptions.
 *
 * E.164 spec: country code + subscriber number, total 8–15 digits
 * after the `+`. We enforce that range; sub-8 is too short to be a
 * real number, super-15 is over-spec.
 *
 * NOTE: We intentionally do NOT validate that the country code is
 * assigned, or that the subscriber number is dialable — that's a
 * carrier-network concern, not a normalization concern. A bogus
 * number will normalize cleanly here, then fail downstream when
 * Twilio refuses to route it.
 */
export function normalizeE164(raw: string | null | undefined): string | null {
  if (raw == null) return null;
  const trimmed = String(raw).trim();
  if (!trimmed) return null;

  const hasPlus = trimmed.startsWith("+");
  const digits = trimmed.replace(/\D/g, "");

  if (hasPlus) {
    if (digits.length < 8 || digits.length > 15) return null;
    return "+" + digits;
  }

  // NANP shortcuts: 10 digits → assume +1; 11 digits with leading 1 → +<digits>.
  if (digits.length === 10) return "+1" + digits;
  if (digits.length === 11 && digits.startsWith("1")) return "+" + digits;

  return null;
}
