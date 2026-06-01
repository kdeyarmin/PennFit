// Fetch wrapper for Owner #4 — AR collections forecast. reports.read.

import { ApiError } from "@workspace/api-client-react/admin";

export interface ForecastHorizon {
  label: string;
  withinDays: number;
  expectedCents: number;
  claimCount: number;
}

export interface CollectionsForecast {
  horizons: ForecastHorizon[];
  totalExpectedCents: number;
  outstandingClaimCount: number;
  grossExpectedCents: number;
  assumptions: {
    expectedDaysToPay: number;
    defaultAllowedRatio: number;
    collectionProbability: number;
    asOf: string;
  };
}

export interface ForecastTuning {
  expectedDaysToPay?: number;
  defaultAllowedRatio?: number;
  collectionProbability?: number;
}

export interface OrderBookHorizon {
  label: string;
  withinDays: number;
  dueCount: number;
  expectedCents: number;
}

export interface ForwardOrderBook {
  horizons: OrderBookHorizon[];
  totalExpectedCents: number;
  dueCount: number;
  assumptions: {
    expectedOrderValueCents: number;
    confirmRate: number;
    horizonDays: number;
    asOf: string;
  };
}

export async function getForwardOrderBook(): Promise<ForwardOrderBook> {
  const url = "/resupply-api/admin/billing/forward-order-book";
  const res = await fetch(url, {
    credentials: "include",
    headers: { Accept: "application/json" },
  });
  if (!res.ok) {
    let data: unknown = null;
    try {
      data = await res.json();
    } catch {
      // not json
    }
    throw new ApiError(res, data, { method: "GET", url });
  }
  return (await res.json()) as ForwardOrderBook;
}

export async function getCollectionsForecast(
  tuning: ForecastTuning = {},
): Promise<CollectionsForecast> {
  const params = new URLSearchParams();
  if (tuning.expectedDaysToPay != null)
    params.set("expectedDaysToPay", String(tuning.expectedDaysToPay));
  if (tuning.defaultAllowedRatio != null)
    params.set("defaultAllowedRatio", String(tuning.defaultAllowedRatio));
  if (tuning.collectionProbability != null)
    params.set("collectionProbability", String(tuning.collectionProbability));
  const qs = params.toString();
  const url = `/resupply-api/admin/billing/collections-forecast${
    qs ? `?${qs}` : ""
  }`;
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
  return (await res.json()) as CollectionsForecast;
}
