// Hand-rolled fetch wrappers for the patient timeline + address-
// history admin endpoints.

import { ApiError } from "@workspace/api-client-react/admin";
import { csrfHeader } from "../csrf";

export interface TimelineEvent {
  kind:
    | "episode_created"
    | "episode_status"
    | "fulfillment_shipped"
    | "fulfillment_delivered"
    | "conversation_opened"
    | "address_changed"
    | "grievance_received"
    | "coaching_plan_opened"
    | "recall_notified"
    | "onboarding_day"
    | "video_visit";
  title: string;
  detail: string;
  refId: string;
  at: string;
}

export interface AddressHistoryEntry {
  id: string;
  line1: string | null;
  line2: string | null;
  city: string | null;
  state: string | null;
  postalCode: string | null;
  country: string | null;
  reason: string | null;
  changedByUserId: string | null;
  createdAt: string;
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

export const fetchPatientTimeline = (patientId: string) =>
  jsonFetch<{ events: TimelineEvent[] }>(
    `/admin/patients/${patientId}/timeline`,
  );

export const fetchPatientAddressHistory = (patientId: string) =>
  jsonFetch<{ history: AddressHistoryEntry[] }>(
    `/admin/patients/${patientId}/address-history`,
  );

export const postPatientAddressChange = (
  patientId: string,
  body: {
    line1?: string | null;
    line2?: string | null;
    city?: string | null;
    state?: string | null;
    postalCode?: string | null;
    country?: string | null;
    reason: string;
  },
) =>
  jsonFetch<{ id: string }>(`/admin/patients/${patientId}/address-history`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
