// Hand-rolled fetch wrappers for /admin/office-closures.

import { ApiError } from "@workspace/api-client-react/admin";
import { csrfHeader } from "../csrf";

export interface OfficeClosure {
  id: string;
  label: string;
  startsAt: string;
  endsAt: string;
  autoReplyMessage: string;
  createdByUserId: string | null;
  createdAt: string;
  updatedAt: string;
}

async function jsonFetch<T>(path: string, init: RequestInit = {}): Promise<T> {
  const method = (init.method ?? "GET").toUpperCase();
  const url = `/resupply-api${path}`;
  const { headers: initHeaders, ...restInit } = init;
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

export const listOfficeClosures = () =>
  jsonFetch<{ closures: OfficeClosure[] }>("/admin/office-closures");

export const getActiveClosure = () =>
  jsonFetch<{ active: OfficeClosure | null }>("/admin/office-closures/active");

export const createClosure = (body: {
  label: string;
  startsAt: string;
  endsAt: string;
  autoReplyMessage: string;
}) =>
  jsonFetch<{ id: string }>("/admin/office-closures", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

export const endClosureNow = (id: string) =>
  jsonFetch<{ ok: true }>(`/admin/office-closures/${id}/end-now`, {
    method: "POST",
  });
