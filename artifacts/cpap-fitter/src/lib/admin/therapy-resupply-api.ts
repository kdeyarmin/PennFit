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
