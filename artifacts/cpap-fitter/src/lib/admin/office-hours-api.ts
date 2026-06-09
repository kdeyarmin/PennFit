// Hand-rolled fetch wrappers for /admin/office-hours — the practice's
// standard weekly open hours (the "open by default" baseline). day_of_week:
// 0=Sun … 6=Sat; times are UTC "HH:MM:SS".

import { ApiError } from "@workspace/api-client-react/admin";
import { csrfHeader } from "../csrf";

export interface OfficeHoursWindow {
  id: string;
  dayOfWeek: number;
  openTimeUtc: string;
  closeTimeUtc: string;
  active: boolean;
}

export interface OfficeHoursWindowInput {
  dayOfWeek: number;
  openTimeUtc: string;
  closeTimeUtc: string;
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

export const getOfficeHours = () =>
  jsonFetch<{ windows: OfficeHoursWindow[] }>("/admin/office-hours");

export const putOfficeHours = (windows: OfficeHoursWindowInput[]) =>
  jsonFetch<{ ok: true }>("/admin/office-hours", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ windows }),
  });
