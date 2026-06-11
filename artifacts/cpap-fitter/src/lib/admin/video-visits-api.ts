// Hand-rolled fetch wrappers for /admin/video-visits — telehealth
// video visits (RT/CSR ↔ patient browser calls).

import { ApiError } from "@workspace/api-client-react/admin";

import { csrfHeader } from "../csrf";

export type VideoVisitPurpose =
  | "setup"
  | "troubleshooting"
  | "follow_up"
  | "other";

export type VideoVisitStatus =
  | "scheduled"
  | "in_progress"
  | "completed"
  | "cancelled";

export interface VideoVisit {
  id: string;
  patientId: string | null;
  /** Chart name, or the typed-in guest name for no-chart visits. */
  patientName: string | null;
  isGuest: boolean;
  purpose: VideoVisitPurpose;
  notes: string | null;
  status: VideoVisitStatus;
  scheduledAt: string | null;
  createdByEmail: string | null;
  inviteChannel: "email" | "sms" | "none" | null;
  inviteDelivered: boolean | null;
  staffJoinedAt: string | null;
  patientJoinedAt: string | null;
  startedAt: string | null;
  endedAt: string | null;
  createdAt: string;
}

export interface CreateVideoVisitInput {
  purpose: VideoVisitPurpose;
  channel: "email" | "sms" | "none";
  scheduledAt?: string;
  notes?: string;
  email?: string;
  phoneE164?: string;
}

export interface CreateVideoVisitResponse {
  visit: VideoVisit;
  joinUrl: string;
  delivered: boolean;
  deliveryError: string | null;
}

export interface JoinVideoVisitResponse {
  visit: VideoVisit;
  staffToken: string;
  wsPath: string;
  iceServers: RTCIceServer[];
  patientJoinUrl: string;
}

async function jsonFetch<T>(path: string, init: RequestInit = {}): Promise<T> {
  const { headers, ...rest } = init;
  const method = (init.method ?? "GET").toUpperCase();
  const url = `/resupply-api${path}`;
  const res = await fetch(url, {
    credentials: "include",
    headers: {
      Accept: "application/json",
      ...csrfHeader(),
      ...(headers ?? {}),
    },
    ...rest,
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

export const listVideoVisits = (opts?: { includeClosed?: boolean }) =>
  jsonFetch<{ visits: VideoVisit[] }>(
    `/admin/video-visits${opts?.includeClosed ? "?include=closed" : ""}`,
  );

export const createVideoVisit = (
  patientId: string,
  input: CreateVideoVisitInput,
) =>
  jsonFetch<CreateVideoVisitResponse>(
    `/admin/patients/${encodeURIComponent(patientId)}/video-visits`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
    },
  );

/** Universal create — works for an existing patient (patientId) OR a
 *  typed-in guest who isn't in the system yet (guestName + email/phone). */
export const createVideoVisitUniversal = (
  input: CreateVideoVisitInput & { patientId?: string; guestName?: string },
) =>
  jsonFetch<CreateVideoVisitResponse>(`/admin/video-visits`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });

export const resendVideoVisitInvite = (
  visitId: string,
  input: { channel: "email" | "sms"; email?: string; phoneE164?: string },
) =>
  jsonFetch<{
    joinUrl: string;
    delivered: boolean;
    deliveryError: string | null;
  }>(`/admin/video-visits/${encodeURIComponent(visitId)}/invite`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });

export const joinVideoVisit = (visitId: string) =>
  jsonFetch<JoinVideoVisitResponse>(
    `/admin/video-visits/${encodeURIComponent(visitId)}/join`,
    { method: "POST" },
  );

export const cancelVideoVisit = (visitId: string) =>
  jsonFetch<{ ok: boolean }>(
    `/admin/video-visits/${encodeURIComponent(visitId)}/cancel`,
    { method: "POST" },
  );

export const completeVideoVisit = (visitId: string) =>
  jsonFetch<{ ok: boolean }>(
    `/admin/video-visits/${encodeURIComponent(visitId)}/complete`,
    { method: "POST" },
  );
