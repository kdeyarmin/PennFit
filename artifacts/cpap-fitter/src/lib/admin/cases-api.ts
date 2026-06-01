// Fetch wrappers for /admin/cases (Phase 4, CSR #17) — the lightweight
// multi-channel case/ticket object over the F4 cases + case_links tables.
// Read on cases.read, write on cases.manage. Routes return camelCase.

import { ApiError } from "@workspace/api-client-react/admin";

import { csrfHeader } from "../csrf";

export type CaseStatus = "open" | "in_progress" | "resolved" | "closed";
export type CasePriority = "low" | "normal" | "high" | "urgent";
export type CaseLinkKind =
  | "conversation"
  | "order"
  | "followup"
  | "fax"
  | "review"
  | "product_question"
  | "referral"
  | "work_item"
  | "other";

export interface CaseRow {
  id: string;
  title: string;
  status: CaseStatus;
  priority: CasePriority;
  patientId: string | null;
  customerId: string | null;
  assignedToUserId: string | null;
  openedByEmail: string | null;
  summary: string | null;
  createdAt: string;
  updatedAt: string;
  resolvedAt: string | null;
}

export interface CaseLink {
  id: string;
  linkKind: CaseLinkKind;
  refId: string;
  note: string | null;
  createdByEmail: string | null;
  createdAt: string;
}

async function jsonFetch<T>(path: string, init: RequestInit = {}): Promise<T> {
  const { headers, ...rest } = init;
  const method = (init.method ?? "GET").toUpperCase();
  const url = `/resupply-api${path}`;
  const res = await fetch(url, {
    ...rest,
    credentials: "include",
    headers: {
      Accept: "application/json",
      ...csrfHeader(),
      ...(headers ?? {}),
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

export function listCases(
  status?: CaseStatus | "all",
): Promise<{ cases: CaseRow[] }> {
  const qs = status ? `?status=${status}` : "";
  return jsonFetch<{ cases: CaseRow[] }>(`/admin/cases${qs}`);
}

export function getCase(
  id: string,
): Promise<{ case: CaseRow; links: CaseLink[] }> {
  return jsonFetch(`/admin/cases/${encodeURIComponent(id)}`);
}

export function createCase(body: {
  title: string;
  priority?: CasePriority;
  patientId?: string;
  customerId?: string;
  summary?: string;
}): Promise<{ id: string; createdAt: string }> {
  return jsonFetch("/admin/cases", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

export function patchCase(
  id: string,
  body: Partial<{
    status: CaseStatus;
    priority: CasePriority;
    assignedToUserId: string | null;
    summary: string;
  }>,
): Promise<unknown> {
  return jsonFetch(`/admin/cases/${encodeURIComponent(id)}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

export function addCaseLink(
  id: string,
  body: { linkKind: CaseLinkKind; refId: string; note?: string },
): Promise<unknown> {
  return jsonFetch(`/admin/cases/${encodeURIComponent(id)}/links`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}
