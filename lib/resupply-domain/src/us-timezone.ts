/**
 * US state → IANA timezone derivation for outbound-messaging quiet hours.
 *
 * patients.timezone gates the reminder scan into the patient's local
 * 9am–8pm window (see migration 0161). The column defaults to
 * 'America/New_York'; this helper derives a better value from the
 * patient's shipping/billing state so a West Coast patient isn't texted
 * at 11pm local under the Eastern default.
 *
 * Resolution is deliberately state-level, mapping each state to its
 * DOMINANT timezone. A handful of states straddle two zones (TN, KY,
 * ID, OR, ND, SD, NE, KS, TX, FL, MI, IN); for a patient on the minor
 * side of a split the derived window is off by one hour — still well
 * inside the TCPA 8am–9pm bound, and strictly better than the
 * three-hour error the Eastern default gives a Pacific patient. A
 * zip-prefix refinement can be layered on later without changing this
 * contract.
 *
 * Lives in resupply-domain (pure, no I/O) because the API patient-create
 * route, the CSV importer, and the PacWare importer all need the same
 * rules.
 */

/** Dominant IANA zone per state/territory, keyed by USPS code. */
const STATE_TO_TZ: Record<string, string> = {
  // Eastern
  CT: "America/New_York",
  DC: "America/New_York",
  DE: "America/New_York",
  FL: "America/New_York",
  GA: "America/New_York",
  IN: "America/New_York",
  KY: "America/New_York",
  MA: "America/New_York",
  MD: "America/New_York",
  ME: "America/New_York",
  MI: "America/New_York",
  NC: "America/New_York",
  NH: "America/New_York",
  NJ: "America/New_York",
  NY: "America/New_York",
  OH: "America/New_York",
  PA: "America/New_York",
  RI: "America/New_York",
  SC: "America/New_York",
  VA: "America/New_York",
  VT: "America/New_York",
  WV: "America/New_York",
  // Central
  AL: "America/Chicago",
  AR: "America/Chicago",
  IA: "America/Chicago",
  IL: "America/Chicago",
  KS: "America/Chicago",
  LA: "America/Chicago",
  MN: "America/Chicago",
  MO: "America/Chicago",
  MS: "America/Chicago",
  ND: "America/Chicago",
  NE: "America/Chicago",
  OK: "America/Chicago",
  SD: "America/Chicago",
  TN: "America/Chicago",
  TX: "America/Chicago",
  WI: "America/Chicago",
  // Mountain
  CO: "America/Denver",
  ID: "America/Denver",
  MT: "America/Denver",
  NM: "America/Denver",
  UT: "America/Denver",
  WY: "America/Denver",
  // Arizona observes no DST — its own zone, not America/Denver.
  AZ: "America/Phoenix",
  // Pacific
  CA: "America/Los_Angeles",
  NV: "America/Los_Angeles",
  OR: "America/Los_Angeles",
  WA: "America/Los_Angeles",
  // Non-contiguous + territories
  AK: "America/Anchorage",
  HI: "Pacific/Honolulu",
  PR: "America/Puerto_Rico",
  VI: "America/St_Thomas",
  GU: "Pacific/Guam",
  MP: "Pacific/Guam",
  AS: "Pacific/Pago_Pago",
};

/**
 * Full state names → USPS code, so CSV imports carrying
 * "Pennsylvania" instead of "PA" still resolve. Keys are upper-case,
 * space-normalized.
 */
const STATE_NAME_TO_CODE: Record<string, string> = {
  ALABAMA: "AL",
  ALASKA: "AK",
  "AMERICAN SAMOA": "AS",
  ARIZONA: "AZ",
  ARKANSAS: "AR",
  CALIFORNIA: "CA",
  COLORADO: "CO",
  CONNECTICUT: "CT",
  DELAWARE: "DE",
  "DISTRICT OF COLUMBIA": "DC",
  FLORIDA: "FL",
  GEORGIA: "GA",
  GUAM: "GU",
  HAWAII: "HI",
  IDAHO: "ID",
  ILLINOIS: "IL",
  INDIANA: "IN",
  IOWA: "IA",
  KANSAS: "KS",
  KENTUCKY: "KY",
  LOUISIANA: "LA",
  MAINE: "ME",
  MARYLAND: "MD",
  MASSACHUSETTS: "MA",
  MICHIGAN: "MI",
  MINNESOTA: "MN",
  MISSISSIPPI: "MS",
  MISSOURI: "MO",
  MONTANA: "MT",
  NEBRASKA: "NE",
  NEVADA: "NV",
  "NEW HAMPSHIRE": "NH",
  "NEW JERSEY": "NJ",
  "NEW MEXICO": "NM",
  "NEW YORK": "NY",
  "NORTH CAROLINA": "NC",
  "NORTH DAKOTA": "ND",
  "NORTHERN MARIANA ISLANDS": "MP",
  OHIO: "OH",
  OKLAHOMA: "OK",
  OREGON: "OR",
  PENNSYLVANIA: "PA",
  "PUERTO RICO": "PR",
  "RHODE ISLAND": "RI",
  "SOUTH CAROLINA": "SC",
  "SOUTH DAKOTA": "SD",
  TENNESSEE: "TN",
  TEXAS: "TX",
  UTAH: "UT",
  VERMONT: "VT",
  "VIRGIN ISLANDS": "VI",
  VIRGINIA: "VA",
  WASHINGTON: "WA",
  "WEST VIRGINIA": "WV",
  WISCONSIN: "WI",
  WYOMING: "WY",
};

