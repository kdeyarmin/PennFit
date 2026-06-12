// Hand-rolled fetch wrapper for /admin/outbound-messages.

import { ApiError } from "@workspace/api-client-react/admin";

export type OutboundChannelFilter = "all" | "sms" | "email";
export type OutboundResultFilter =
  | "all"
  | "delivered"
  | "sent"
  | "failed"
  | "pending";

export interface OutboundMessageItem {
  id: string;
  occurredAt: string;
  channel: "sms" | "email" | null;
  senderRole: string;
  deliveryStatus: string | null;
  deliveryError: string | null;
  deliveredAt: string | null;
  result: "delivered" | "sent" | "failed" | "pending";
  conversationId: string;
  patientId: string | null;
  patientName: string | null;
}

export interface OutboundMessagesResponse {
  sinceDays: number;
  channel: OutboundChannelFilter;
  result: OutboundResultFilter;
  limit: number;
  offset: number;
  total: number;
  counts: {
    delivered: number;
    sent: number;
    failed: number;
    pending: number;
  };
  items: OutboundMessageItem[];
}

export interface OutboundMessagesParams {
  channel: OutboundChannelFilter;
  result: OutboundResultFilter;
  sinceDays: number;
  limit: number;
  offset: number;
}

export async function fetchOutboundMessages(
  params: OutboundMessagesParams,
): Promise<OutboundMessagesResponse> {
  const search = new URLSearchParams({
    sinceDays: String(params.sinceDays),
    limit: String(params.limit),
    offset: String(params.offset),
  });
  if (params.channel !== "all") search.set("channel", params.channel);
  if (params.result !== "all") search.set("result", params.result);
  const url = `/resupply-api/admin/outbound-messages?${search.toString()}`;
  const res = await fetch(url, { headers: { Accept: "application/json" } });
  if (!res.ok) {
    let data: unknown = null;
    try {
      data = await res.json();
    } catch {
      // body not JSON
    }
    throw new ApiError(res, data, { method: "GET", url });
  }
  return (await res.json()) as OutboundMessagesResponse;
}
