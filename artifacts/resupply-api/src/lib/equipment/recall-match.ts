// Equipment-recall match engine — pure function the recall-scan
// endpoint uses to decide whether a given equipment_assets row is
// affected by an equipment_recalls row.
//
// PURE on purpose: no DB, no logging, no Date.now(). Same inputs
// always produce the same boolean. Tests exercise every branch.
//
// The endpoint loads candidate assets via the
// (manufacturer, model, status) index, then runs each through this
// function to decide whether to include the asset in the response.
// We deliberately do the serial-range comparison in JS rather than
// SQL because:
//
//   1. Serial schemes are stringy, not numeric — "S2024-001A" vs.
//      "S2024-099Z" is a lexicographic range, not arithmetic.
//   2. Some recalls publish an explicit serial LIST (not a range);
//      Postgres array ANY() would work but adds noise to the SQL.
//   3. Keeping the criteria in JS keeps this testable without a
//      database connection.

export type RecallSerialMatch =
  | { kind: "range"; from: string; to: string }
  | { kind: "list"; serials: string[] }
  | null
  | undefined;

export interface RecallMatchInput {
  asset: {
    manufacturer: string;
    model: string;
    serialNumber: string;
  };
  recall: {
    manufacturer: string;
    modelMatch: string | null;
    serialMatch: RecallSerialMatch;
  };
}

/**
 * Returns true iff the asset matches the recall criteria.
 *
 * Matching rules:
 *   * Manufacturer is required and compared case-insensitively.
 *     Mismatch = no match.
 *   * modelMatch is OPTIONAL. NULL means "every model from this
 *     manufacturer"; a string value means exact match (case-
 *     insensitive).
 *   * serialMatch is OPTIONAL:
 *       NULL                          — every serial qualifies
 *       { kind: "range", from, to }   — lexicographic compare on
 *                                       the upper-cased serial:
 *                                       FROM <= serial <= TO
 *       { kind: "list", serials: [] } — case-insensitive
 *                                       membership in the list
 *
 * Both edges of "range" are INCLUSIVE — manufacturers publish
 * recall ranges as "S1000 through S2000 inclusive."
 */
export function recallMatchesAsset({
  asset,
  recall,
}: RecallMatchInput): boolean {
  if (!sameI(asset.manufacturer, recall.manufacturer)) return false;
  if (recall.modelMatch !== null && !sameI(asset.model, recall.modelMatch)) {
    return false;
  }
  if (!recall.serialMatch) return true;

  const upperSerial = (asset.serialNumber ?? "").trim().toUpperCase();
  if (upperSerial.length === 0) return false;

  if (recall.serialMatch.kind === "list") {
    const targets = recall.serialMatch.serials.map((s) =>
      s.trim().toUpperCase(),
    );
    return targets.includes(upperSerial);
  }

  // range
  const lo = recall.serialMatch.from.trim().toUpperCase();
  const hi = recall.serialMatch.to.trim().toUpperCase();
  if (!lo || !hi) return false;
  // Defensive: if the caller flipped from/to, treat the range as
  // empty rather than silently inverting (a CSR-entered "from S2000
  // to S1000" recall is almost certainly a typo).
  if (lo > hi) return false;
  return upperSerial >= lo && upperSerial <= hi;
}

function sameI(a: string, b: string): boolean {
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}
