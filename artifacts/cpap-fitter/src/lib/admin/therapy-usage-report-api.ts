// Hand-rolled fetch wrapper for the provider-facing therapy-usage
// report (GET /admin/reports/therapy-usage). Mirrors analytics-api.ts.

import { ApiError } from "@workspace/api-client-react/admin";

export type TherapyReportGrouping = "patient" | "provider" | "manufacturer";

export interface TherapyUsageGroup {
  key: string;
  label: string;
  sublabel: string | null;
  patientCount: number;
  nightsWithData: number;
  avgUsageHours: number | null;
  avgAhi: number | null;
  avgLeakRateLMin: number | null;
  adherentNightRate: number | null;
  cmsCompliantPatients: number;
  cmsComplianceRate: number | null;
}

export interface TherapyUsageSummary {
  patientCount: number;
  nightsWithData: number;
  avgUsageHours: number | null;
  avgAhi: number | null;
  avgLeakRateLMin: number | null;
  adherentNightRate: number | null;
  cmsCompliantPatients: number;
  cmsComplianceRate: number | null;
}

export interface TherapyUsageReportResponse {
  windowDays: number;
  generatedAt: string;
  grouping: TherapyReportGrouping;
  summary: TherapyUsageSummary;
  groups: TherapyUsageGroup[];
}

async function jsonFetch<T>(path: string): Promise<T> {
  const url = `/resupply-api${path}`;
  const res = await fetch(url, {
    headers: { Accept: "application/json" },
  });
  if (!res.ok) {
    let data: unknown = null;
    try {
      data = await res.json();
    } catch {
      // ignore
    }
    throw new ApiError(res, data, { method: "GET", url });
  }
  return (await res.json()) as T;
}

export const fetchTherapyUsageReport = (
  grouping: TherapyReportGrouping,
  days: number,
) =>
  jsonFetch<TherapyUsageReportResponse>(
    `/admin/reports/therapy-usage?groupBy=${grouping}&days=${days}`,
  );
