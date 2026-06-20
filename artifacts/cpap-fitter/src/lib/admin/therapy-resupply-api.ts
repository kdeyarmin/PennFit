// Hand-rolled fetch wrappers for /admin/therapy-resupply/* endpoints.
// Same pattern as therapy-fleet-api.ts.

import { ApiError } from "@workspace/api-client-react/admin";
import { csrfHeader } from "../csrf";

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

export type SupplyCategory =
  | "mask"
  | "cushion"
  | "headgear"
  | "tubing"
  | "filter"
  | "humidifier_chamber"
  | "other";

export interface ResupplySummary {
  patientsWithDue: number;
  itemsDue: number;
  itemsOverdue: number;
  byCategory: {
    mask: number;
    cushion: number;
    tubing: number;
    filter: number;
  };
  highLeakRefit: number;
}

export interface ResupplyOpportunity {
  patientId: string;
  patientName: string | null;
  source: string;
  category: SupplyCategory;
  description: string | null;
  lastReplacedDate: string | null;
  nextEligibleDate: string | null;
  daysUntilEligible: number | null;
  highLeak: boolean;
  fetchedAt: string | null;
}

export const getResupplySummary = (dueWithinDays: number) =>
  jsonFetch<{ dueWithinDays: number; summary: ResupplySummary }>(
    `/admin/therapy-resupply/summary?dueWithinDays=${dueWithinDays}`,
  );

export const getResupplyOpportunities = (params: {
  dueWithinDays: number;
  limit?: number;
  category?: SupplyCategory;
}) => {
  const q = new URLSearchParams({
    dueWithinDays: String(params.dueWithinDays),
  });
  if (params.limit) q.set("limit", String(params.limit));
  if (params.category) q.set("category", params.category);
  return jsonFetch<{
    dueWithinDays: number;
    count: number;
    opportunities: ResupplyOpportunity[];
  }>(`/admin/therapy-resupply/opportunities?${q.toString()}`);
};

// ── Order drafts (proposals staged from opportunities) ────────────────

export type DraftStatus = "proposed" | "approved" | "dismissed" | "ordered";

export interface ResupplyDraft {
  id: string;
  patientId: string;
  patientName: string | null;
  category: SupplyCategory | string;
  source: string | null;
  sourceDescription: string | null;
  nextEligibleDate: string | null;
  suggestedProductId: string | null;
  suggestedQuantity: number;
  status: DraftStatus;
  origin: "auto" | "manual";
  createdAt: string;
}

export interface DraftSeedInput {
  patientId: string;
  category: string;
  source?: string | null;
  sourceDescription?: string | null;
  nextEligibleDate?: string | null;
}

export interface ApproveDraftInput {
  customerName: string;
  customerEmail?: string | null;
  customerPhone?: string | null;
  items: { description: string; quantity: number; unitAmountCents: number }[];
  noteToCustomer?: string | null;
  deliver?: boolean;
}

const jsonPost = <T>(path: string, body: unknown) =>
  jsonFetch<T>(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

export const listResupplyDrafts = (
  status: DraftStatus = "proposed",
  limit = 200,
) =>
  jsonFetch<{ status: DraftStatus; count: number; drafts: ResupplyDraft[] }>(
    `/admin/therapy-resupply/draft-orders?status=${status}&limit=${limit}`,
  );

export const createResupplyDrafts = (items: DraftSeedInput[]) =>
  jsonPost<{ staged: number; skipped: number }>(
    `/admin/therapy-resupply/draft-orders`,
    { items },
  );

export const dismissResupplyDraft = (id: string, reason?: string) =>
  jsonPost<{ ok: true; id: string }>(
    `/admin/therapy-resupply/draft-orders/${id}/dismiss`,
    reason ? { reason } : {},
  );

export const approveResupplyDraft = (id: string, body: ApproveDraftInput) =>
  jsonPost<{
    ok: true;
    draftId: string;
    orderRequestId: string;
    orderReference: string;
    link: string;
    emailSent: boolean;
    smsSent: boolean;
  }>(`/admin/therapy-resupply/draft-orders/${id}/approve`, body);

/** Build the CSV-export URL the browser can navigate to / download. */
export const resupplyOpportunitiesCsvUrl = (params: {
  dueWithinDays: number;
  limit?: number;
  category?: SupplyCategory;
}): string => {
  const q = new URLSearchParams({
    dueWithinDays: String(params.dueWithinDays),
  });
  if (params.limit) q.set("limit", String(params.limit));
  if (params.category) q.set("category", params.category);
  return `/resupply-api/admin/therapy-resupply/opportunities.csv?${q.toString()}`;
};
