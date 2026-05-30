// Hand-rolled fetch wrappers for the supervisor coaching-notes
// surface.

import { ApiError } from "@workspace/api-client-react/admin";

import { csrfHeader } from "../csrf";

export type CoachingNoteKind = "praise" | "suggestion" | "concern";

export interface CoachingNote {
  id: string;
  conversationId: string;
  targetUserId: string;
  authorUserId: string;
  kind: CoachingNoteKind;
  body: string;
  createdAt: string;
  updatedAt?: string;
}

async function jsonFetch<T>(path: string, init: RequestInit = {}): Promise<T> {
  const { headers: initHeaders, ...restInit } = init;
  const method = (init.method ?? "GET").toUpperCase();
  const url = `/resupply-api${path}`;
  const res = await fetch(url, {
    ...restInit,
    credentials: "include",
    headers: {
      Accept: "application/json",
      ...csrfHeader(),
      ...(initHeaders ?? {}),
    },
  });
  if (!res.ok) {
    let data: unknown = null;
    try {
      data = await res.json();
    } catch {
      // ignore
    }
    throw new ApiError(res, data, { method, url });
  }
  return (await res.json()) as T;
}

export const listConversationCoachingNotes = (conversationId: string) =>
  jsonFetch<{ notes: CoachingNote[] }>(
    `/admin/conversations/${encodeURIComponent(conversationId)}/coaching-notes`,
  );

export const createConversationCoachingNote = (
  conversationId: string,
  body: { targetUserId: string; kind: CoachingNoteKind; body: string },
) =>
  jsonFetch<{ id: string }>(
    `/admin/conversations/${encodeURIComponent(conversationId)}/coaching-notes`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    },
  );

export const listTeamCoachingNotes = (userId: string) =>
  jsonFetch<{
    counts: Record<string, number>;
    notes: Array<Omit<CoachingNote, "targetUserId">>;
  }>(`/admin/team/${encodeURIComponent(userId)}/coaching-notes`);
