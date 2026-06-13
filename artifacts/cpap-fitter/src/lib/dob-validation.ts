import { todayAppDateIso } from "@/lib/utils";

// DOB plausibility window: anyone born between 1900-01-01 and today is
// in scope. The HTML5 date picker enforces the same bounds via min/max
// on the <input>, but this function is the authoritative gate so a
// paste-in-future-date or browser without HTML5 validation can't slip
// through. "Today" follows the practice timezone: America/New_York.
export const DOB_MIN = "1900-01-01";

/**
 * Returns the current practice date as a YYYY-MM-DD string. Used to
 * populate the `max` attribute on the DOB <input> so the native date
 * picker won't offer a future date. The authoritative gate against
 * future dates remains `isPlausibleDob` below.
 */
export function todayLocalDateString(): string {
  return todayAppDateIso();
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
 *  - The date is not after the current practice date.
 */
export function isPlausibleDob(value: string): boolean {
  const [y, m, d] = value.split("-").map(Number);
  if (!y || !m || !d) return false;
  const parsed = new Date(Date.UTC(y, m - 1, d));
  if (
    parsed.getUTCFullYear() !== y ||
    parsed.getUTCMonth() !== m - 1 ||
    parsed.getUTCDate() !== d
  ) {
    return false;
  }
  if (parsed < new Date(DOB_MIN)) return false;
  return value <= todayAppDateIso();
}
