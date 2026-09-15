import type { OwnerAnalyticsResponse } from "@workspace/api-client-react/admin";
import { adminJsonFetch } from "../admin-json-fetch";

export type { OwnerAnalyticsResponse };
export type OwnerAnalyticsPeriod =
  | { days: 7 | 30 | 90 | 365 }
  | { from: string; to: string };

export function fetchOwnerAnalytics(
  period: OwnerAnalyticsPeriod,
  signal?: AbortSignal,
): Promise<OwnerAnalyticsResponse> {
  const query = new URLSearchParams(
    "days" in period
      ? { days: String(period.days) }
      : { from: period.from, to: period.to },
  );
  return adminJsonFetch(`/admin/analytics/owner?${query}`, { signal });
}
