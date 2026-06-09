import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

/**
 * Format a date-only string ("YYYY-MM-DD" — Postgres DATE columns such
 * as a claim's date of service or a maintenance due date) for display.
 * `new Date("YYYY-MM-DD")` parses as UTC midnight, so calling
 * .toLocaleDateString() on it shows the PREVIOUS day in any timezone
 * west of UTC — anchor to local noon instead.
 */
export function formatDateOnly(
  dateOnly: string,
  options?: Intl.DateTimeFormatOptions,
): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(dateOnly);
  const date = m
    ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 12)
    : new Date(dateOnly);
  return date.toLocaleDateString(undefined, options);
}
