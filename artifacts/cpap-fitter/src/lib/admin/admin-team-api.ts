// Hand-rolled fetch wrappers for the admin team management endpoints.
// Auth rides on the in-house `pf_session` cookie via
// `credentials: "include"` — no bearer token bridge.

import { ApiError } from "@workspace/api-client-react/admin";

import { csrfHeader } from "../csrf";

// RBAC Phase A: the team API now persists the granular role on
// `admin_users.role`. The coarse "admin or agent" still drives
// requireAdmin (staff-or-not); the granular role drives
// requirePermission via the rbac catalog.
export type TeamRole =
  | "admin"
  | "supervisor"
  | "csr"
  | "fitter"
  | "fulfillment"
  | "compliance_officer"
  | "agent";
export type TeamStatus = "pending" | "active" | "revoked";

export interface TeamMember {
  id: string;
  email: string;
  authUserId: string | null;
  role: TeamRole;
  status: TeamStatus;
  displayName: string | null;
  notes: string | null;
  invitedBy: string | null;
  invitedAt: string;
  acceptedAt: string | null;
  revokedAt: string | null;
  revokedBy: string | null;
  lastLoginAt: string | null;
  /** When the background invite-expiry notifier emailed this
   *  invitee a heads-up that their admin-typed temporary password
   *  is about to expire. Null when no heads-up was sent (or the
   *  row isn't a pending admin-typed invite). */
  expiryReminderSentAt: string | null;
  /** When the notifier emailed this invitee that their temporary
   *  password has expired and they need to ask for a re-invite.
   *  Null when no such email was sent. */
  expiredNoticeSentAt: string | null;
}

interface InviteResponse {
  member: TeamMember;
  emailSent: boolean;
  inviteLink: string | null;
  /** True when the admin supplied an initial password and the
   *  account is immediately sign-in-ready (no email roundtrip). */
  signInReady?: boolean;
}

const BASE = "/resupply-api/admin/team";

export async function listTeam(): Promise<{ members: TeamMember[] }> {
  const res = await fetch(BASE, {
    credentials: "include",
    headers: { Accept: "application/json" },
  });
  if (!res.ok) {
    let data: unknown = null;
    try {
      data = await res.json();
    } catch {
      /* body not JSON */
    }
    throw new ApiError(res, data, { method: "GET", url: BASE });
  }
  return (await res.json()) as { members: TeamMember[] };
}

export async function inviteMember(body: {
  email: string;
  role: TeamRole;
  displayName?: string | null;
  notes?: string | null;
  /** Optional. When provided (>= 8 chars), the user is created
   *  active + email-verified with this password and no invite
   *  email is sent — admin tells the user out-of-band. */
  initialPassword?: string | null;
}): Promise<InviteResponse> {
  const url = `${BASE}/invite`;
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
    | { error?: string; message?: string; memberId?: string };
  if (!res.ok) {
    throw new ApiError(res, json, { method: "POST", url });
  }
  if (!("member" in json)) {
    const errMsg =
      ("message" in json && json.message) ||
      ("error" in json && json.error) ||
      `Invite failed (${res.status})`;
    throw new Error(errMsg);
  }
  return json;
}

export async function resendInvite(id: string): Promise<InviteResponse> {
  const url = `${BASE}/${encodeURIComponent(id)}/resend`;
  const res = await fetch(url, {
    method: "POST",
    credentials: "include",
    headers: { Accept: "application/json", ...csrfHeader() },
  });
  if (!res.ok) {
    const json = (await res.json().catch(() => null)) as {
      error?: string;
      message?: string;
    } | null;
    throw new ApiError(res, json, { method: "POST", url });
  }
  return (await res.json()) as InviteResponse;
}

export async function revokeMember(
  id: string,
): Promise<{ member: TeamMember }> {
  const url = `${BASE}/${encodeURIComponent(id)}/revoke`;
  const res = await fetch(url, {
    method: "POST",
    credentials: "include",
    headers: { Accept: "application/json", ...csrfHeader() },
  });
  if (!res.ok) {
    const json = (await res.json().catch(() => null)) as {
      error?: string;
      message?: string;
    } | null;
    throw new ApiError(res, json, { method: "POST", url });
  }
  return (await res.json()) as { member: TeamMember };
}

export async function patchMember(
  id: string,
  body: Partial<{
    role: TeamRole;
    displayName: string | null;
    notes: string | null;
  }>,
): Promise<{ member: TeamMember }> {
  const url = `${BASE}/${encodeURIComponent(id)}`;
  const res = await fetch(url, {
    method: "PATCH",
    credentials: "include",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
      ...csrfHeader(),
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const json = (await res.json().catch(() => null)) as {
      error?: string;
      message?: string;
    } | null;
    throw new ApiError(res, json, { method: "PATCH", url });
  }
  return (await res.json()) as { member: TeamMember };
}
