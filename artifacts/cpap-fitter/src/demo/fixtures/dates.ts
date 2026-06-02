// Tiny date helpers so demo timestamps are always fresh relative to
// "now" (a demo seeded with hard-coded 2024 dates would look stale).

const DAY_MS = 24 * 60 * 60 * 1000;

export function daysAgo(n: number): string {
  return new Date(Date.now() - n * DAY_MS).toISOString();
}

export function daysFromNow(n: number): string {
  return new Date(Date.now() + n * DAY_MS).toISOString();
}

export function hoursAgo(n: number): string {
  return new Date(Date.now() - n * 60 * 60 * 1000).toISOString();
}

export function minutesAgo(n: number): string {
  return new Date(Date.now() - n * 60 * 1000).toISOString();
}

/** YYYY-MM-DD for `n` days from now (negative = past). */
export function dateOnly(offsetDays: number): string {
  return new Date(Date.now() + offsetDays * DAY_MS).toISOString().slice(0, 10);
}

export const NOW_ISO = (): string => new Date().toISOString();
