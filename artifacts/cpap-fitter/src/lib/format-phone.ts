// Progressive US-phone display formatting, shared by the order form and
// the consent page so both fields behave identically as the patient
// types. Pure + side-effect-free; the server still does the canonical
// normalize-or-reject, this is purely a display aid.
//
// Behaviour:
//  - empty / non-numeric → ""
//  - a leading "+" (international) is passed through untouched
//  - an 11-digit number starting with "1" drops the country code
//  - otherwise the first 10 digits are formatted (123) 456-7890,
//    revealing the mask progressively as digits arrive.
export function formatUsPhone(input: string): string {
  if (!input) return "";
  // Skip reformat for international-looking inputs.
  if (input.trim().startsWith("+")) return input;
  const digits = input.replace(/\D/g, "");
  if (digits.length === 0) return "";
  // Treat 11-digit numbers starting with 1 as US country-code-prefixed.
  // Drop the leading 1 for display since the rest is local.
  const local =
    digits.length === 11 && digits.startsWith("1")
      ? digits.slice(1)
      : digits.slice(0, 10);
  if (local.length < 4) return `(${local}`;
  if (local.length < 7) return `(${local.slice(0, 3)}) ${local.slice(3)}`;
  return `(${local.slice(0, 3)}) ${local.slice(3, 6)}-${local.slice(6, 10)}`;
}
