// Hand-rolled fetch wrappers for /admin/office-hours — the practice's
// standard weekly open hours (the "open by default" baseline). day_of_week:
// 0=Sun … 6=Sat; times are UTC "HH:MM:SS".

import { adminJsonFetch as jsonFetch } from "../admin-json-fetch";

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

export const getOfficeHours = () =>
  jsonFetch<{ windows: OfficeHoursWindow[] }>("/admin/office-hours");

export const putOfficeHours = (windows: OfficeHoursWindowInput[]) =>
  jsonFetch<{ ok: true }>("/admin/office-hours", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ windows }),
  });
