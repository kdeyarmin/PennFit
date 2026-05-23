// Pure helpers for rendering payer-profile postal addresses into PDF
// outputs (appeal letters, HCFA-1500 cover blocks, billing-statement
// envelopes).
//
// Phase 12 (migration 0142) added `claims_mailing_address` and
// `appeals_mailing_address` as jsonb on payer_profiles. The jsonb
// values aren't typed at the DB layer; this module narrows the
// `unknown` payload into a strict PostalAddress, validates the
// minimum fields, and emits a flat string[] for downstream renderers.
//
// Format conventions:
//   * Line 1: line1
//   * Line 2: line2 (if present)
//   * Line 3: line3 (if present — rare; some payers stack PO Box +
//             building + floor)
//   * Line N: "{city}, {state} {zip}"
//
// Returns null when the input cannot be parsed into the minimum
// (line1 + city + state + zip). Callers fall back to whatever they
// were doing before — typically "(see payer provider manual)".

export interface PostalAddress {
  line1: string;
  line2?: string | null;
  line3?: string | null;
  city: string;
  state: string;
  zip: string;
}

export function parsePostalAddress(raw: unknown): PostalAddress | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const line1 = typeof r.line1 === "string" ? r.line1.trim() : "";
  const city = typeof r.city === "string" ? r.city.trim() : "";
  const state = typeof r.state === "string" ? r.state.trim() : "";
  const zip = typeof r.zip === "string" ? r.zip.trim() : "";
  if (!line1 || !city || !state || !zip) return null;
  return {
    line1,
    line2:
      typeof r.line2 === "string" && r.line2.trim() ? r.line2.trim() : null,
    line3:
      typeof r.line3 === "string" && r.line3.trim() ? r.line3.trim() : null,
    city,
    state,
    zip,
  };
}

/** Flatten a PostalAddress to the array of lines a PDF block prints
 *  one-per-row. Empty lines are skipped. */
export function formatPostalAddressLines(addr: PostalAddress): string[] {
  const out = [addr.line1];
  if (addr.line2) out.push(addr.line2);
  if (addr.line3) out.push(addr.line3);
  out.push(`${addr.city}, ${addr.state} ${addr.zip}`);
  return out;
}

/** Parse + flatten in one call. Returns null when the jsonb can't
 *  be coerced into a complete address. */
export function parsePayerAddressLines(raw: unknown): string[] | null {
  const parsed = parsePostalAddress(raw);
  if (!parsed) return null;
  return formatPostalAddressLines(parsed);
}
