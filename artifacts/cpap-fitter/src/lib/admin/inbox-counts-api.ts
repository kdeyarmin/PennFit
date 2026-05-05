// Hand-rolled fetch wrapper for /admin/inbox-counts (Phase 16).
// Powers the actionable-work badges on the admin nav.

export interface AdminInboxCounts {
  awaitingReplyConversations: number;
  pendingReturns: number;
  pendingReviews: number;
  /** Phase 18 — open overdue followups whose due_at is in the past, across both shop customers and patients. */
  overdueFollowups: number;
  /** Patient-uploaded documents that no admin has yet marked as reviewed. */
  newPatientDocuments: number;
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
