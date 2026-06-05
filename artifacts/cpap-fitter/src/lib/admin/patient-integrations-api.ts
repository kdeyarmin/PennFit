// Hand-rolled fetch wrappers for /admin/patients/:id/integrations.
// Mirrors the patient-followups-api.ts pattern: stable error
// envelope, no implicit retries, throws on non-OK so React Query
// surfaces failure states naturally.

import { ApiError } from "@workspace/api-client-react/admin";

import { csrfHeader } from "../csrf";

export type IntegrationSource =
  | "resmed_airview"
  | "philips_care"
  | "react_health";

export type AdapterAvailability =
  | { status: "configured" }
  | { status: "stub"; reason: "no_credentials" | "stub_mode" }
  | { status: "unavailable"; reason: string };

export interface DeviceSettings {
  deviceModel: string | null;
  deviceSerial: string | null;
  therapyMode: string | null;
  pressureMinCmh2o: number | null;
  pressureMaxCmh2o: number | null;
  rampMinutes: number | null;
  humidifierLevel: number | null;
  maskType: string | null;
}

export interface ComplianceSummary {
  windowDays: number;
  daysWithData: number;
  daysOver4Hours: number;
  averageUsageMinutes: number | null;
  averageAhi: number | null;
  meetsCmsCompliance: boolean;
}

export interface TherapyNight {
  nightDate: string;
  usageMinutes: number | null;
  ahi: number | null;
  leakRateLMin: number | null;
  pressureP95Cmh2o: number | null;
}

export type SupplyCategory =
  | "mask"
  | "cushion"
  | "headgear"
  | "tubing"
  | "filter"
  | "humidifier_chamber"
  | "other";

export interface SupplyItem {
  category: SupplyCategory;
  description: string;
  lastReplacedDate: string | null;
  nextEligibleDate: string | null;
}

export interface IntegrationSnapshotPayload {
  source: IntegrationSource;
  partnerPatientId: string;
  settings: DeviceSettings | null;
  compliance: ComplianceSummary | null;
  recentNights: TherapyNight[];
  supplies: SupplyItem[];
}

export interface IntegrationLink {
  id: string;
  partnerPatientId: string;
  deviceSerial: string | null;
  status: string;
  lastSyncedAt: string | null;
  lastSyncStatus: string | null;
  lastSyncError: string | null;
}

export interface IntegrationSnapshot {
  id: string;
  payload: IntegrationSnapshotPayload;
  fetchStatus: string;
  fetchError: string | null;
  fetchedAt: string;
}

export interface IntegrationSourceView {
  source: IntegrationSource;
  availability: AdapterAvailability;
  link: IntegrationLink | null;
  snapshot: IntegrationSnapshot | null;
}

export interface PatientIntegrationsResponse {
  patientId: string;
  sources: IntegrationSourceView[];
}

export class PatientIntegrationsNotFoundError extends Error {
  constructor() {
    super("Patient not found.");
  }
}

export async function listPatientIntegrations(
  patientId: string,
): Promise<PatientIntegrationsResponse> {
  const res = await fetch(
    `/resupply-api/admin/patients/${encodeURIComponent(patientId)}/integrations`,
    { headers: { Accept: "application/json" } },
  );
  if (res.status === 404) {
    throw new PatientIntegrationsNotFoundError();
  }
  if (!res.ok) {
    let data: unknown = null;
    try {
      data = await res.json();
    } catch {
      // non-JSON error body — status alone is enough
    }
    throw new ApiError(res, data, { method: "GET", url: res.url });
  }
  return (await res.json()) as PatientIntegrationsResponse;
}

export interface RefreshPatientIntegrationResult {
  snapshot: IntegrationSnapshot | null;
  fetchError: string | null;
}

export async function refreshPatientIntegration(
  patientId: string,
  source: IntegrationSource,
): Promise<RefreshPatientIntegrationResult> {
  const res = await fetch(
    `/resupply-api/admin/patients/${encodeURIComponent(patientId)}/integrations/refresh`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        ...csrfHeader(),
      },
      body: JSON.stringify({ source }),
    },
  );
  if (res.status === 404) {
    throw new PatientIntegrationsNotFoundError();
  }
  if (res.status === 409) {
    const body = (await res.json().catch(() => ({}))) as {
      message?: string;
    };
    throw new ApiError(
      res,
      body.message ? body : { message: "No active link for this source." },
      {
        method: "POST",
        url: res.url,
      },
    );
  }
  // 502 still returns a body with the cached snapshot — surface the
  // error to the UI but preserve the snapshot.
  if (res.status === 502) {
    const body = (await res.json().catch(() => ({}))) as {
      snapshot?: IntegrationSnapshot;
      fetchError?: string;
    };
    return {
      snapshot: body.snapshot ?? null,
      fetchError: body.fetchError ?? "fetch_failed",
    };
  }
  if (!res.ok) {
    let data: unknown = null;
    try {
      data = await res.json();
    } catch {
      // non-JSON error body — status alone is enough
    }
    throw new ApiError(res, data, { method: "POST", url: res.url });
  }
  const body = (await res.json()) as { snapshot: IntegrationSnapshot };
  return { snapshot: body.snapshot, fetchError: null };
}

export function formatSourceLabel(source: IntegrationSource): string {
  switch (source) {
    case "resmed_airview":
      return "ResMed AirView";
    case "philips_care":
      return "Care Orchestrator";
    case "react_health":
      return "React Health";
  }
}
