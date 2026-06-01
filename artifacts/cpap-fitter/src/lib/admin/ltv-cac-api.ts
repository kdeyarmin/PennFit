// Fetch wrappers for /admin/analytics/ltv-cac + the per-customer
// acquisition upsert (Owner #3). The route returns camelCase.

import { ApiError } from "@workspace/api-client-react/admin";

import { csrfHeader } from "../csrf";

export type AcquisitionChannel =
  | "organic"
  | "paid_search"
  | "paid_social"
  | "referral"
  | "fitter"
  | "insurance_lead"
  | "partner"
  | "other";

export interface ChannelEconomics {
  channel: AcquisitionChannel | "unattributed";
  customerCount: number;
  totalRevenueCents: number;
  avgLtvCents: number;
  customersWithCost: number;
  knownAcquisitionCostCents: number;
  avgCacCents: number | null;
  ltvToCacRatio: number | null;
}

export interface LtvCacResponse {
  byChannel: ChannelEconomics[];
  totals: {
    customerCount: number;
    totalRevenueCents: number;
    avgLtvCents: number;
    customersWithCost: number;
    knownAcquisitionCostCents: number;
    avgCacCents: number | null;
    ltvToCacRatio: number | null;
  };
  generatedAt: string;
}

export async function fetchLtvCac(): Promise<LtvCacResponse> {
  const url = "/resupply-api/admin/analytics/ltv-cac";
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
  return (await res.json()) as LtvCacResponse;
}

export async function recordAcquisition(
  customerId: string,
  body: {
    channel: AcquisitionChannel;
    acquisitionCostCents?: number | null;
    sourceDetail?: string | null;
  },
): Promise<{ customerId: string; channel: string }> {
  const url = `/resupply-api/admin/customers/${encodeURIComponent(customerId)}/acquisition`;
  const res = await fetch(url, {
    method: "PUT",
    credentials: "include",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      ...csrfHeader(),
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    let data: unknown = null;
    try {
      data = await res.json();
    } catch {
      // body not JSON
    }
    throw new ApiError(res, data, { method: "PUT", url });
  }
  return (await res.json()) as { customerId: string; channel: string };
}
