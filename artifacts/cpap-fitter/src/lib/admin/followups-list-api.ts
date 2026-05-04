// Hand-rolled fetch wrappers for the cross-customer followups
// endpoint (Phase 18). Reuses the per-customer "complete" endpoint
// from Phase 17 for the inline-done action.

export interface AdminFollowupRow {
  id: string;
  customerId: string;
  customerDisplayName: string | null;
  customerEmail: string | null;
  body: string;
  dueAt: string;
  createdByEmail: string;
  createdAt: string;
}

export interface AdminFollowupsListResponse {
  followups: AdminFollowupRow[];
}

export async function listAllAdminFollowups(): Promise<AdminFollowupsListResponse> {
  const res = await fetch("/resupply-api/admin/followups", {
    headers: { Accept: "application/json" },
  });
  if (!res.ok) {
    throw new Error(`Failed to load followups (${res.status})`);
  }
  return (await res.json()) as AdminFollowupsListResponse;
}
