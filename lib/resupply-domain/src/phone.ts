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
 * International numbers: a value that already carries a `+` is accepted
 * for ANY country (only the 8–15-digit range is enforced). A value with
 * NO `+` is treated as North American (NANP) by default — 10 digits → +1,
 * 11 digits w/ leading 1 → +<digits> — and rejected otherwise, UNLESS the
 * caller passes `options.defaultCountryCode` (e.g. "44"), in which case a
 * bare NATIONAL number is prefixed with that country code and validated
 * for E.164 length. The default-country path assumes the input has NO
 * country code of its own (it does not strip a duplicate leading CC).
 *
 * NOTE: We intentionally do NOT validate that the country code is
 * assigned, or that the subscriber number is dialable — that's a
 * carrier-network concern, not a normalization concern. A bogus
 * number will normalize cleanly here, then fail downstream when
 * Twilio refuses to route it.
 */
export interface NormalizeE164Options {
  /** Country code (digits, e.g. "1", "44") prefixed onto a bare,
   *  CC-less national number when the input has no `+` and is not a
   *  NANP 10/11-digit number. Omit for NANP-only behavior. */
  defaultCountryCode?: string;
}

export function normalizeE164(
  raw: string | null | undefined,
  options?: NormalizeE164Options,
): string | null {
  if (raw == null) return null;
  let trimmed = String(raw).trim();
  if (!trimmed) return null;

  // Strip a clearly-marked trailing extension (e.g. "x99", "ext. 99",
  // "extension 99", "#99") BEFORE extracting digits. Otherwise the
  // extension digits get folded into the subscriber number: the
  // +-prefixed path accepted 8–15 digits and silently produced a
  // corrupted E.164, while the no-+ path rejected the same input
  // (asymmetric). SMS/voice can't reach an extension, so we normalize
  // to the base line. Requires a separator before the marker so an
  // infix "x" used as a plain separator ("800x5551212") is untouched.
  const isWhitespace = (ch: string): boolean =>
    ch === " " ||
    ch === "\t" ||
    ch === "\n" ||
    ch === "\r" ||
    ch === "\f" ||
    ch === "\v";
  const isDigit = (ch: string): boolean => ch >= "0" && ch <= "9";
  const stripTrailingExtension = (value: string): string => {
    let end = value.length;
    while (end > 0 && isWhitespace(value[end - 1]!)) end--;

    let i = end;
    while (i > 0 && isDigit(value[i - 1]!)) i--;
    if (i === end) return value;

    while (i > 0 && isWhitespace(value[i - 1]!)) i--;
    if (i > 0 && value[i - 1] === ".") i--;
    while (i > 0 && isWhitespace(value[i - 1]!)) i--;

    let markerStart = -1;
    if (i > 0 && value[i - 1] === "#") markerStart = i - 1;
    else if (i > 0 && (value[i - 1] === "x" || value[i - 1] === "X"))
      markerStart = i - 1;
    else {
      const prefix = value.slice(0, i).toLowerCase();
      if (prefix.endsWith("extension")) markerStart = i - "extension".length;
      else if (prefix.endsWith("ext.")) markerStart = i - "ext.".length;
      else if (prefix.endsWith("ext")) markerStart = i - "ext".length;
    }
    if (markerStart <= 0) return value;
    const before = value[markerStart - 1]!;
    if (!(before === "," || before === ";" || isWhitespace(before)))
      return value;
    return value.slice(0, markerStart).trim();
  };

  trimmed = stripTrailingExtension(trimmed);
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

  // Non-NANP fallback: with an explicit default country code, treat the
  // input as a bare national number and prefix the CC, then enforce the
  // E.164 8–15-digit range. Without a default CC we stay NANP-only.
  const cc = options?.defaultCountryCode?.replace(/\D/g, "");
  if (cc && digits.length > 0) {
    const candidate = cc + digits;
    if (candidate.length >= 8 && candidate.length <= 15) return "+" + candidate;
  }

  return null;
}
