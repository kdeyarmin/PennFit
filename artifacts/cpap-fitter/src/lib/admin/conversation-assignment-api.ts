// Hand-rolled fetch wrappers for conversation assignment / priority /
// SLA / escalation endpoints. The generated OpenAPI client doesn't
// include these yet — add them to the spec when the surface stabilizes.

import { ApiError } from "@workspace/api-client-react/admin";

import { csrfHeader } from "../csrf";

export type Priority = "low" | "normal" | "high" | "urgent";

async function post(
  path: string,
  body?: Record<string, unknown>,
): Promise<unknown> {
  const url = `/resupply-api${path}`;
  const res = await fetch(url, {
    method: "POST",
    credentials: "include",
    headers: {
      Accept: "application/json",
      ...(body ? { "Content-Type": "application/json" } : {}),
      ...csrfHeader(),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const json = (await res.json().catch(() => null)) as {
      error?: string;
      message?: string;
    } | null;
    throw new ApiError(res, json, { method: "POST", url });
  }
  return await res.json();
}

export const claimConversation = (id: string, force = false) =>
  post(
    `/conversations/${encodeURIComponent(id)}/claim${force ? "?force=1" : ""}`,
  );

export const releaseConversation = (id: string) =>
  post(`/conversations/${encodeURIComponent(id)}/release`);

export const assignConversation = (id: string, userId: string) =>
  post(`/conversations/${encodeURIComponent(id)}/assign`, { userId });

export const setConversationPriority = (id: string, priority: Priority) =>
  post(`/conversations/${encodeURIComponent(id)}/priority`, { priority });

export const escalateConversation = (
  id: string,
  body: { reason: string; escalateTo?: string | null },
) => post(`/conversations/${encodeURIComponent(id)}/escalate`, body);

export const deEscalateConversation = (id: string) =>
  post(`/conversations/${encodeURIComponent(id)}/de-escalate`);

export type ConversationStatus =
  | "open"
  | "awaiting_patient"
  | "awaiting_admin"
  | "closed";

/**
 * Phase 8 — flip an in_app conversation's status. Restricted server-
 * side to channel='in_app'; calling on SMS/email/voice rows returns
 * 409 wrong_channel. Idempotent (returns `changed: false` when the
 * row is already in the requested status).
 */
export const setConversationStatus = (id: string, status: ConversationStatus) =>
  post(`/conversations/${encodeURIComponent(id)}/status`, {
    status,
  }) as Promise<{
    ok: true;
    status: ConversationStatus;
    changed: boolean;
  }>;
