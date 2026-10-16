// "One business day" for the morning fit-request count. Weekends in
// America/New_York do not count. The walk stops at 24 weekday hours
// so an old row does not scan a year of hours.

const TZ = "America/New_York";

function weekday(at: Date): string {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: TZ,
    weekday: "short",
  }).format(at);
}

export function olderThanOneBusinessDay(createdAt: Date, now: Date): boolean {
  const start = createdAt.getTime();
  const end = now.getTime();
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) {
    return false;
  }
  const hour = 60 * 60 * 1000;
  let cursor = start;
  let weekdayMs = 0;
  while (cursor < end && weekdayMs < 24 * hour) {
    const slice = Math.min(cursor + hour, end);
    const mid = new Date(cursor + (slice - cursor) / 2);
    const day = weekday(mid);
    if (day !== "Sat" && day !== "Sun") weekdayMs += slice - cursor;
    cursor = slice;
  }
  return weekdayMs >= 24 * hour;
}
