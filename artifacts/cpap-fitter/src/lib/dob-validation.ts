// DOB plausibility window: anyone born between 1900-01-01 and today is
// in scope. The HTML5 date picker enforces the same bounds via min/max
// on the <input>, but this function is the authoritative gate so a
// paste-in-future-date or browser without HTML5 validation can't slip
// through.
// NOTE: an alternate local-date-string implementation from
// subrepl-3ppc2e03/main was discarded in favor of the UTC end-of-today
// path below (Task #72 merge preference).
export const DOB_MIN = "1900-01-01";

/**
 * Returns the current local date as a YYYY-MM-DD string. Used to
 * populate the `max` attribute on the DOB <input> so the native date
 * picker won't offer a future date. The authoritative gate against
 * future dates remains `isPlausibleDob` below.
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
 *  - The date is not after UTC end-of-today so a same-day sign-up in
 *    any timezone is accepted.
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
  // Use UTC end-of-today so a same-day signup in any timezone is OK.
  const now = new Date();
  const todayEnd = new Date(
    Date.UTC(
      now.getUTCFullYear(),
      now.getUTCMonth(),
      now.getUTCDate(),
      23,
      59,
      59,
    ),
  );
  return parsed <= todayEnd;
}
