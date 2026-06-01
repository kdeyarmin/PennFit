// Hand-rolled fetch wrapper for /admin/inbox-counts (Phase 16).
// Powers the actionable-work badges on the admin nav.

import { ApiError } from "@workspace/api-client-react/admin";

export interface AdminInboxCounts {
  awaitingReplyConversations: number;
  pendingReturns: number;
  pendingReviews: number;
  /** Phase 18 — open overdue followups whose due_at is in the past, across both shop customers and patients. */
  overdueFollowups: number;
  /** Patient-uploaded documents that no admin has yet marked as reviewed. */
  newPatientDocuments: number;
  /** Inbound faxes that have landed in the queue but no CSR has triaged. */
  newInboundFaxes: number;
  serverTime: string;
}

export async function fetchAdminInboxCounts(): Promise<AdminInboxCounts> {
  const url = "/resupply-api/admin/inbox-counts";
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
  return (await res.json()) as AdminInboxCounts;
}
