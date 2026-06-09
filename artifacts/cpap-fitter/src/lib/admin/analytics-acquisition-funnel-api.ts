// Fetch wrapper for /admin/analytics/acquisition-funnel — storefront/
// fitter funnel drop-off from the anonymous usage_events stream
// (Growth #G1). The route returns camelCase already.

import { ApiError } from "@workspace/api-client-react/admin";

export interface FunnelStage {
  step: string;
  label: string;
  sessions: number;
  events: number;
  conversionFromPrev: number | null;
  conversionFromTop: number | null;
}

export interface FunnelSummary {
  stages: FunnelStage[];
  topSessions: number;
  overallConversion: number | null;
}

export interface FunnelSignal {
  step: string;
  label: string;
  events: number;
}

export interface AcquisitionFunnelResponse {
  window: { from: string; to: string; days: number };
  fitter: FunnelSummary;
  checkout: FunnelSummary;
  signals: FunnelSignal[];
}

export async function fetchAcquisitionFunnel(
  days = 30,
): Promise<AcquisitionFunnelResponse> {
  const url = `/resupply-api/admin/analytics/acquisition-funnel?days=${days}`;
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
  return (await res.json()) as AcquisitionFunnelResponse;
}
