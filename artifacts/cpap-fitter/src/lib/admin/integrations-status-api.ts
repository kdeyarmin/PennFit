// Hand-rolled fetch wrappers for /admin/integrations/* endpoints.
// Same pattern as today-api.ts.

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

export type IntegrationSource =
  | "resmed_airview"
  | "philips_care"
  | "health_connect"
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
