// Hand-rolled fetch wrappers for the Wave 1 conversation triage
// endpoints (snooze / tags / claim) + transcript download URL.

import { adminJsonFetch as jsonFetch } from "../admin-json-fetch";

export const triageApi = {
  setSnooze: (id: string, snoozedUntil: string | null) =>
    jsonFetch<{ ok: true }>(`/admin/conversations/${id}/snooze`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ snoozedUntil }),
    }),
  setTags: (id: string, tags: string[]) =>
    jsonFetch<{ ok: true; tags: string[] }>(`/admin/conversations/${id}/tags`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ tags }),
    }),
  claim: (id: string) =>
    jsonFetch<{ ok: true }>(`/admin/conversations/${id}/claim`, {
      method: "POST",
    }),
  transcriptCsvUrl: (id: string) =>
    `/resupply-api/admin/conversations/${id}/transcript.csv`,
};
