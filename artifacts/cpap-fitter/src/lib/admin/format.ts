// Display formatters shared by all console pages.

import { formatAppDate, formatAppDateTime } from "@/lib/utils";

const dateOptions: Intl.DateTimeFormatOptions = {
  year: "numeric",
  month: "short",
  day: "numeric",
};

const dateTimeOptions: Intl.DateTimeFormatOptions = {
  year: "numeric",
  month: "short",
  day: "numeric",
  hour: "2-digit",
  minute: "2-digit",
};

export function formatDate(value: string | null | undefined): string {
  return formatAppDate(value, dateOptions);
}

export function formatDateTime(value: string | null | undefined): string {
  return formatAppDateTime(value, dateTimeOptions);
}

export function fullName(
  firstName: string | null | undefined,
  lastName: string | null | undefined,
): string {
  const f = (firstName ?? "").trim();
  const l = (lastName ?? "").trim();
  const combined = `${f} ${l}`.trim();
  return combined || "—";
}
