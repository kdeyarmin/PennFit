// Hand-rolled fetch wrappers for the patient timeline + address-
// history admin endpoints.

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
    | "onboarding_day";
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
      // ignore
    }
    throw new Error(message);
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
  jsonFetch<{ id: string }>(
    `/admin/patients/${patientId}/address-history`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    },
  );
