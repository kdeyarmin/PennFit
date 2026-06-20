// Hand-rolled fetch wrappers for the Smart Notes admin endpoints.
// A nurse writes a clinical note; the server reviews it for Medicare
// compliance, cross-checks it against the patient's chart, and compares
// it against the previous note for trends. Append-only: review (preview),
// save (create), and list.

import { ApiError } from "@workspace/api-client-react/admin";

import { csrfHeader } from "../csrf";

export type SmartNoteProvider = "anthropic" | "openai" | "offline";

export interface SmartNoteElementResult {
  key: string;
  label: string;
  present: boolean;
  detail: string;
}

export interface SmartNoteReview {
  compliant: boolean;
  score: number;
  summary: string;
  elements: SmartNoteElementResult[];
  missingElements: string[];
  suggestions: string[];
  chartConsistency: {
    summary: string;
    discrepancies: string[];
  };
  provider: SmartNoteProvider;
  promptVersion: string;
}

export interface SmartNoteComparison {
  previousNoteId: string | null;
  summary: string;
  changes: string[];
}

export interface SmartNote {
  id: string;
  noteText: string;
  authorEmail: string | null;
  authorUserId: string | null;
  compliant: boolean;
  complianceScore: number;
  review: SmartNoteReview;
  comparison: SmartNoteComparison;
  reviewProvider: SmartNoteProvider;
  promptVersion: string | null;
  createdAt: string;
}

export interface SmartNoteReviewResult {
  review: SmartNoteReview;
  comparison: SmartNoteComparison;
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

export const listSmartNotes = (patientId: string) =>
  jsonFetch<{ notes: SmartNote[] }>(
    `/patients/${encodeURIComponent(patientId)}/smart-notes`,
  );

export const reviewSmartNote = (patientId: string, noteText: string) =>
  jsonFetch<SmartNoteReviewResult>(
    `/patients/${encodeURIComponent(patientId)}/smart-notes/review`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ noteText }),
    },
  );

export const saveSmartNote = (patientId: string, noteText: string) =>
  jsonFetch<SmartNote>(
    `/patients/${encodeURIComponent(patientId)}/smart-notes`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ noteText }),
    },
  );
