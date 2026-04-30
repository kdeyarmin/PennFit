// Hand-rolled fetch wrappers for the admin team management endpoints.

type ClerkGlobal = {
  session?: { getToken: () => Promise<string | null> } | null;
};

async function authHeaders(): Promise<Record<string, string>> {
  const clerk = (globalThis as unknown as { Clerk?: ClerkGlobal }).Clerk;
  if (!clerk?.session) return {};
  try {
    const token = await clerk.session.getToken();
    return token ? { Authorization: `Bearer ${token}` } : {};
  } catch {
    return {};
  }
}

export type TeamRole = "admin" | "agent";
export type TeamStatus = "pending" | "active" | "revoked";

export interface TeamMember {
  id: string;
  email: string;
  clerkUserId: string | null;
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

const BASE = "/resupply-api/admin/team";

export async function listTeam(): Promise<{ members: TeamMember[] }> {
  const res = await fetch(BASE, {
    headers: { Accept: "application/json", ...(await authHeaders()) },
  });
  if (!res.ok) throw new Error(`Failed to load team (${res.status})`);
  return (await res.json()) as { members: TeamMember[] };
}

export async function inviteMember(body: {
  email: string;
  role: TeamRole;
  displayName?: string | null;
  notes?: string | null;
}): Promise<{ member: TeamMember; clerkInviteSent: boolean }> {
  const res = await fetch(`${BASE}/invite`, {
    method: "POST",
    credentials: "include",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
      ...(await authHeaders()),
    },
    body: JSON.stringify(body),
  });
  const json = (await res.json()) as
    | { member: TeamMember; clerkInviteSent: boolean }
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

export async function resendInvite(id: string): Promise<{ member: TeamMember; clerkInviteSent: boolean }> {
  const res = await fetch(`${BASE}/${encodeURIComponent(id)}/resend`, {
    method: "POST",
    credentials: "include",
    headers: { Accept: "application/json", ...(await authHeaders()) },
  });
  if (!res.ok) {
    const json = (await res.json().catch(() => null)) as
      | { error?: string; message?: string }
      | null;
    throw new Error(json?.message ?? json?.error ?? `Resend failed (${res.status})`);
  }
  return (await res.json()) as { member: TeamMember; clerkInviteSent: boolean };
}

export async function revokeMember(id: string): Promise<{ member: TeamMember }> {
  const res = await fetch(`${BASE}/${encodeURIComponent(id)}/revoke`, {
    method: "POST",
    credentials: "include",
    headers: { Accept: "application/json", ...(await authHeaders()) },
  });
  if (!res.ok) {
    const json = (await res.json().catch(() => null)) as
      | { error?: string; message?: string }
      | null;
    throw new Error(json?.message ?? json?.error ?? `Revoke failed (${res.status})`);
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
      ...(await authHeaders()),
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const json = (await res.json().catch(() => null)) as
      | { error?: string; message?: string }
      | null;
    throw new Error(json?.message ?? json?.error ?? `Patch failed (${res.status})`);
  }
  return (await res.json()) as { member: TeamMember };
}
