// Hand-rolled fetch wrappers for /admin/video-visits — telehealth
// video visits (RT/CSR ↔ patient browser calls).

import { adminJsonFetch as jsonFetch } from "../admin-json-fetch";

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
  /** Vendor accepted the send (Twilio/SendGrid API call succeeded). */
  inviteDelivered: boolean | null;
  /** Carrier-side outcome from the Twilio status callback (SMS only):
   *  "sent" | "delivered" | "undelivered" | "failed". Null until a
   *  callback lands (and always null for email / link-only). */
  inviteDeliveryStatus: string | null;
  /** Twilio error code when undelivered/failed (e.g. "30034"). */
  inviteDeliveryErrorCode: string | null;
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
