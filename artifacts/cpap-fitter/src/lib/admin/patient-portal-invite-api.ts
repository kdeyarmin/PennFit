// Hand-rolled fetch wrappers for the patient portal invite endpoints.
// Auth rides on the in-house `pf_session` cookie via
// `credentials: "include"`.

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
  const res = await fetch(base(patientId), {
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
    | { error?: string; message?: string; issues?: { path: string; message: string }[] };
  if (!res.ok) {
    const err = json as { error?: string; message?: string; issues?: { path: string; message: string }[] };
    const issueText = err.issues?.map((i) => `${i.path}: ${i.message}`).join("; ");
    throw new Error(issueText ?? err.message ?? err.error ?? `Invite failed (${res.status})`);
  }
  return json as InviteResponse;
}

export async function resendPortalInvite(
  patientId: string,
): Promise<InviteResponse> {
  const res = await fetch(`${base(patientId)}/resend`, {
    method: "POST",
    credentials: "include",
    headers: { Accept: "application/json", ...csrfHeader() },
  });
  const json = (await res.json()) as
    | InviteResponse
    | { error?: string; message?: string };
  if (!res.ok) {
    const err = json as { error?: string; message?: string };
    throw new Error(err.message ?? err.error ?? `Resend failed (${res.status})`);
  }
  return json as InviteResponse;
}

export async function revokePortalInvite(
  patientId: string,
): Promise<{ portalStatus: PortalStatus }> {
  const res = await fetch(base(patientId), {
    method: "DELETE",
    credentials: "include",
    headers: { Accept: "application/json", ...csrfHeader() },
  });
  const json = (await res.json()) as
    | { portalStatus: PortalStatus }
    | { error?: string; message?: string };
  if (!res.ok) {
    const err = json as { error?: string; message?: string };
    throw new Error(err.message ?? err.error ?? `Revoke failed (${res.status})`);
  }
  return json as { portalStatus: PortalStatus };
}
