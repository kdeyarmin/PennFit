// Hand-rolled fetch wrappers for the supervisor coaching-notes
// surface.

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
  const res = await fetch(`/resupply-api${path}`, {
    credentials: "include",
    headers: { Accept: "application/json", ...(init.headers ?? {}) },
    ...init,
  });
  if (!res.ok) {
    let message = `${res.status} ${res.statusText}`;
    try {
      const body = (await res.json()) as { message?: string; error?: string };
      message = body.message ?? body.error ?? message;
    } catch {
      // ignore
    }
    throw new Error(message);
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
  }>(
    `/admin/team/${encodeURIComponent(userId)}/coaching-notes`,
  );
