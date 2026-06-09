// Address validation — adapter interface + null/heuristic
// implementation.
//
// Why this exists
// ---------------
// "We shipped to the wrong address" is one of the biggest categories
// of avoidable RMA work. USPS / Smarty / Lob have address-correction
// services that catch typos (Stret → Street, wrong ZIP for city) at
// checkout time, before the order is paid. This module is the
// adapter boundary; the actual partner integration lands when a
// partner API key is configured.
//
// Posture in the meantime
// -----------------------
// `validateAddress()` runs a cheap local heuristic: it checks for
// the minimum required fields (line1, city, state, postalCode,
// country=US), validates US ZIP format, and never invents data.
// Returns:
//   - `ok: true`  — passes heuristic; no correction suggested.
//   - `ok: false` — fails heuristic; reasons[] explains why.
// A future Smarty/USPS adapter will replace the heuristic and may
// also return a `suggestedCorrection` field; callers should not
// auto-apply corrections — they should surface them to the user.

export type AddressInput = {
  line1?: string | null;
  line2?: string | null;
  city?: string | null;
  state?: string | null;
  postalCode?: string | null;
  country?: string | null;
};

export type AddressValidationResult =
  | { ok: true; reasons?: never; suggestedCorrection?: AddressInput }
  | { ok: false; reasons: string[]; suggestedCorrection?: AddressInput };

const US_ZIP_RE = /^\d{5}(-\d{4})?$/;
const US_STATE_RE = /^[A-Z]{2}$/;

/**
 * Heuristic-only address validator. Replaceable with a Smarty/USPS
 * adapter behind the same signature once a partner key is configured.
 */
export function validateAddress(addr: AddressInput): AddressValidationResult {
  const reasons: string[] = [];
  const line1 = (addr.line1 ?? "").trim();
  const city = (addr.city ?? "").trim();
  const state = (addr.state ?? "").trim().toUpperCase();
  const postalCode = (addr.postalCode ?? "").trim();
  const country = (addr.country ?? "US").trim().toUpperCase();

  if (line1.length < 3) reasons.push("street_address_too_short");
  if (city.length < 2) reasons.push("city_required");
  if (country === "US") {
    if (!US_STATE_RE.test(state)) reasons.push("us_state_must_be_two_letters");
    if (!US_ZIP_RE.test(postalCode)) reasons.push("us_zip_invalid_format");
  } else {
    // Out-of-US — only require non-empty postal + state field. No
    // format check.
    if (state.length < 2) reasons.push("state_or_region_required");
    if (postalCode.length < 3) reasons.push("postal_code_required");
  }

  if (reasons.length > 0) {
    return { ok: false, reasons };
  }
  return { ok: true };
}
