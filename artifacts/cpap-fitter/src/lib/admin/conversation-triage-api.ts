// Hand-rolled fetch wrappers for the Wave 1 conversation triage
// endpoints (snooze / tags / claim) + transcript download URL.

import { ApiError } from "@workspace/api-client-react/admin";

import { csrfHeader } from "../csrf";

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
      // body not JSON
    }
    throw new ApiError(res, data, { method, url });
  }
  return (await res.json()) as T;
}
