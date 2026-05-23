// Hand-rolled fetch wrappers for /admin/integrations/* endpoints.
// Same pattern as today-api.ts.

import { csrfHeader } from "../csrf";

async function jsonFetch<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(`/resupply-api${path}`, {
    credentials: "include",
    headers: { Accept: "application/json", ...csrfHeader(), ...(init.headers ?? {}) },
    ...init,
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
