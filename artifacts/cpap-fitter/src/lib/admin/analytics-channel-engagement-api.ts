// Fetch wrapper for /admin/analytics/channel-engagement — the
// cross-channel scoreboard for the automated outreach system (SMS /
// email / chat replies + phone answered/missed) paired with the
// purchases it drives. Cookie-authenticated, read-only. The route
// returns camelCase already.

import { ApiError } from "@workspace/api-client-react/admin";

export type MessagingChannel = "sms" | "email" | "chat";

export interface MessagingChannelStats {
  channel: MessagingChannel;
  label: string;
  conversations: number;
  outbound: number;
  inbound: number;
  replyRate: number | null;
  delivered: number;
  failed: number;
  deliveryRate: number | null;
}

export interface VoiceChannelStats {
  totalCalls: number;
  inboundCalls: number;
  outboundCalls: number;
  answeredCalls: number;
  answerRate: number | null;
  missedCalls: number;
  avgDurationSeconds: number | null;
  byStatus: Record<string, number>;
}

export interface ChannelEngagementOutcomes {
  purchases: number;
  purchaseRevenueCents: number;
}

export interface ChannelEngagementSummary {
  totalOutbound: number;
  totalInbound: number;
  totalReplies: number;
  overallEngagementRate: number | null;
}

export interface ChannelEngagementResponse {
  windowDays: number;
  messaging: MessagingChannelStats[];
  voice: VoiceChannelStats;
  outcomes: ChannelEngagementOutcomes;
  summary: ChannelEngagementSummary;
}

export function channelEngagementCsvUrl(days = 30): string {
  return `/resupply-api/admin/analytics/channel-engagement.csv?days=${days}`;
}

export async function fetchChannelEngagement(
  days = 30,
): Promise<ChannelEngagementResponse> {
  const url = `/resupply-api/admin/analytics/channel-engagement?days=${days}`;
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
  return (await res.json()) as ChannelEngagementResponse;
}
