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
