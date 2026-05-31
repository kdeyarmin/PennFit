// Hand-rolled fetch wrappers for /admin/therapy-compliance/* endpoints.
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

export type SetupAdherenceStatus = "qualified" | "on_track" | "at_risk";

export interface SetupAdherenceSummary {
  patientsInWindow: number;
  qualified: number;
  onTrack: number;
  atRisk: number;
}

export interface SetupEntry {
  patientId: string;
  patientName: string | null;
  firstNightDate: string | null;
  daysElapsed: number;
  daysRemaining: number;
  nightsInWindow: number;
  nightsOver4h: number;
  best30dayCount: number;
  nightsNeeded: number;
  status: SetupAdherenceStatus;
}

export const getSetupAdherenceSummary = () =>
  jsonFetch<{ summary: SetupAdherenceSummary }>(
    "/admin/therapy-compliance/summary",
  );

export const getSetupAdherence = (params: {
  limit?: number;
  status?: SetupAdherenceStatus;
}) => {
  const q = new URLSearchParams();
  if (params.limit) q.set("limit", String(params.limit));
  if (params.status) q.set("status", params.status);
  const qs = q.toString();
  return jsonFetch<{ count: number; setups: SetupEntry[] }>(
    `/admin/therapy-compliance/setups${qs ? `?${qs}` : ""}`,
  );
};

/** Build the CSV-export URL the browser can navigate to / download. */
export const setupAdherenceCsvUrl = (params: {
  status?: SetupAdherenceStatus;
}): string => {
  const q = new URLSearchParams();
  if (params.status) q.set("status", params.status);
  const qs = q.toString();
  return `/resupply-api/admin/therapy-compliance/setups.csv${qs ? `?${qs}` : ""}`;
};
