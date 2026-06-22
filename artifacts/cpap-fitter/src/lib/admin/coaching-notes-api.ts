// Hand-rolled fetch wrappers for the supervisor coaching-notes
// surface.

import { adminJsonFetch as jsonFetch } from "../admin-json-fetch";

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
