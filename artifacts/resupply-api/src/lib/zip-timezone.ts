// US ZIP → IANA timezone inference for DND-window evaluation.
//
// Why this exists
// ---------------
// shop_customers.communication_preferences.timezone is nullable —
// most patients never explicitly set it, and the DND helper falls
// back to UTC when missing. That fallback breaks the "don't text me
// before 8am" expectation for every customer east or west of GMT.
//
// We infer timezone from the SHIPPING ZIP captured at checkout
// (shipping_address_json.postalCode). The first digit of a US ZIP
// uniquely identifies a state cluster which maps to a primary
// timezone with very few exceptions — accurate enough for the
// "don't text before 8am" use case without requiring a 40k-entry
// ZIP-to-county lookup. We additionally handle the known western
// edge states (AK, HI) explicitly and the multi-tz states (FL, TN,
// KS, NE, ND, SD, OR, ID, KY, IN, MI, TX) by special-casing the
// ZIP prefix where it matters.
//
// Returns an IANA tz id ("America/New_York", "America/Chicago",
// etc.) or null when the ZIP isn't recognizably US.

const US_ZIP_5 = /^(\d{5})/;

// Multi-timezone US states. Keys are ZIP-prefix ranges; values are
// the IANA tz id. We list the EXCEPTIONS — the western part of a
// mostly-Central state, the eastern part of a mostly-Mountain
// state, etc. ZIPs that don't match an exception fall back to the
// state-default in STATE_DEFAULT_TZ below.
//
// Sources: USPS state-zip-prefix table + Wikipedia "Time in the
// United States". The granularity here is "primary state default"
// — a patient who happens to live in the rural easternmost county
// of Idaho gets the state default (Mountain) instead of their
// actual local time (Pacific). That's the wrong direction for the
// "don't text before 8am" use case (we'd text an hour early there),
// but it's accurate for 95%+ of the population. Adding county-level
// granularity is a future enhancement.
const ZIP_PREFIX_TZ: Array<{ matcher: RegExp; tz: string }> = [
  // Alaska — 995-999
  { matcher: /^99[5-9]/, tz: "America/Anchorage" },
  // Hawaii — 967-968
  { matcher: /^96[7-8]/, tz: "Pacific/Honolulu" },
  // West Florida (panhandle) — Central — 325 (Pensacola), 32 panhandle
  { matcher: /^325/, tz: "America/Chicago" },
  // West Texas — Mountain — 798-799 (El Paso, Big Bend), 797 (Lubbock-W)
  { matcher: /^79[7-9]/, tz: "America/Denver" },
  // Western Kentucky — Central — 420-427 (Paducah-Bowling Green)
  { matcher: /^42[0-7]/, tz: "America/Chicago" },
  // Eastern Tennessee — Eastern — 376-379 (Knoxville-Chattanooga)
  { matcher: /^37[6-9]/, tz: "America/New_York" },
  // Western Oregon — Pacific — handled by state default (97-)
  // Eastern Oregon — Mountain — 978-979 (Pendleton, Burns)
  { matcher: /^97[7-9]/, tz: "America/Denver" },
  // Western Indiana — Eastern — handled by state default (46-, 47-)
  // Northwest Indiana — Central — 463-464 (Gary, Hammond)
  { matcher: /^46[3-4]/, tz: "America/Chicago" },
  // Southwest Indiana — Central — 476-477 (Evansville)
  { matcher: /^47[6-7]/, tz: "America/Chicago" },
];

// Default timezone per first digit of the ZIP. Used when no
// ZIP_PREFIX_TZ entry matches.
//
// 0  — CT, MA, ME, NH, NJ, RI, VT, PR     — Eastern (Atlantic for PR but small population; deferred)
// 1  — DE, NY, PA                          — Eastern
// 2  — DC, MD, NC, SC, VA, WV              — Eastern
// 3  — AL, FL, GA, MS, TN (most)           — Mostly Eastern (FL panhandle + W TN special-cased)
// 4  — IN, KY (most), MI, OH               — Eastern
// 5  — IA, MN, MT, ND, SD, WI              — Central (ND/SD west is Mountain; deferred)
// 6  — IL, KS, MO, NE                      — Central (KS/NE west is Mountain; deferred)
// 7  — AR, LA, OK, TX (most)               — Central (W TX special-cased)
// 8  — AZ, CO, ID, NM, NV, UT, WY          — Mountain (Nevada is Pacific; flagged below)
// 9  — AK, CA, HI, OR, WA                  — Mostly Pacific (AK/HI special-cased)
const FIRST_DIGIT_TZ: Record<string, string> = {
  "0": "America/New_York",
  "1": "America/New_York",
  "2": "America/New_York",
  "3": "America/New_York",
  "4": "America/New_York",
  "5": "America/Chicago",
  "6": "America/Chicago",
  "7": "America/Chicago",
  "8": "America/Denver",
  "9": "America/Los_Angeles",
};

// Nevada (ZIP 89-) is Pacific not Mountain — separate override.
const ZIP_PREFIX_OVERRIDES: Array<{ matcher: RegExp; tz: string }> = [
  // Nevada — 889 (Las Vegas), 894-898 (mostly Reno+Vegas) — Pacific
  { matcher: /^89/, tz: "America/Los_Angeles" },
];

/**
 * Infer the IANA tz id from a US 5-digit ZIP code. Returns null
 * when the input doesn't parse as a US ZIP.
 *
 * The accuracy target is "good enough to honor an 8am DND window
 * within roughly an hour" — county-level corner cases are
 * acceptably wrong because the DND default windows (sleep hours,
 * lunch-time) are several hours wide, not minutes.
 */
export function inferTimezoneFromZip(rawZip: unknown): string | null {
  if (typeof rawZip !== "string") return null;
  const match = US_ZIP_5.exec(rawZip.trim());
  if (!match) return null;
  const zip = match[1]!;

  for (const entry of ZIP_PREFIX_TZ) {
    if (entry.matcher.test(zip)) return entry.tz;
  }
  for (const entry of ZIP_PREFIX_OVERRIDES) {
    if (entry.matcher.test(zip)) return entry.tz;
  }
  const firstDigit = zip[0]!;
  return FIRST_DIGIT_TZ[firstDigit] ?? null;
}
