import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export const APP_TIME_ZONE = "America/New_York";

const DATE_ONLY_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const DATE_TIME_LOCAL_RE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/;
const EMPTY_FIELD = "\u2014";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export function appTimeZoneOptions(
  options?: Intl.DateTimeFormatOptions,
): Intl.DateTimeFormatOptions {
  return { ...options, timeZone: APP_TIME_ZONE };
}

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

function dateOnlyAtAppNoon(dateOnly: string): Date | null {
  const m = DATE_ONLY_RE.exec(dateOnly);
  if (!m) return null;

  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  const date = new Date(Date.UTC(year, month - 1, day, 12));

  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    return null;
  }

  return date;
}

function getAppDateTimeParts(date = new Date()) {
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone: APP_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  });

  const values: Record<string, string> = {};
  for (const part of formatter.formatToParts(date)) {
    if (part.type !== "literal") values[part.type] = part.value;
  }

  return {
    year: Number(values.year),
    month: Number(values.month),
    day: Number(values.day),
    hour: Number(values.hour),
    minute: Number(values.minute),
    second: Number(values.second),
  };
}

function dateOnlyFromParts(
  parts: Pick<ReturnType<typeof getAppDateTimeParts>, "year" | "month" | "day">,
  offsetDays = 0,
): string {
  const date = new Date(
    Date.UTC(parts.year, parts.month - 1, parts.day + offsetDays, 12),
  );
  return [
    String(date.getUTCFullYear()),
    pad2(date.getUTCMonth() + 1),
    pad2(date.getUTCDate()),
  ].join("-");
}

function dateTimeLocalTargetMs(parts: {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second?: number;
}): number {
  return Date.UTC(
    parts.year,
    parts.month - 1,
    parts.day,
    parts.hour,
    parts.minute,
    parts.second ?? 0,
  );
}

function validAppDateTimeParts(parts: {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
}): boolean {
  if (
    !Number.isInteger(parts.year) ||
    !Number.isInteger(parts.month) ||
    !Number.isInteger(parts.day) ||
    !Number.isInteger(parts.hour) ||
    !Number.isInteger(parts.minute)
  ) {
    return false;
  }
  return (
    parts.month >= 1 &&
    parts.month <= 12 &&
    parts.day >= 1 &&
    parts.day <= 31 &&
    parts.hour >= 0 &&
    parts.hour <= 23 &&
    parts.minute >= 0 &&
    parts.minute <= 59
  );
}

/**
 * Format a date-only string ("YYYY-MM-DD" - Postgres DATE columns such
 * as a claim's date of service or a maintenance due date) for display.
 * Calendar dates are displayed in the app's practice timezone, not the
 * viewer/browser timezone.
 */
export function formatDateOnly(
  dateOnly: string,
  options?: Intl.DateTimeFormatOptions,
): string {
  const date = dateOnlyAtAppNoon(dateOnly) ?? new Date(dateOnly);
  return date.toLocaleDateString(undefined, appTimeZoneOptions(options));
}

export function formatAppDate(
  value: string | Date | null | undefined,
  options?: Intl.DateTimeFormatOptions,
): string {
  if (!value) return EMPTY_FIELD;
  const date =
    typeof value === "string"
      ? (dateOnlyAtAppNoon(value) ?? new Date(value))
      : value;
  if (Number.isNaN(date.getTime())) return EMPTY_FIELD;
  return date.toLocaleDateString(undefined, appTimeZoneOptions(options));
}

export function formatAppDateTime(
  value: string | Date | null | undefined,
  options?: Intl.DateTimeFormatOptions,
): string {
  if (!value) return EMPTY_FIELD;
  const date = typeof value === "string" ? new Date(value) : value;
  if (Number.isNaN(date.getTime())) return EMPTY_FIELD;
  return date.toLocaleString(undefined, appTimeZoneOptions(options));
}

export function formatAppTime(
  value: string | Date | null | undefined,
  options?: Intl.DateTimeFormatOptions,
): string {
  if (!value) return EMPTY_FIELD;
  const date = typeof value === "string" ? new Date(value) : value;
  if (Number.isNaN(date.getTime())) return EMPTY_FIELD;
  return date.toLocaleTimeString(undefined, appTimeZoneOptions(options));
}

export function todayAppDateIso(date = new Date()): string {
  return dateOnlyFromParts(getAppDateTimeParts(date));
}

export function appDateIsoOffset(daysFromToday: number, date = new Date()) {
  return dateOnlyFromParts(getAppDateTimeParts(date), daysFromToday);
}

export function appDateTimeLocalInputValue(options?: {
  date?: Date;
  daysFromToday?: number;
  hour?: number;
  minute?: number;
}): string {
  const base = getAppDateTimeParts(options?.date ?? new Date());
  const dateOnly = dateOnlyFromParts(base, options?.daysFromToday ?? 0);
  const hour = options?.hour ?? base.hour;
  const minute = options?.minute ?? base.minute;
  return `${dateOnly}T${pad2(hour)}:${pad2(minute)}`;
}

export function parseAppDateTimeLocalInput(value: string): Date | null {
  const m = DATE_TIME_LOCAL_RE.exec(value);
  if (!m) return null;

  const target = {
    year: Number(m[1]),
    month: Number(m[2]),
    day: Number(m[3]),
    hour: Number(m[4]),
    minute: Number(m[5]),
  };
  if (!validAppDateTimeParts(target)) return null;

  const targetMs = dateTimeLocalTargetMs(target);
  let utcMs = targetMs;
  for (let i = 0; i < 4; i += 1) {
    const rendered = getAppDateTimeParts(new Date(utcMs));
    const renderedMs = dateTimeLocalTargetMs(rendered);
    const diff = renderedMs - targetMs;
    if (diff === 0) break;
    utcMs -= diff;
  }

  const result = new Date(utcMs);
  const rendered = getAppDateTimeParts(result);
  if (
    rendered.year !== target.year ||
    rendered.month !== target.month ||
    rendered.day !== target.day ||
    rendered.hour !== target.hour ||
    rendered.minute !== target.minute
  ) {
    return null;
  }
  return result;
}
