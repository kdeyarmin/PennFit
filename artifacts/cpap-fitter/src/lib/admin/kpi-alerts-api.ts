// Fetch wrappers for the F2 KPI alerting surface (Owner #5):
//   * /admin/metric-alerts        — the triage feed (read + ack/resolve)
//   * /admin/metric-thresholds    — the alert-rule config CRUD
// Both routes return camelCase.

import { adminJsonFetch } from "../admin-json-fetch";

// Call sites pass paths under /admin (e.g. "/metric-alerts");
// adminJsonFetch adds the /resupply-api mount.
const jsonFetch = <T>(path: string, init?: RequestInit): Promise<T> =>
  adminJsonFetch<T>(`/admin${path}`, init);

// ── Alerts feed ────────────────────────────────────────────────────
export type AlertStatus = "open" | "acknowledged" | "resolved";
export type AlertStatusFilter = AlertStatus | "all";
export type Severity = "info" | "warning" | "critical";

export interface MetricAlert {
  id: string;
  thresholdId: string | null;
  metricKey: string;
  metricDate: string;
  observedValue: number | null;
  comparedValue: number | null;
  baselineValue: number | null;
  severity: Severity;
  message: string;
  status: AlertStatus;
  notifiedAt: string | null;
  createdAt: string;
}

export function listMetricAlerts(
  status?: AlertStatusFilter,
): Promise<{ alerts: MetricAlert[] }> {
  const qs = status ? `?status=${status}` : "";
  return jsonFetch<{ alerts: MetricAlert[] }>(`/metric-alerts${qs}`);
}

export function updateMetricAlert(
  id: string,
  status: AlertStatus,
): Promise<{ id: string; status: AlertStatus }> {
  return jsonFetch(`/metric-alerts/${encodeURIComponent(id)}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ status }),
  });
}

// ── Threshold rules ────────────────────────────────────────────────
export type Comparison = "gt" | "gte" | "lt" | "lte";
export type ThresholdMode = "absolute" | "delta_7d" | "delta_pct_7d";

export interface MetricThreshold {
  id: string;
  metricKey: string;
  comparison: Comparison;
  thresholdValue: number;
  mode: ThresholdMode;
  severity: Severity;
  enabled: boolean;
  description: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CreateThresholdBody {
  metricKey: string;
  comparison: Comparison;
  thresholdValue: number;
  mode?: ThresholdMode;
  severity?: Severity;
  description?: string | null;
  enabled?: boolean;
}

export function listMetricThresholds(): Promise<{
  thresholds: MetricThreshold[];
}> {
  return jsonFetch<{ thresholds: MetricThreshold[] }>("/metric-thresholds");
}

export function createMetricThreshold(
  body: CreateThresholdBody,
): Promise<MetricThreshold> {
  return jsonFetch<MetricThreshold>("/metric-thresholds", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

export function patchMetricThreshold(
  id: string,
  body: Partial<CreateThresholdBody>,
): Promise<MetricThreshold> {
  return jsonFetch<MetricThreshold>(
    `/metric-thresholds/${encodeURIComponent(id)}`,
    {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    },
  );
}

export function deleteMetricThreshold(
  id: string,
): Promise<{ ok: boolean; deletedId: string }> {
  return jsonFetch(`/metric-thresholds/${encodeURIComponent(id)}`, {
    method: "DELETE",
  });
}
