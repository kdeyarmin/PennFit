// Hand-rolled fetch wrappers for the patient portal invite endpoints.
// Auth rides on the in-house `pf_session` cookie via
// `credentials: "include"`.

import { ApiError } from "@workspace/api-client-react/admin";
import { csrfHeader } from "../csrf";

export type PortalStatus = "not_invited" | "pending" | "active";

export interface Address {
  line1: string;
  line2?: string;
  city: string;
  state: string;
  postalCode: string;
  country: string;
}

export interface SendInviteBody {
  email?: string;
  phoneE164?: string | null;
  address?: Address | null;
  insurancePayer?: string | null;
  channelPreference?: "sms" | "email" | "voice" | null;
}

export interface InviteResponse {
  portalStatus: PortalStatus;
  emailSent: boolean;
  inviteLink: string | null;
}

const base = (patientId: string) =>
  `/resupply-api/admin/patients/${encodeURIComponent(patientId)}/portal-invite`;

export async function sendPortalInvite(
  patientId: string,
  body: SendInviteBody,
): Promise<InviteResponse> {
  const url = base(patientId);
  const res = await fetch(url, {
    method: "POST",
    credentials: "include",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
      ...csrfHeader(),
    },
    body: JSON.stringify(body),
  });
  const json = (await res.json()) as
    | InviteResponse
    | {
        error?: string;
        message?: string;
        issues?: { path: string; message: string }[];
      };
  if (!res.ok) {
    throw new ApiError(res, json, { method: "POST", url });
  }
  return json as InviteResponse;
}

export async function resendPortalInvite(
  patientId: string,
): Promise<InviteResponse> {
  const url = `${base(patientId)}/resend`;
  const res = await fetch(url, {
    method: "POST",
    credentials: "include",
    headers: { Accept: "application/json", ...csrfHeader() },
  });
  const json = (await res.json()) as
    | InviteResponse
    | { error?: string; message?: string };
  if (!res.ok) {
    throw new ApiError(res, json, { method: "POST", url });
  }
  return json as InviteResponse;
}

export async function revokePortalInvite(
  patientId: string,
): Promise<{ portalStatus: PortalStatus }> {
  const url = base(patientId);
  const res = await fetch(url, {
    method: "DELETE",
    credentials: "include",
    headers: { Accept: "application/json", ...csrfHeader() },
  });
  const json = (await res.json()) as
    | { portalStatus: PortalStatus }
    | { error?: string; message?: string };
  if (!res.ok) {
    throw new ApiError(res, json, { method: "DELETE", url });
  }
  return json as { portalStatus: PortalStatus };
}
