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
 *     Medicare-style member ids (MBI + labeled policy/member ids),
 *     credit-card-shaped runs, PO boxes, ZIP/postal codes when
 *     labeled or paired with a US state, long digit runs, dates of
 *     birth in common formats, and street-line addresses with a house
 *     number + street suffix). We deliberately do NOT redact names
 *     or free-text health terms — false positives would degrade
 *     answer quality, and the model is told not to echo them.
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
  // Explicit ZIP / postal label — before SSN so ZIP+4 (90210-1234)
  // is not misread as an SSN-shaped run.
  {
    kind: "zip",
    pattern: /\b(?:ZIP|Zip|zip|postal)\s*(?:code)?\s*:?\s*\d{5}(?:-\d{4})?\b/g,
  },
  // US state abbreviation + ZIP (5 or ZIP+4).
  {
    kind: "zip",
    pattern:
      /\b(?:AL|AK|AZ|AR|CA|CO|CT|DE|FL|GA|HI|ID|IL|IN|IA|KS|KY|LA|ME|MD|MA|MI|MN|MS|MO|MT|NE|NV|NH|NJ|NM|NY|NC|ND|OH|OK|OR|PA|RI|SC|SD|TN|TX|UT|VT|VA|WA|WV|WI|WY|DC)\s+\d{5}(?:-\d{4})?\b/g,
  },
  // Labeled insurance identifiers — before SSN so trailing digit runs
  // inside the value are not partially redacted as SSN fragments.
  {
    kind: "member-id",
    pattern:
      /\b(?:member|subscriber|policy|group)\s*(?:id|#|number)?\s*:?\s*[A-Z0-9][A-Z0-9-]{5,}\b/gi,
  },
  // Medicare Beneficiary Identifier (MBI) — 11 positions with CMS
  // charset rules. Optional dash/space separators between positions.
  {
    kind: "mbi",
    pattern:
      /\b[1-9](?:[\s-]?[AC-HJ-NP-RT-Y][\s-]?[0-9AC-HJ-NP-RT-Y][\s-]?[0-9][\s-]?[AC-HJ-NP-RT-Y][\s-]?[0-9AC-HJ-NP-RT-Y][\s-]?[0-9][\s-]?[AC-HJ-NP-RT-Y][\s-]?[AC-HJ-NP-RT-Y][\s-]?[0-9][\s-]?[0-9])\b/gi,
  },
  // PO Box — common alternate ship-to patients paste into chat.
  {
    kind: "po-box",
    pattern: /\bP\.?\s*O\.?\s*Box\s+#?\d+\b/gi,
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
    pattern: /(?:\+?1[-.\s]?)?\(?\b[2-9]\d{2}\)?[-.\s]?\d{3}[-.\s]?\d{4}\b/g,
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
  // Street line: house number + street name + common US suffix.
  // Requires a leading digit run so bare place names ("Main Street")
  // are left alone. Rejects "4 hours … Drive" therapy prose by
  // refusing hour/night as the first token after the number.
  {
    kind: "address",
    pattern:
      /\b\d{1,5}\s+(?!hours?\b|nights?\b)[A-Za-z][A-Za-z0-9.'-]{0,40}(?:\s+[A-Za-z][A-Za-z0-9.'-]{0,20}){0,3}\s+(?:St|Street|Ave|Avenue|Rd|Road|Blvd|Boulevard|Ln|Lane|Dr|Drive|Ct|Court|Way|Pkwy|Parkway|Cir|Circle|Pl|Place|Ter|Terrace)\.?\b/gi,
  },
  // Credit-card-shaped runs (four groups of four). Placed before the
  // generic long-digit matcher so PANs don't partially leak.
  {
    kind: "card",
    pattern: /\b(?:\d{4}[-\s]?){3}\d{4}\b/g,
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
 * Scrub user-supplied text of obvious PII before it leaves Penn Home Medical Supply.
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
 * Extract the email addresses present in user-supplied text, BEFORE
 * redaction. The chat route harvests these server-side so the
 * `track_order` tool can verify order ownership against the email the
 * user actually typed — the model itself only ever sees the
 * `[redacted-email]` token. Uses the same pattern the redactor uses,
 * so anything extracted here is guaranteed to be redacted outbound.
 */
export function extractEmails(input: string): string[] {
  const emailPattern = PATTERNS.find((p) => p.kind === "email");
  if (!emailPattern) return [];
  emailPattern.pattern.lastIndex = 0;
  const matches = input.match(emailPattern.pattern) ?? [];
  return matches.map((m) => m.toLowerCase());
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
