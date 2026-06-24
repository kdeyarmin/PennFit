// Timezone-aware "business calendar date" helpers for billing / collections.
//
// Why this exists
// ---------------
// Many billing and collections paths computed "today" / "days overdue" /
// due-date comparisons with `new Date().toISOString().slice(0, 10)`, which is
// the UTC calendar date. For a US DME operating in Eastern time, a job that
// runs in the early-morning UTC hours (or any evening-local instant) lands on
// the WRONG calendar day — shifting a dunning ladder, an autopay charge, or an
// "overdue" badge by a full day. Money- and collections-facing dates must use
// the PRACTICE's local business day, not UTC.
//
// The practice timezone comes from RESUPPLY_PRACTICE_TIMEZONE (the same env the
// appointment-email + check-in dispatcher read), defaulting to America/New_York
// — the home timezone and the conservative default for an Eastern-US patient
// base. An invalid/unset tz falls back to America/New_York, never to UTC.
//
// These are pure given (now, tz). The env-reading wrappers (`practiceTimezone`,
// `practiceTodayIso`) are the convenient callers for worker jobs.

const DEFAULT_PRACTICE_TZ = "America/New_York";

/**
 * The practice's IANA timezone for billing/collections date math.
 * RESUPPLY_PRACTICE_TIMEZONE → America/New_York fallback.
 */
export function practiceTimezone(): string {
  return process.env.RESUPPLY_PRACTICE_TIMEZONE?.trim() || DEFAULT_PRACTICE_TZ;
}

/**
 * The local calendar date (YYYY-MM-DD) for `now` in IANA `timezone`. Uses the
 * en-CA locale which renders ISO-ordered `YYYY-MM-DD`. An invalid tz string
 * falls back to America/New_York (NOT UTC), so a typo can't silently
 * reintroduce the UTC-day bug.
 */
export function localDateIso(
  now: Date = new Date(),
  timezone: string = DEFAULT_PRACTICE_TZ,
): string {
  try {
    return new Intl.DateTimeFormat("en-CA", {
      timeZone: timezone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(now);
  } catch {
    if (timezone !== DEFAULT_PRACTICE_TZ) {
      return new Intl.DateTimeFormat("en-CA", {
        timeZone: DEFAULT_PRACTICE_TZ,
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
      }).format(now);
    }
    // Should never happen (America/New_York is always valid), but keep a
    // last-resort that's still a valid date string.
    return now.toISOString().slice(0, 10);
  }
}

/** The practice-local calendar date (YYYY-MM-DD) for `now` (default = real now). */
export function practiceTodayIso(now: Date = new Date()): string {
  return localDateIso(now, practiceTimezone());
}

/**
 * Whole calendar days between two YYYY-MM-DD dates (b - a), computed on the
 * date components only (no time-of-day, no DST drift). Positive when `b` is
 * after `a`. Inputs are treated as calendar dates; anything after the first 10
 * chars is ignored.
 */
export function calendarDaysBetweenIso(aIso: string, bIso: string): number {
  const a = Date.parse(`${aIso.slice(0, 10)}T00:00:00Z`);
  const b = Date.parse(`${bIso.slice(0, 10)}T00:00:00Z`);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return 0;
  return Math.round((b - a) / 86_400_000);
}
