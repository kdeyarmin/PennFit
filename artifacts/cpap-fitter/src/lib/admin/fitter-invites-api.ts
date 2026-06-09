// Hand-rolled fetch wrappers for the staff AI mask-fitter invite
// endpoints (/resupply-api/admin/fitter-invites). Auth rides on the
// in-house `pf_session` cookie via `credentials: "include"`; admin
// mutations need the CSRF header.

import { ApiError } from "@workspace/api-client-react/admin";
import { csrfHeader } from "../csrf";

export type FitterInviteChannel = "email" | "sms";

export type FitterInviteStatus =
  | "sent"
  | "opened"
  | "completed"
  | "attached"
  | "revoked"
  | "expired";

export interface CreateFitterInviteBody {
  /** Invite a current patient — server resolves their contact. */
  patientId?: string;
  /** …or a prospect, where these are supplied directly. */
  email?: string;
  phoneE164?: string;
  name?: string;
  channel: FitterInviteChannel;
}

export interface CreateFitterInviteResponse {
  id: string;
  channel: FitterInviteChannel;
  delivered: boolean;
  deliveryError: string | null;
  inviteLink: string;
}

export interface FacialMeasurementsLike {
  noseWidth: number;
  noseHeight: number;
  noseToChin: number;
  mouthWidth: number;
  faceWidthAtCheekbones: number;
  [k: string]: unknown;
}

export interface FitterInviteRow {
  id: string;
  patient_id: string | null;
  recipient_email: string | null;
  recipient_phone_e164: string | null;
  recipient_name: string | null;
  channel: FitterInviteChannel;
  status: FitterInviteStatus;
  invited_by_email: string | null;
  measurements: FacialMeasurementsLike | null;
  questionnaire_answers: Record<string, unknown> | null;
  recommended_mask_id: string | null;
  recommended_mask_name: string | null;
  recommended_mask_type: string | null;
  recommendations: unknown;
  auto_matched: boolean;
  claimed_by_user_id: string | null;
  claimed_by_email: string | null;
  claimed_at: string | null;
  sent_at: string | null;
  opened_at: string | null;
  completed_at: string | null;
  attached_at: string | null;
  expires_at: string;
  created_at: string;
}

const BASE = "/resupply-api/admin/fitter-invites";

export async function createFitterInvite(
  body: CreateFitterInviteBody,
): Promise<CreateFitterInviteResponse> {
  const res = await fetch(BASE, {
    method: "POST",
    credentials: "include",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
      ...csrfHeader(),
    },
    body: JSON.stringify(body),
  });
  const json = (await res.json()) as CreateFitterInviteResponse | unknown;
  if (!res.ok) throw new ApiError(res, json, { method: "POST", url: BASE });
  return json as CreateFitterInviteResponse;
}

/**
 * `status` accepts the lifecycle states plus two pseudo-filters:
 *   "all"     — everything
 *   "holding" — the holding area: completed fittings not yet attached
 *               to a chart (prospects who finished but aren't patients)
 */
export async function listFitterInvites(
  status: FitterInviteStatus | "all" | "holding" = "all",
): Promise<FitterInviteRow[]> {
  let qs = "";
  if (status === "holding") qs = "?holding=1";
  else if (status !== "all") qs = `?status=${encodeURIComponent(status)}`;
  const url = `${BASE}${qs}`;
  const res = await fetch(url, {
    credentials: "include",
    headers: { Accept: "application/json" },
  });
  const json = (await res.json()) as { invites?: FitterInviteRow[] } | unknown;
  if (!res.ok) throw new ApiError(res, json, { method: "GET", url });
  return (json as { invites?: FitterInviteRow[] }).invites ?? [];
}

export async function claimFitterInvite(
  id: string,
): Promise<{ id: string; claimedByEmail: string | null; claimedAt: string }> {
  const url = `${BASE}/${encodeURIComponent(id)}/claim`;
  const res = await fetch(url, {
    method: "POST",
    credentials: "include",
    headers: { Accept: "application/json", ...csrfHeader() },
  });
  const json = (await res.json()) as unknown;
  if (!res.ok) throw new ApiError(res, json, { method: "POST", url });
  return json as {
    id: string;
    claimedByEmail: string | null;
    claimedAt: string;
  };
}

export async function releaseFitterInvite(
  id: string,
): Promise<{ id: string; released: boolean }> {
  const url = `${BASE}/${encodeURIComponent(id)}/release`;
  const res = await fetch(url, {
    method: "POST",
    credentials: "include",
    headers: { Accept: "application/json", ...csrfHeader() },
  });
  const json = (await res.json()) as unknown;
  if (!res.ok) throw new ApiError(res, json, { method: "POST", url });
  return json as { id: string; released: boolean };
}

export interface AttachFitterInviteBody {
  patientId?: string;
  createPatient?: {
    legalFirstName: string;
    legalLastName: string;
    dateOfBirth: string;
  };
}

export interface AttachFitterInviteResponse {
  id: string;
  patientId: string;
  status: "attached";
  /** True when a new chart was built AND enrolled in the first-90-day
   *  onboarding program. Absent/false when attaching to an existing
   *  chart. */
  enrolledInOnboarding?: boolean;
}

export async function attachFitterInvite(
  id: string,
  body: AttachFitterInviteBody,
): Promise<AttachFitterInviteResponse> {
  const url = `${BASE}/${encodeURIComponent(id)}/attach`;
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
  const json = (await res.json()) as unknown;
  if (!res.ok) throw new ApiError(res, json, { method: "POST", url });
  return json as AttachFitterInviteResponse;
}

export async function resendFitterInvite(
  id: string,
): Promise<{ id: string; delivered: boolean; inviteLink: string }> {
  const url = `${BASE}/${encodeURIComponent(id)}/resend`;
  const res = await fetch(url, {
    method: "POST",
    credentials: "include",
    headers: { Accept: "application/json", ...csrfHeader() },
  });
  const json = (await res.json()) as unknown;
  if (!res.ok) throw new ApiError(res, json, { method: "POST", url });
  return json as { id: string; delivered: boolean; inviteLink: string };
}

export async function revokeFitterInvite(
  id: string,
): Promise<{ id: string; status: "revoked" }> {
  const url = `${BASE}/${encodeURIComponent(id)}`;
  const res = await fetch(url, {
    method: "DELETE",
    credentials: "include",
    headers: { Accept: "application/json", ...csrfHeader() },
  });
  const json = (await res.json()) as unknown;
  if (!res.ok) throw new ApiError(res, json, { method: "DELETE", url });
  return json as { id: string; status: "revoked" };
}
