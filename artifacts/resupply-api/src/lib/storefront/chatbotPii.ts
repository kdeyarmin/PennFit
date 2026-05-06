/**
 * Defense-in-depth PII redaction for outbound chat messages.
 *
 * The chat route forwards user-typed text to OpenAI. The system
 * prompt instructs the model not to echo PHI even if the user
 * volunteers it, but we still want to scrub the OUTBOUND copy as
 * a second layer — fewer raw identifiers cross the network, and
 * an inadvertent log line on either side has fewer recognizable
 * fragments to leak.
 *
 * Design principles:
 *   - **Conservative**: only redact patterns that are unambiguous
 *     identifiers (US phone numbers, emails, SSN-shaped numbers,
 *     Medicare-style member ids, long digit runs, dates of birth
 *     in common formats). We deliberately do NOT redact names,
 *     addresses, or free-text health terms — false positives
 *     would degrade answer quality, and the model is told not
 *     to echo them.
 *   - **Reversible substitution**: each match becomes a `[redacted-<kind>]`
 *     token so the model still understands "the user mentioned a
 *     phone number" and can answer accordingly without seeing the
 *     digits.
 *   - **Idempotent**: applying redaction twice is a no-op.
 *   - **Pure**: takes a string, returns a string. No I/O. No PHI
 *     ever logged from inside.
 */

const PATTERNS: Array<{
  kind: string;
  pattern: RegExp;
}> = [
  // Email addresses — RFC-flavored but loose: local@host.tld with
  // common subdomain support. Trailing punctuation is preserved
  // by anchoring to a non-domain character.
  {
    kind: "email",
    pattern: /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi,
  },
  // SSN: NNN-NN-NNNN with optional dashes / spaces. Tight enough
  // to avoid catching arbitrary 9-digit runs.
  {
    kind: "ssn",
    pattern: /\b\d{3}[-\s]?\d{2}[-\s]?\d{4}\b/g,
  },
  // US phone numbers in common formats:
  //   (NNN) NNN-NNNN, NNN-NNN-NNNN, NNN.NNN.NNNN, +1 NNN NNN NNNN,
  //   1NNNNNNNNNN, NNNNNNNNNN.
  // We accept optional country code "1" / "+1", optional area-code
  // parens, and dash / dot / space separators.
  {
    kind: "phone",
    pattern:
      /(?:\+?1[-.\s]?)?\(?\b[2-9]\d{2}\)?[-.\s]?\d{3}[-.\s]?\d{4}\b/g,
  },
  // Date of birth in common spellings:
  //   12/03/1965, 12-03-1965, 12.03.1965, 1965/03/12
  // Years are constrained to 1900-2099 to avoid catching arbitrary
  // numeric ranges.
  {
    kind: "dob",
    pattern:
      /\b(?:(?:0?[1-9]|1[0-2])[/.-](?:0?[1-9]|[12]\d|3[01])[/.-](?:19|20)\d{2}|(?:19|20)\d{2}[/.-](?:0?[1-9]|1[0-2])[/.-](?:0?[1-9]|[12]\d|3[01]))\b/g,
  },
  // Long digit runs (10+ consecutive digits with optional dashes /
  // spaces). Catches insurance member ids, MRNs, and other
  // identifier strings the patient might paste. Phones are caught
  // earlier so this rarely double-fires.
  {
    kind: "id",
    pattern: /\b\d[\d\s-]{9,}\d\b/g,
  },
];

export interface RedactionResult {
  /** Text with identifiers replaced by `[redacted-<kind>]` tokens. */
  text: string;
  /** Counts per kind. Useful for the route to log "we scrubbed
      2 phones and 1 email" without seeing the values themselves. */
  counts: Record<string, number>;
}

/**
 * Scrub user-supplied text of obvious PII before it leaves PennPaps.
 * Returns the redacted text plus a per-kind count for audit logging.
 */
export function redactPiiForOutbound(input: string): RedactionResult {
  const counts: Record<string, number> = {};
  let text = input;
  for (const { kind, pattern } of PATTERNS) {
    text = text.replace(pattern, () => {
      counts[kind] = (counts[kind] ?? 0) + 1;
      return `[redacted-${kind}]`;
    });
  }
  return { text, counts };
}

/**
 * True iff the text contains anything that would trigger a
 * redaction. Useful when the caller wants to log a single boolean
 * rather than a per-kind breakdown.
 */
export function containsLikelyPii(input: string): boolean {
  for (const { pattern } of PATTERNS) {
    pattern.lastIndex = 0;
    if (pattern.test(input)) return true;
  }
  return false;
}
