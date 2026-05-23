// Hand-rolled fetch wrappers for /admin/patient-documents/retention.

import { csrfHeader } from "../csrf";

export type RetentionBucket =
  | "active"
  | "due_soon"
  | "due_now"
  | "marked"
  | "destroyed"
  | "legal_hold";

export interface RetentionDocument {
  id: string;
  patientId: string;
  documentType: string;
  filename: string | null;
  contentType: string;
  sizeBytes: number;
  createdAt: string;
  retentionUntilAt: string | null;
  legalHold: boolean;
  retentionMarkedAt: string | null;
  destroyedAt: string | null;
  bucket: RetentionBucket;
}

export interface RetentionListResponse {
  count: number;
  documents: RetentionDocument[];
}

async function jsonFetch<T>(path: string, init: RequestInit = {}): Promise<T> {
  const { headers: initHeaders, ...restInit } = init;
  const res = await fetch(`/resupply-api${path}`, {
    ...restInit,
    credentials: "include",
    headers: { Accept: "application/json", ...csrfHeader(), ...(initHeaders ?? {}) },
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

export const listRetentionDocuments = (bucket?: RetentionBucket) => {
  const qs = bucket ? `?bucket=${bucket}` : "";
  return jsonFetch<RetentionListResponse>(
    `/admin/patient-documents/retention${qs}`,
  );
};

export const setLegalHold = (
  id: string,
  body: { hold: boolean; reason: string },
) =>
  jsonFetch<{ ok: true; legalHold: boolean }>(
    `/admin/patient-documents/${id}/legal-hold`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    },
  );

export const destroyDocument = (id: string) =>
  jsonFetch<{ ok: true; destroyedAt: string }>(
    `/admin/patient-documents/${id}/destroy`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ confirm: "DESTROY" }),
    },
  );
