// Hand-rolled fetch wrappers for /admin/office-closures.

import { ApiError } from "@workspace/api-client-react/admin";
import { csrfHeader } from "../csrf";

export interface OfficeClosure {
  id: string;
  label: string;
  startsAt: string;
  endsAt: string;
  autoReplyMessage: string;
  createdByUserId: string | null;
  createdAt: string;
  updatedAt: string;
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

export const listOfficeClosures = () =>
  jsonFetch<{ closures: OfficeClosure[] }>("/admin/office-closures");

export const getActiveClosure = () =>
  jsonFetch<{ active: OfficeClosure | null }>("/admin/office-closures/active");

export const createClosure = (body: {
  label: string;
  startsAt: string;
  endsAt: string;
  autoReplyMessage: string;
}) =>
  jsonFetch<{ id: string }>("/admin/office-closures", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

export const endClosureNow = (id: string) =>
  jsonFetch<{ ok: true }>(`/admin/office-closures/${id}/end-now`, {
    method: "POST",
  });

// ── Recurring (weekly) closures ──────────────────────────────────
// e.g. "every Saturday" / "every Sunday" for a standing weekend blackout.
// day_of_week: 0=Sun … 6=Sat; times are UTC "HH:MM:SS".

export interface RecurringClosure {
  id: string;
  label: string;
  dayOfWeek: number;
  startTimeUtc: string;
  endTimeUtc: string;
  autoReplyMessage: string;
  active: boolean;
  createdAt: string;
  updatedAt: string;
}

export const listRecurringClosures = () =>
  jsonFetch<{ rules: RecurringClosure[] }>("/admin/office-closures/recurring");

export const createRecurringClosure = (body: {
  label: string;
  dayOfWeek: number;
  startTimeUtc: string;
  endTimeUtc: string;
  autoReplyMessage: string;
}) =>
  jsonFetch<{ id: string }>("/admin/office-closures/recurring", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

export const patchRecurringClosure = (
  id: string,
  body: { active?: boolean; autoReplyMessage?: string },
) =>
  jsonFetch<{ ok: true }>(`/admin/office-closures/recurring/${id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
