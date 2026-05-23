// Hand-rolled fetch wrappers for /admin/appointment-requests. Same
// pattern as today-api.ts.

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
  const res = await fetch(`/resupply-api${path}`, {
    ...restInit,
    credentials: "include",
    headers: { Accept: "application/json", ...csrfHeader(), ...(initHeaders ?? {}) },
  });
  if (!res.ok) {
    let message = `${res.status} ${res.statusText}`;
    try {
      const body = (await res.json()) as { message?: string; error?: string };
      message = body.message ?? body.error ?? message;
    } catch {
      // ignore non-JSON
    }
    throw new Error(message);
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
