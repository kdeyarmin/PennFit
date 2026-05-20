// DOB plausibility window: anyone born between 1900-01-01 and today is
// in scope. The HTML5 date picker enforces the same bounds via min/max
// on the <input>, but the Zod refinement is the authoritative gate so
// a paste-in-future-date or browser without HTML5 validation can't
// slip through.
//
// Everything here is done as YYYY-MM-DD string comparison rather than
// `new Date()`. The HTML date input returns the user's local-calendar
// date as YYYY-MM-DD, and we want to allow whatever "today" is on
// their wall clock — turning it into a Date object via UTC would let
// someone in PT enter "tomorrow's" date for several evening hours
// (after UTC has rolled over but local hasn't), and would reject
// "today's" date for someone in NZ for a similar window before UTC
// catches up. Lexicographic compare on the zero-padded YYYY-MM-DD
// shape matches calendar order exactly.
export const DOB_MIN = "1900-01-01";

/**
 * Returns the current local date as a YYYY-MM-DD string.
 * Uses the user's local calendar date (not UTC) to match the semantics
 * of the HTML5 date input.
 */
export function todayLocalDateString(): string {
  const now = new Date();
  const yyyy = now.getFullYear();
  const mm = String(now.getMonth() + 1).padStart(2, "0");
  const dd = String(now.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

/**
 * Returns true iff `value` is a YYYY-MM-DD string representing a
 * calendar date in the plausible birth-date range [1900-01-01, today].
 *
 * Checks:
 *  - All three numeric parts parse to integers.
 *  - The reconstructed UTC date round-trips back to the same y/m/d
 *    (catches invalid dates like 2000-02-30 that Date.UTC silently rolls
 *    over to 2000-03-01).
 *  - The date is not before DOB_MIN (1900-01-01).
 *  - The date is not after the local "today" (lexicographic string
 *    comparison on YYYY-MM-DD).
 */
export function isPlausibleDob(value: string): boolean {
  const [y, m, d] = value.split("-").map(Number);
  if (!y || !m || !d) return false;
  // Reject calendar nonsense like "2026-02-30" — Date round-trips to
  // March 2 in that case, so the components stop matching.
  const parsed = new Date(Date.UTC(y, m - 1, d));
  if (
    parsed.getUTCFullYear() !== y ||
    parsed.getUTCMonth() !== m - 1 ||
    parsed.getUTCDate() !== d
  ) {
    return false;
  }
  return value >= DOB_MIN && value <= todayLocalDateString();
}