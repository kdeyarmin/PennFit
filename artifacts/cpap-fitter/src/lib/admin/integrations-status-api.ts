// Hand-rolled fetch wrappers for /admin/integrations/* endpoints.
// Same pattern as today-api.ts.

import { adminJsonFetch as jsonFetch } from "../admin-json-fetch";

export type IntegrationSource =
  | "resmed_airview"
  | "philips_care"
  | "react_health";

export type AdapterAvailability =
  | { status: "configured" }
  | { status: "stub"; reason: "no_credentials" | "stub_mode" }
  | { status: "unavailable"; reason: string };

export interface IntegrationAdapterStatus {
  source: IntegrationSource;
  availability: AdapterAvailability;
  recentSnapshots: { ok: number; error: number };
  errorSamples: Array<{ error: string; count: number }>;
  lastFetchedAt: string | null;
}

export const getIntegrationsStatus = () =>
  jsonFetch<{
    adapters: IntegrationAdapterStatus[];
    lookbackDays: number;
  }>("/admin/integrations/status");

export const triggerNightlySync = () =>
  jsonFetch<{
    scanned: number;
    refreshed: number;
    failed: number;
    nightsPersisted: number;
  }>("/admin/integrations/nightly-sync", {
    method: "POST",
  });

// ---------------------------------------------------------------------------
// Connection validation.
//
// Until this existed, the first REAL call to a vendor happened inside the
// nightly sync at 04:30 across every linked patient — where a wrong
// endpoint shape is indistinguishable from "the vendor has no data for
// these patients". This makes that first call deliberate and small.
// ---------------------------------------------------------------------------

export type ValidationStepName =
  | "configured"
  | "authenticated"
  | "fetched"
  | "schema";

export interface ValidationStep {
  name: ValidationStepName;
  status: "pass" | "fail" | "skipped";
  detail: string;
}

export interface ValidateConnectionResult {
  source: IntegrationSource;
  ok: boolean;
  steps: ValidationStep[];
  received?: {
    settings: boolean;
    compliance: boolean;
    recentNights: number;
    supplies: number;
  };
}

export const validateIntegrationConnection = (
  source: IntegrationSource,
  partnerPatientId: string,
) =>
  jsonFetch<ValidateConnectionResult>(
    `/admin/integrations/${source}/validate`,
    { method: "POST", body: JSON.stringify({ partnerPatientId }) },
  );

// ---------------------------------------------------------------------------
// Portal reconciliation — the only check we have that is not a check
// against ourselves.
// ---------------------------------------------------------------------------

export interface PortalRow {
  partnerPatientId: string;
  deviceSerial?: string | null;
  nightsWithUsage?: number | null;
  avgUsageMinutes?: number | null;
}

export type DiscrepancyKind =
  | "missing_locally"
  | "missing_in_portal"
  | "device_serial_mismatch"
  | "night_count_mismatch"
  | "usage_mismatch";

/** Whether the night-count / usage comparison actually ran. A report that
 *  skipped it and one that ran it and found nothing look identical
 *  otherwise, and the first is what this route used to always do. */
export type TherapyComparison =
  | "not_requested"
  | "skipped_no_window"
  | "unavailable"
  | "compared";

export interface ReconcileResult {
  runId: string | null;
  therapyComparison: TherapyComparison;
  source: IntegrationSource;
  portalRows: number;
  localRows: number;
  matchedCount: number;
  missingLocallyCount: number;
  missingInPortalCount: number;
  mismatchedCount: number;
  discrepancies: Record<
    DiscrepancyKind,
    {
      count: number;
      sample: Array<{
        kind: DiscrepancyKind;
        partnerPatientId: string;
        portal?: string;
        local?: string;
      }>;
    }
  >;
}

export const reconcileIntegration = (
  source: IntegrationSource,
  rows: PortalRow[],
  /** The dates the export covers. Required for the night/usage
   *  comparison: our rolling history and the portal's export only mean
   *  the same thing over the same window. */
  window?: { start: string; end: string },
) =>
  jsonFetch<ReconcileResult>(`/admin/integrations/${source}/reconcile`, {
    method: "POST",
    body: JSON.stringify({
      rows,
      ...(window ? { windowStart: window.start, windowEnd: window.end } : {}),
    }),
  });

export interface ReconciliationRun {
  id: string;
  source: IntegrationSource;
  status: string;
  portal_rows: number;
  local_rows: number;
  matched_count: number;
  missing_locally_count: number;
  missing_in_portal_count: number;
  mismatched_count: number;
  created_at: string;
  run_by_email: string | null;
}

export const getReconciliationRuns = () =>
  jsonFetch<{ runs: ReconciliationRun[] }>(
    "/admin/integrations/reconciliation-runs",
  );

// ---------------------------------------------------------------------------
// Error triage. The route has existed for a while with no page behind it,
// so recent failures were only visible in the logs.
// ---------------------------------------------------------------------------

export interface IntegrationErrorRow {
  id: string;
  source: IntegrationSource;
  partnerPatientId: string | null;
  fetchError: string | null;
  fetchedAt: string | null;
}

export const getIntegrationErrors = () =>
  jsonFetch<{ errors: IntegrationErrorRow[] }>("/admin/integrations/errors");
