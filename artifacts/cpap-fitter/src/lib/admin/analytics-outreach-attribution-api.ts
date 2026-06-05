// Fetch wrapper for /admin/analytics/outreach-attribution — of the
// patients we contacted (reminders / clinical outreach) in the window,
// the share who placed a resupply order within N days, by channel.
// The route returns camelCase already.

import { ApiError } from "@workspace/api-client-react/admin";

export type AttributionSource =
  | "resupply_reminder"
  | "clinical_outreach"
  | "overall";

export interface AttributionBucket {
  source: AttributionSource;
  label: string;
  contactedPatients: number;
  convertedPatients: number;
  conversionRate: number | null;
}

export interface OutreachAttributionResponse {
  windowDays: number;
  attributionWindowDays: number;
  bySource: AttributionBucket[];
  overall: AttributionBucket;
}

export function outreachAttributionCsvUrl(
  days = 30,
  attributionWindowDays = 14,
): string {
  return `/resupply-api/admin/analytics/outreach-attribution.csv?days=${days}&attributionWindowDays=${attributionWindowDays}`;
}

export async function fetchOutreachAttribution(
  days = 30,
  attributionWindowDays = 14,
): Promise<OutreachAttributionResponse> {
  const url = `/resupply-api/admin/analytics/outreach-attribution?days=${days}&attributionWindowDays=${attributionWindowDays}`;
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
  return (await res.json()) as OutreachAttributionResponse;
}
