// Client for the platform super-admin analytics dashboard:
//   GET /platform/analytics?days=30
//
// Gated server-side by requirePlatformAdmin. Mirrors the jsonFetch
// pattern in platform-config-api.ts (credentials + CSRF header). Returns
// aggregate counts + dollar rollups only — no PHI ever crosses this
// surface (see the route's PII note).

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

export interface PlatformAnalyticsTenantRow {
  id: string;
  slug: string;
  name: string | null;
  status: string;
  createdAt: string;
  /** All-time headline counts; null when the count failed. */
  patients: number | null;
  orders: number | null;
  conversations: number | null;
  windowNewPatients: number;
  windowOrders: number;
  windowGmvCents: number;
}

export interface PlatformAnalyticsResponse {
  windowDays: number;
  generatedAt: string;
  /** Ordered UTC `YYYY-MM-DD` labels for the trend series. */
  dayKeys: string[];
  totals: {
    tenants: {
      total: number;
      active: number;
      suspended: number;
      archived: number;
    };
    patients: number | null;
    orders: number | null;
    conversations: number | null;
  };
  window: {
    newTenants: number;
    newPatients: number;
    newOrders: number;
    newConversations: number;
    gmvCents: number;
    /** Percent change vs the immediately-preceding equal window; null when
     *  the prior window had no baseline. */
    delta: {
      newPatients: number | null;
      newOrders: number | null;
      newConversations: number | null;
      gmvCents: number | null;
    };
  };
  series: {
    newTenants: number[];
    newPatients: number[];
    newOrders: number[];
    newConversations: number[];
    gmvCents: number[];
  };
  tenants: PlatformAnalyticsTenantRow[];
}

export function fetchPlatformAnalytics(
  days: number,
): Promise<PlatformAnalyticsResponse> {
  return jsonFetch<PlatformAnalyticsResponse>(
    `/platform/analytics?days=${encodeURIComponent(String(days))}`,
  );
}
