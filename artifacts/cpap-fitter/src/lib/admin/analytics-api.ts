// Hand-rolled fetch wrapper for the clinical analytics surface.

import { ApiError } from "@workspace/api-client-react/admin";

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

export interface ResupplyKpisResponse {
  windowDays: number;
  totalEpisodes: number;
  confirmedOrders: number;
  fulfilledOrders: number;
  uniquePatientsServed: number;
  outreachCount: number;
  respondedCount: number;
  activePatientCount: number;
  confirmationRate: number | null;
  fulfillmentRate: number | null;
  connectionRate: number | null;
  ordersPerActivePatientAnnualized: number | null;
  fulfillmentLineItems: number;
  ordersWithFulfillments: number;
  itemsPerOrder: number | null;
  paidOrderCount: number;
  averageOrderValueCents: number | null;
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
  /** When true, per-operator productivity is no longer tracked (the
   *  audit_log source was retired). UI surfaces this as a clear
   *  "no longer tracked" notice instead of an empty table. */
  unavailable?: boolean;
}

export interface RetentionCohortBucket {
  cohort: string; // YYYY-MM of first fulfilled episode
  size: number;
  repeat: number;
  repeatRate: number | null;
}

export interface PatientRetentionResponse {
  lookbackDays: number;
  activeDays: number;
  reorderDays: number;
  patientsServed: number;
  repeatPatients: number;
  reorderEligible: number;
  repeatRate: number | null;
  activePatients: number;
  lapsedPatients: number;
  activeRate: number | null;
  byCohort: RetentionCohortBucket[];
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

export const fetchResupplyFunnel = (days: number) =>
  jsonFetch<ResupplyFunnelResponse>(
    `/admin/analytics/resupply-funnel?days=${days}`,
  );

export const fetchResupplyKpis = (days: number) =>
  jsonFetch<ResupplyKpisResponse>(
    `/admin/analytics/resupply-kpis?days=${days}`,
  );

export const fetchComplianceCohorts = (days: number) =>
  jsonFetch<ComplianceCohortsResponse>(
    `/admin/analytics/compliance-cohorts?days=${days}`,
  );

export const fetchCsrProductivity = (days: number) =>
  jsonFetch<CsrProductivityResponse>(
    `/admin/analytics/csr-productivity?days=${days}`,
  );

export const fetchPatientRetention = (lookbackDays: number) =>
  jsonFetch<PatientRetentionResponse>(
    `/admin/analytics/patient-retention?lookbackDays=${lookbackDays}`,
  );

export type StuckEpisodeStage =
  | "outreach_pending"
  | "awaiting_response"
  | "confirmed";

export interface StuckEpisode {
  id: string;
  patientId: string;
  patientName: string | null;
  insurancePayer: string | null;
  status: StuckEpisodeStage;
  createdAt: string;
  dueAt: string | null;
  expiresAt: string | null;
  prescriptionId: string | null;
  ageDays: number;
}

export interface StuckEpisodesResponse {
  stage: StuckEpisodeStage;
  count: number;
  episodes: StuckEpisode[];
}

export const fetchStuckEpisodes = (stage: StuckEpisodeStage, limit = 25) =>
  jsonFetch<StuckEpisodesResponse>(
    `/admin/analytics/episodes-stuck?stage=${stage}&limit=${limit}`,
  );

export const resupplyFunnelCsvUrl = (days: number) =>
  `/resupply-api/admin/analytics/resupply-funnel.csv?days=${days}`;

export const complianceCohortsCsvUrl = (days: number) =>
  `/resupply-api/admin/analytics/compliance-cohorts.csv?days=${days}`;
