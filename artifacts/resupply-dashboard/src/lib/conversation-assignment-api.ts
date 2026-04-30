// Hand-rolled fetch wrappers for conversation assignment / priority /
// SLA / escalation endpoints. The generated OpenAPI client doesn't
// include these yet — add them to the spec when the surface stabilizes.

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

export type Priority = "low" | "normal" | "high" | "urgent";

async function post(
  path: string,
  body?: Record<string, unknown>,
): Promise<unknown> {
  const res = await fetch(`/resupply-api${path}`, {
    method: "POST",
    credentials: "include",
    headers: {
      Accept: "application/json",
      ...(body ? { "Content-Type": "application/json" } : {}),
      ...(await authHeaders()),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const json = (await res.json().catch(() => null)) as
      | { error?: string; message?: string }
      | null;
    throw new Error(json?.message ?? json?.error ?? `Request failed (${res.status})`);
  }
  return await res.json();
}

export const claimConversation = (id: string, force = false) =>
  post(`/conversations/${encodeURIComponent(id)}/claim${force ? "?force=1" : ""}`);

export const releaseConversation = (id: string) =>
  post(`/conversations/${encodeURIComponent(id)}/release`);

export const assignConversation = (id: string, clerkUserId: string) =>
  post(`/conversations/${encodeURIComponent(id)}/assign`, { clerkUserId });

export const setConversationPriority = (id: string, priority: Priority) =>
  post(`/conversations/${encodeURIComponent(id)}/priority`, { priority });

export const escalateConversation = (
  id: string,
  body: { reason: string; escalateTo?: string | null },
) => post(`/conversations/${encodeURIComponent(id)}/escalate`, body);

export const deEscalateConversation = (id: string) =>
  post(`/conversations/${encodeURIComponent(id)}/de-escalate`);
