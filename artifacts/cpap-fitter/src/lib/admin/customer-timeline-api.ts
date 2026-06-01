// Fetch wrapper for /admin/shop/customers/:id/timeline (CSR #12) — the
// cross-channel customer timeline. Unifies conversations, orders,
// returns, follow-ups, and reviews into one chronological feed, newest
// first. Read-only; gated on conversations.manage server-side. Metadata
// only — ids + status + kind + timestamps, no message bodies.

import { ApiError } from "@workspace/api-client-react/admin";

export type CustomerEventKind =
  | "conversation"
  | "order"
  | "return"
  | "followup"
  | "review";

export interface CustomerTimelineEvent {
  kind: CustomerEventKind;
  refId: string;
  at: string;
  label: string;
}

export interface CustomerTimelineResponse {
  events: CustomerTimelineEvent[];
  count: number;
}

export async function getAdminCustomerTimeline(
  customerId: string,
): Promise<CustomerTimelineResponse> {
  const url = `/resupply-api/admin/shop/customers/${encodeURIComponent(
    customerId,
  )}/timeline`;
  const res = await fetch(url, { headers: { Accept: "application/json" } });
  if (!res.ok) {
    let data: unknown = null;
    try {
      data = await res.json();
    } catch {
      // non-JSON error body — status alone is enough
    }
    throw new ApiError(res, data, { method: "GET", url });
  }
  return (await res.json()) as CustomerTimelineResponse;
}
