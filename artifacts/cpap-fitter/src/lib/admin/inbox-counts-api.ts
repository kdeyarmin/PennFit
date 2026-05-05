// Hand-rolled fetch wrapper for /admin/inbox-counts (Phase 16).
// Powers the actionable-work badges on the admin nav.

export interface AdminInboxCounts {
  awaitingReplyConversations: number;
  pendingReturns: number;
  pendingReviews: number;
  serverTime: string;
}

export async function fetchAdminInboxCounts(): Promise<AdminInboxCounts> {
  const res = await fetch("/resupply-api/admin/inbox-counts", {
    headers: { Accept: "application/json" },
  });
  if (!res.ok) {
    throw new Error(`Failed to load inbox counts (${res.status})`);
  }
  return (await res.json()) as AdminInboxCounts;
}
