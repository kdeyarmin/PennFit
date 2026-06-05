// Fetch wrapper for /admin/analytics/revenue-by-source — order volume +
// cash revenue split across the storefront / resupply-fulfillment /
// clinical-form channels. The route returns camelCase already.

import { ApiError } from "@workspace/api-client-react/admin";

export type RevenueSource =
  | "storefront"
  | "resupply_fulfillment"
  | "clinical_form";

export interface RevenueSourceBucket {
  source: RevenueSource;
  label: string;
  orders: number;
  units: number | null;
  paidOrders: number | null;
  cashRevenueCents: number | null;
}

export interface RevenueBySourceResponse {
  windowDays: number;
  bySource: RevenueSourceBucket[];
  totalOrders: number;
  totalCashRevenueCents: number;
}

export function revenueBySourceCsvUrl(days = 30): string {
  return `/resupply-api/admin/analytics/revenue-by-source.csv?days=${days}`;
}

export async function fetchRevenueBySource(
  days = 30,
): Promise<RevenueBySourceResponse> {
  const url = `/resupply-api/admin/analytics/revenue-by-source?days=${days}`;
  const res = await fetch(url, {
    credentials: "include",
    headers: { Accept: "application/json" },
  });
  if (!res.ok) {
    let data: unknown = null;
    try {
      data = await res.json();
    } catch {
      // body not JSON
    }
    throw new ApiError(res, data, { method: "GET", url });
  }
  return (await res.json()) as RevenueBySourceResponse;
}
