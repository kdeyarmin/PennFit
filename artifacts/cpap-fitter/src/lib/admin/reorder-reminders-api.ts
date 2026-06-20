// Hand-rolled fetch wrapper for the reorder-reminder funnel surface.

import { ApiError } from "@workspace/api-client-react/admin";

export type FunnelChannel = "sms" | "email" | "voice";

export interface ChannelStat {
  reminded: number;
  confirmed: number;
  shipped: number;
}

export interface ReorderFunnelResponse {
  windowDays: number;
  due: number;
  reminded: number;
  confirmed: number;
  shipped: number;
  byChannel: Record<FunnelChannel, ChannelStat>;
  rates: {
    remindedOfDue: number | null;
    confirmedOfReminded: number | null;
    shippedOfConfirmed: number | null;
  };
}

async function jsonFetch<T>(path: string): Promise<T> {
  const url = `/resupply-api${path}`;
  const res = await fetch(url, { headers: { Accept: "application/json" } });
  if (!res.ok) {
    let data: unknown = null;
    try {
      data = await res.json();
    } catch {
      // ignore
    }
    throw new ApiError(res, data, { method: "GET", url });
  }
  return (await res.json()) as T;
}

export const fetchReorderFunnel = (days: number) =>
  jsonFetch<ReorderFunnelResponse>(
    `/admin/reorder-reminders/funnel?days=${days}`,
  );
