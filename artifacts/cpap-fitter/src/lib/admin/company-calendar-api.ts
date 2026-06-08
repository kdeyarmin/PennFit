// Hand-rolled fetch wrappers for /admin/company-calendar — the shared,
// staff-wide appointment calendar.

import { ApiError } from "@workspace/api-client-react/admin";
import { csrfHeader } from "../csrf";

export type CalendarEventType =
  | "fitting_virtual"
  | "fitting_in_person"
  | "setup_virtual"
  | "setup_in_person"
  | "follow_up"
  | "consultation"
  | "other";

export interface CompanyCalendarEvent {
  id: string;
  patientId: string;
  patientFirstName: string | null;
  patientLastName: string | null;
  eventType: CalendarEventType;
  startsAt: string;
  endsAt: string;
  location: string | null;
  notes: string | null;
  createdByUserId: string | null;
  createdByEmail: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CalendarEventInput {
  patientId: string;
  eventType: CalendarEventType;
  startsAt: string;
  endsAt: string;
  location?: string | null;
  notes?: string | null;
}

async function jsonFetch<T>(path: string, init: RequestInit = {}): Promise<T> {
  const method = (init.method ?? "GET").toUpperCase();
  const url = `/resupply-api${path}`;
  const { headers: initHeaders, ...restInit } = init;
  const res = await fetch(url, {
    ...restInit,
    credentials: "include",
    headers: {
      Accept: "application/json",
      ...csrfHeader(),
      ...(initHeaders ?? {}),
    },
  });
  if (!res.ok) {
    let data: unknown = null;
    try {
      data = await res.json();
    } catch {
      // body not JSON
    }
    throw new ApiError(res, data, { method, url });
  }
  return (await res.json()) as T;
}

export const listCompanyCalendar = (fromIso: string, toIso: string) =>
  jsonFetch<{ events: CompanyCalendarEvent[] }>(
    `/admin/company-calendar?from=${encodeURIComponent(
      fromIso,
    )}&to=${encodeURIComponent(toIso)}`,
  );

export const createCalendarEvent = (body: CalendarEventInput) =>
  jsonFetch<{ id: string }>("/admin/company-calendar", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

export const updateCalendarEvent = (
  id: string,
  body: Partial<CalendarEventInput>,
) =>
  jsonFetch<{ ok: true }>(`/admin/company-calendar/${id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

export const deleteCalendarEvent = (id: string) =>
  jsonFetch<{ ok: true }>(`/admin/company-calendar/${id}`, {
    method: "DELETE",
  });
