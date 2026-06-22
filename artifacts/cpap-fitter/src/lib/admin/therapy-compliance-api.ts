// Hand-rolled fetch wrappers for /admin/therapy-compliance/* endpoints.
// Same pattern as therapy-fleet-api.ts.

import { adminJsonFetch as jsonFetch } from "../admin-json-fetch";

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
