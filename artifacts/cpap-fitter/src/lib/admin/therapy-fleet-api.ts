// Hand-rolled fetch wrappers for /admin/therapy-fleet/* endpoints.
// Same pattern as integrations-status-api.ts.

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

export type WorklistReason =
  | "compliance_risk"
  | "no_recent_data"
  | "high_ahi"
  | "high_leak"
  | "usage_decline";

export interface FleetOverview {
  patientsWithData: number;
  cohorts: {
    compliant: number;
    atRisk: number;
    nonCompliant: number;
    noRecentData: number;
  };
  clinicalFlags: {
    highAhi: number;
    highLeak: number;
    lowUsage: number;
  };
  averages: {
    usageMinutes: number | null;
    ahi: number | null;
    leakLMin: number | null;
  };
  totalNights: number;
}

export interface WorklistEntry {
  patientId: string;
  patientName: string | null;
  nightsWithData: number;
  nightsOver4h: number;
  avgUsageMinutes: number | null;
  avgAhi: number | null;
  avgLeakLMin: number | null;
  priorAvgUsageMinutes: number | null;
  lastNightDate: string | null;
  daysSinceLastNight: number | null;
  reasons: WorklistReason[];
  priority: number;
}

export const getFleetOverview = (windowDays: number) =>
  jsonFetch<{ windowDays: number; overview: FleetOverview }>(
    `/admin/therapy-fleet/overview?windowDays=${windowDays}`,
  );

export const getFleetWorklist = (params: {
  windowDays: number;
  limit?: number;
  reason?: WorklistReason;
}) => {
  const q = new URLSearchParams({ windowDays: String(params.windowDays) });
  if (params.limit) q.set("limit", String(params.limit));
  if (params.reason) q.set("reason", params.reason);
  return jsonFetch<{
    windowDays: number;
    count: number;
    entries: WorklistEntry[];
  }>(`/admin/therapy-fleet/worklist?${q.toString()}`);
};

/** Build the CSV-export URL the browser can navigate to / download. */
export const fleetWorklistCsvUrl = (params: {
  windowDays: number;
  limit?: number;
  reason?: WorklistReason;
}): string => {
  const q = new URLSearchParams({ windowDays: String(params.windowDays) });
  if (params.limit) q.set("limit", String(params.limit));
  if (params.reason) q.set("reason", params.reason);
  return `/resupply-api/admin/therapy-fleet/worklist.csv?${q.toString()}`;
};