/**
 * ZIP3 (first three digits) → IANA zone, for the documented split
 * states where the state-level dominant zone is wrong for the minor
 * side. This is a deliberately CONSERVATIVE, best-effort refinement:
 * it lists only high-confidence prefixes whose county-level zone is
 * well established, and the function falls back to the state-level
 * answer for every prefix not listed here — so it can only ever make
 * a split-state patient's window MORE accurate, never regress an
 * already-correct one. Layered on top of `STATE_TO_TZ` per the module
 * header's "zip-prefix refinement can be layered on later" note.
 */
const ZIP3_TO_TZ: Record<string, string> = {
  // Tennessee — eastern third is Eastern (Knoxville, Chattanooga,
  // Tri-Cities) vs the Central state default.
  "373": "America/New_York", // Chattanooga
  "374": "America/New_York", // Chattanooga
  "376": "America/New_York", // Johnson City / Tri-Cities
  "377": "America/New_York", // Knoxville
  "378": "America/New_York", // Knoxville
  "379": "America/New_York", // Knoxville
  // Kentucky — western counties are Central (Paducah, Bowling Green,
  // Owensboro) vs the Eastern state default.
  "420": "America/Chicago", // Paducah
  "421": "America/Chicago", // Bowling Green
  "422": "America/Chicago", // Bowling Green
  "423": "America/Chicago", // Owensboro
  "424": "America/Chicago", // Owensboro
  // Florida — western panhandle is Central (Pensacola, Panama City)
  // vs the Eastern state default.
  "324": "America/Chicago", // Panama City
  "325": "America/Chicago", // Pensacola
  // Texas — far western tip is Mountain (El Paso, Hudspeth) vs Central.
  "798": "America/Denver", // El Paso
  "799": "America/Denver", // El Paso
  "885": "America/Denver", // El Paso (unique-ZIP range)
  // Idaho — northern panhandle is Pacific (Coeur d'Alene, Lewiston)
  // vs the Mountain state default.
  "835": "America/Los_Angeles", // Lewiston
  "838": "America/Los_Angeles", // Coeur d'Alene
  // Oregon — far eastern Malheur County is Mountain (Ontario) vs
  // the Pacific state default.
  "979": "America/Denver", // Ontario, OR
  // Nebraska — panhandle is Mountain (Scottsbluff, Alliance) vs Central.
  "693": "America/Denver", // Scottsbluff / Alliance
  // North Dakota — southwest is Mountain (Dickinson) vs Central.
  "586": "America/Denver", // Dickinson
  // South Dakota — west river is Mountain (Rapid City) vs Central.
  "577": "America/Denver", // Rapid City
};

/**
 * Derive the dominant IANA timezone for a US state. Accepts a USPS
 * code ("PA", "ca") or a full state name ("Pennsylvania"); returns
 * `null` for anything unrecognized — callers should leave the
 * patient's existing/default timezone untouched in that case, never
 * guess.
 *
 * Pass the patient's `zip` to refine the result for the handful of
 * split states (TN, KY, FL, TX, ID, OR, NE, ND, SD): when the ZIP's
 * 3-digit prefix is a known minor-side region the more accurate zone
 * is returned, otherwise the state-level dominant zone stands. The zip
 * never changes the answer for a non-split state or an unlisted prefix.
 */
export function timezoneForUsState(
  state: string | null | undefined,
  zip?: string | null,
): string | null {
  if (state == null) return null;
  const normalized = String(state).trim().toUpperCase().replace(/\s+/g, " ");
  if (!normalized) return null;
  const code =
    normalized.length === 2 ? normalized : STATE_NAME_TO_CODE[normalized];
  if (!code) return null;
  const stateZone = STATE_TO_TZ[code] ?? null;
  if (stateZone == null) return null;

  // ZIP refinement: only the first three digits matter, and only for a
  // listed split-state prefix. Everything else keeps the state zone.
  if (zip != null) {
    const zip3 = String(zip).replace(/\D/g, "").slice(0, 3);
    if (zip3.length === 3) {
      const refined = ZIP3_TO_TZ[zip3];
      if (refined) return refined;
    }
  }
  return stateZone;
}
