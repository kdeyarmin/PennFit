// Hand-rolled fetch wrapper for the reorder-reminder funnel surface.

import { adminJsonFetch as jsonFetch } from "../admin-json-fetch";

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

export const fetchReorderFunnel = (days: number) =>
  jsonFetch<ReorderFunnelResponse>(
    `/admin/reorder-reminders/funnel?days=${days}`,
  );
