// Hand-rolled fetch wrappers for the admin team management endpoints.
// Auth rides on the in-house `pf_session` cookie via
// `credentials: "include"` — no bearer token bridge.

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
  if (!res.ok) throw new Error(`Failed to load team (${res.status})`);
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
  const res = await fetch(`${BASE}/invite`, {
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
  if (!res.ok || !("member" in json)) {
    const errMsg =
      ("message" in json && json.message) ||
      ("error" in json && json.error) ||
      `Invite failed (${res.status})`;
    throw new Error(errMsg);
  }
  return json;
}

export async function resendInvite(id: string): Promise<InviteResponse> {
  const res = await fetch(`${BASE}/${encodeURIComponent(id)}/resend`, {
    method: "POST",
    credentials: "include",
    headers: { Accept: "application/json", ...csrfHeader() },
  });
  if (!res.ok) {
    const json = (await res.json().catch(() => null)) as {
      error?: string;
      message?: string;
    } | null;
    throw new Error(
      json?.message ?? json?.error ?? `Resend failed (${res.status})`,
    );
  }
  return (await res.json()) as InviteResponse;
}

export async function revokeMember(
  id: string,
): Promise<{ member: TeamMember }> {
  const res = await fetch(`${BASE}/${encodeURIComponent(id)}/revoke`, {
    method: "POST",
    credentials: "include",
    headers: { Accept: "application/json", ...csrfHeader() },
  });
  if (!res.ok) {
    const json = (await res.json().catch(() => null)) as {
      error?: string;
      message?: string;
    } | null;
    throw new Error(
      json?.message ?? json?.error ?? `Revoke failed (${res.status})`,
    );
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
  const res = await fetch(`${BASE}/${encodeURIComponent(id)}`, {
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
    throw new Error(
      json?.message ?? json?.error ?? `Patch failed (${res.status})`,
    );
  }
  return (await res.json()) as { member: TeamMember };
}
