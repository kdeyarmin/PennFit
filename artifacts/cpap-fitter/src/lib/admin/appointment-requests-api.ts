// Hand-rolled fetch wrappers for /admin/appointment-requests. Same
// pattern as today-api.ts.

import { ApiError } from "@workspace/api-client-react/admin";

import { csrfHeader } from "../csrf";

export type AppointmentRequestStatus =
  | "new"
  | "contacted"
  | "scheduled"
  | "declined"
  | "cancelled";

export interface AppointmentRequest {
  id: string;
  requesterEmail: string;
  requesterName: string | null;
  requesterPhone: string | null;
  topic: string;
  preferredWindow: string | null;
  notes: string | null;
  status: AppointmentRequestStatus;
  attachedPatientId: string | null;
  assignedAdminUserId: string | null;
  triagedAt: string | null;
  scheduledFor: string | null;
  createdAt: string;
}

async function jsonFetch<T>(path: string, init: RequestInit = {}): Promise<T> {
  const { headers: initHeaders, ...restInit } = init;
  const method = (init.method ?? "GET").toUpperCase();
  const url = `/resupply-api${path}`;
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
      // ignore non-JSON
    }
    throw new ApiError(res, data, { method, url });
  }
  return (await res.json()) as T;
}

export const listAppointmentRequests = (includeClosed = false) =>
  jsonFetch<{ requests: AppointmentRequest[] }>(
    `/admin/appointment-requests${includeClosed ? "?include=closed" : ""}`,
  );

export const updateAppointmentRequest = (
  id: string,
  body: {
    status?: AppointmentRequestStatus;
    attachedPatientId?: string | null;
    assignedAdminUserId?: string | null;
    scheduledFor?: string | null;
    notes?: string | null;
  },
) =>
  jsonFetch<{ ok: true }>(`/admin/appointment-requests/${id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
