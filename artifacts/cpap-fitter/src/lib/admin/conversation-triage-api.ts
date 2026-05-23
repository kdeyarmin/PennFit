// Hand-rolled fetch wrappers for the Wave 1 conversation triage
// endpoints (snooze / tags / claim) + transcript download URL.

import { csrfHeader } from "../csrf";

export const triageApi = {
  setSnooze: (id: string, snoozedUntil: string | null) =>
    jsonFetch<{ ok: true }>(`/admin/conversations/${id}/snooze`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ snoozedUntil }),
    }),
  setTags: (id: string, tags: string[]) =>
    jsonFetch<{ ok: true; tags: string[] }>(
      `/admin/conversations/${id}/tags`,
      {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tags }),
      },
    ),
  claim: (id: string) =>
    jsonFetch<{ ok: true }>(`/admin/conversations/${id}/claim`, {
      method: "POST",
    }),
  transcriptCsvUrl: (id: string) =>
    `/resupply-api/admin/conversations/${id}/transcript.csv`,
};

async function jsonFetch<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(`/resupply-api${path}`, {
    credentials: "include",
    headers: { Accept: "application/json", ...csrfHeader(), ...(init.headers ?? {}) },
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
