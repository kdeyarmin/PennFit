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

export type WorklistActionStatus =
  | "acknowledged"
  | "snoozed"
  | "contacted"
  | "resolved";

export interface WorklistAction {
  status: WorklistActionStatus;
  snoozeUntil: string | null;
  note: string | null;
  updatedByEmail: string | null;
  updatedAt: string | null;
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
  action: WorklistAction | null;
}

export interface FleetTrendPoint {
  date: string;
  patientsWithData: number;
  compliant: number;
  atRisk: number;
  nonCompliant: number;
  highLeak: number;
  resupplyItemsDue: number;
  setupsInWindow: number;
  setupsAtRisk: number;
}

export const getFleetOverview = (windowDays: number) =>
  jsonFetch<{ windowDays: number; overview: FleetOverview }>(
    `/admin/therapy-fleet/overview?windowDays=${windowDays}`,
  );

export const getFleetTrend = (days: number) =>
  jsonFetch<{ days: number; count: number; points: FleetTrendPoint[] }>(
    `/admin/therapy-fleet/trend?days=${days}`,
  );

export interface FleetAlert {
  id: string;
  patientId: string;
  patientName: string | null;
  alertType: string;
  severity: "high" | "medium" | "low";
  detail: Record<string, number | null>;
  outreachSentAt: string | null;
  createdAt: string;
}

export const getFleetAlerts = () =>
  jsonFetch<{ count: number; alerts: FleetAlert[] }>(
    "/admin/therapy-fleet/alerts",
  );

export const resolveFleetAlert = (id: string) =>
  jsonFetch<{ id: string; status: string }>(
    `/admin/therapy-fleet/alerts/${id}/resolve`,
    { method: "POST" },
  );

export const getFleetWorklist = (params: {
  windowDays: number;
  limit?: number;
  reason?: WorklistReason;
  includeHandled?: boolean;
}) => {
  const q = new URLSearchParams({ windowDays: String(params.windowDays) });
  if (params.limit) q.set("limit", String(params.limit));
  if (params.reason) q.set("reason", params.reason);
  if (params.includeHandled) q.set("includeHandled", "true");
  return jsonFetch<{
    windowDays: number;
    count: number;
    entries: WorklistEntry[];
  }>(`/admin/therapy-fleet/worklist?${q.toString()}`);
};

/** Set a patient's triage state on the worklist. */
export const setWorklistAction = (
  patientId: string,
  body: { action: WorklistActionStatus; snoozeUntil?: string; note?: string },
) =>
  jsonFetch<{ patientId: string; action: WorklistAction }>(
    `/admin/therapy-fleet/worklist/${patientId}/action`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    },
  );

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

// ── Clinical insights report ─────────────────────────────────────────
// The RT-owned smart-trigger signals derived from imported device data,
// reported across the whole patient panel.

export type ClinicalTriggerKind =
  | "pressure_at_max"
  | "ahi_elevated"
  | "non_adherent_30d"
  | "ahi_rising"
  | "usage_erratic";

export interface ClinicalInsightEntry {
  id: string;
  patientId: string;
  patientName: string | null;
  kind: ClinicalTriggerKind;
  severity: "high" | "medium";
  detectedAt: string;
  windowStartDate: string;
  windowEndDate: string;
}

export interface ClinicalInsightReport {
  count: number;
  summary: {
    total: number;
    patients: number;
    byKind: Record<ClinicalTriggerKind, number>;
    bySeverity: { high: number; medium: number };
  };
  entries: ClinicalInsightEntry[];
}

export const getClinicalInsights = (params?: {
  kind?: ClinicalTriggerKind;
  limit?: number;
}) => {
  const q = new URLSearchParams();
  if (params?.kind) q.set("kind", params.kind);
  if (params?.limit) q.set("limit", String(params.limit));
  const qs = q.toString();
  return jsonFetch<ClinicalInsightReport>(
    `/admin/therapy-fleet/clinical-insights${qs ? `?${qs}` : ""}`,
  );
};

/** CSV-export URL for the clinical-insights report. */
export const clinicalInsightsCsvUrl = (params?: {
  kind?: ClinicalTriggerKind;
}): string => {
  const q = new URLSearchParams();
  if (params?.kind) q.set("kind", params.kind);
  const qs = q.toString();
  return `/resupply-api/admin/therapy-fleet/clinical-insights.csv${
    qs ? `?${qs}` : ""
  }`;
};
