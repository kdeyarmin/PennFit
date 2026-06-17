// Client for the global super-admin surfaces:
//   * GET/PUT/DELETE /platform/config   — platform infra credentials
//   * GET            /platform/overview  — cross-tenant fleet snapshot
//
// All gated server-side by requirePlatformAdmin. Mirrors the jsonFetch
// pattern in platform-billing-api.ts (credentials + CSRF header).

import { ApiError } from "@workspace/api-client-react/admin";

import { csrfHeader } from "../csrf";

async function jsonFetch<T>(path: string, init: RequestInit = {}): Promise<T> {
  const { headers, ...rest } = init;
  const method = (init.method ?? "GET").toUpperCase();
  const url = `/resupply-api${path}`;
  const res = await fetch(url, {
    credentials: "include",
    headers: {
      Accept: "application/json",
      ...(init.body ? { "Content-Type": "application/json" } : {}),
      ...csrfHeader(),
      ...(headers ?? {}),
    },
    ...rest,
  });
  if (!res.ok) {
    let data: unknown = null;
    try {
      data = await res.json();
    } catch {}
    throw new ApiError(res, data, { method, url });
  }
  return (await res.json()) as T;
}

// ── Platform config (global infra credentials) ──────────────────────

export interface PlatformConfigSetting {
  key: string;
  label: string;
  description: string;
  category: string;
  secret: boolean;
  applyMode: "live" | "restart";
  placeholder: string | null;
  configured: boolean;
  source: "db" | "env" | "unset";
  envProvided: boolean;
  hint: string | null;
  formatValid: boolean | null;
  formatHint: string | null;
  updatedByEmail: string | null;
  updatedAt: string | null;
}

export interface PlatformConfigCategory {
  category: string;
  settings: PlatformConfigSetting[];
}

export interface PlatformConfigResponse {
  categories: PlatformConfigCategory[];
  overlayDisabled: boolean;
  webhookReference: {
    baseUrl: string | null;
    baseUrlSource: string;
    pendingRestart: boolean;
    endpoints: Array<{
      id: string;
      label: string;
      description: string;
      url: string;
    }>;
  } | null;
}

export function fetchPlatformConfig(): Promise<PlatformConfigResponse> {
  return jsonFetch<PlatformConfigResponse>("/platform/config");
}

export function setPlatformConfig(
  key: string,
  value: string,
): Promise<{ setting: PlatformConfigSetting }> {
  return jsonFetch(`/platform/config/${encodeURIComponent(key)}`, {
    method: "PUT",
    body: JSON.stringify({ value }),
  });
}

export function clearPlatformConfig(
  key: string,
): Promise<{ setting: PlatformConfigSetting; removed: boolean }> {
  return jsonFetch(`/platform/config/${encodeURIComponent(key)}`, {
    method: "DELETE",
  });
}

// ── Fleet overview (cross-tenant aggregates — no PHI) ───────────────

export interface FleetTenant {
  id: string;
  slug: string;
  name: string | null;
  storefrontName: string | null;
  status: string;
  customDomain: string | null;
  customDomainStatus: string | null;
  createdAt: string;
  /** Headline per-tenant counts; a metric is null when its count failed. */
  usage: Record<string, number | null>;
}

export interface FleetOverviewResponse {
  tenants: FleetTenant[];
  generatedAt: string;
}

export function fetchFleetOverview(): Promise<FleetOverviewResponse> {
  return jsonFetch<FleetOverviewResponse>("/platform/overview");
}
