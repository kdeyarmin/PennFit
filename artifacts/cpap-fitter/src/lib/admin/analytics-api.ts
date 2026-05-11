// Hand-rolled fetch wrapper for the clinical analytics surface.

export type EpisodeFunnelStage =
  | "outreach_pending"
  | "awaiting_response"
  | "confirmed"
  | "fulfilled";

export type EpisodeDropOutStatus = "declined" | "expired" | "canceled";

export interface ResupplyFunnelResponse {
  windowDays: number;
  total: number;
  byStage: Record<EpisodeFunnelStage, number>;
  dropOuts: Record<EpisodeDropOutStatus, number>;
  fulfillmentRate: number | null;
}

export interface ComplianceCohortBucket {
  cohort: string;
  total: number;
  qualifying: number;
  rate: number | null;
}

export interface ComplianceCohortsResponse {
  windowDays: number;
  compliantMinutesPerNight: number;
  adherenceWindowDays: number;
  byMonth: ComplianceCohortBucket[];
  byPayer: Array<{
    payer: string;
    total: number;
    qualifying: number;
    rate: number | null;
  }>;
}

export interface CsrProductivityRow {
  operator: string;
  total: number;
  byAction: Record<string, number>;
  lastActiveDate: string | null;
}

export interface CsrProductivityResponse {
  windowDays: number;
  rows: CsrProductivityRow[];
  totalActions: number;
}

async function jsonFetch<T>(path: string): Promise<T> {
  const res = await fetch(`/resupply-api${path}`, {
    headers: { Accept: "application/json" },
  });
  if (!res.ok) {
    let message = `${res.status} ${res.statusText}`;
    try {
      const body = (await res.json()) as { message?: string; error?: string };
      message = body.message ?? body.error ?? message;
    } catch {
      // ignore
    }
    throw new Error(message);
  }
  return (await res.json()) as T;
}

export const fetchResupplyFunnel = (days: number) =>
  jsonFetch<ResupplyFunnelResponse>(
    `/admin/analytics/resupply-funnel?days=${days}`,
  );

export const fetchComplianceCohorts = (days: number) =>
  jsonFetch<ComplianceCohortsResponse>(
    `/admin/analytics/compliance-cohorts?days=${days}`,
  );

export const fetchCsrProductivity = (days: number) =>
  jsonFetch<CsrProductivityResponse>(
    `/admin/analytics/csr-productivity?days=${days}`,
  );
