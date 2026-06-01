// Fetch wrapper for /admin/analytics/margin (Owner #1 — gross-margin /
// COGS dashboard). The route returns camelCase already.

import { ApiError } from "@workspace/api-client-react/admin";

export interface MarginAggregate {
  lineCount: number;
  revenueCents: number;
  costedRevenueCents: number;
  uncostedRevenueCents: number;
  costCents: number;
  marginCents: number;
  /** margin / costed revenue, or null when there's no costed revenue. */
  marginRatio: number | null;
  linesWithKnownCost: number;
  linesWithUnknownCost: number;
}

export interface ProductMargin extends MarginAggregate {
  productId: string;
  productName: string | null;
}

export interface MarginResponse {
  windowDays: number;
  overall: MarginAggregate;
  byProduct: ProductMargin[];
  generatedAt: string;
}

export async function fetchMarginReport(days = 30): Promise<MarginResponse> {
  const url = `/resupply-api/admin/analytics/margin?days=${days}`;
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
  return (await res.json()) as MarginResponse;
}
