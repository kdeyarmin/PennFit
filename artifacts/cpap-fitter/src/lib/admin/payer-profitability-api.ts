// Fetch wrapper for /admin/billing/payer-profitability (Owner #2). The
// route returns camelCase already.

import { ApiError } from "@workspace/api-client-react/admin";

export interface PayerProfitability {
  payerKey: string;
  payerName: string | null;
  claimCount: number;
  deniedCount: number;
  denialRate: number | null;
  billedCents: number;
  allowedCents: number;
  paidCents: number;
  collectionRate: number | null;
  allowedRate: number | null;
  costKnownCents: number;
  claimsWithCost: number;
  claimsWithoutCost: number;
  netCents: number;
  netYieldRatio: number | null;
}

export interface PayerProfitabilityResponse {
  windowDays: number;
  payers: PayerProfitability[];
  totals: {
    claimCount: number;
    billedCents: number;
    allowedCents: number;
    paidCents: number;
    costKnownCents: number;
    netCents: number;
    claimsWithCost: number;
    claimsWithoutCost: number;
  };
  generatedAt: string;
}

export async function fetchPayerProfitability(
  days = 180,
): Promise<PayerProfitabilityResponse> {
  const url = `/resupply-api/admin/billing/payer-profitability?days=${days}`;
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
  return (await res.json()) as PayerProfitabilityResponse;
}
