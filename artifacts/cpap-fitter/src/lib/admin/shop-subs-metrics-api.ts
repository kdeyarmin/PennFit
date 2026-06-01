// Hand-rolled fetch wrapper for the subscription metrics endpoint.

import { ApiError } from "@workspace/api-client-react/admin";

export interface SubsMetrics {
  counters: {
    activeNow: number;
    pausedNow: number;
    pastDueNow: number;
    canceledLifetime: number;
    newSubsLast30d: number;
    newSubsLast90d: number;
    canceledLast30d: number;
    canceledLast90d: number;
    pendingCancellations: number;
  } | null;
  churnRate30d: number;
  cohort: Array<{
    cohortMonth: string;
    totalCreated: number;
    stillLive: number;
  }>;
}

export async function fetchSubsMetrics(): Promise<SubsMetrics> {
  const url = "/resupply-api/admin/shop/subscriptions/metrics";
  const res = await fetch(url, {
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
  return (await res.json()) as SubsMetrics;
}
