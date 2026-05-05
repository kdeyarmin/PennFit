// Hand-rolled fetch wrapper for /admin/followups (Phase 18 + 20).
// Cross-flow queue across shop_customers and patients.

export type AdminFollowupKind = "shop_customer" | "patient";

export interface AdminFollowupRow {
  kind: AdminFollowupKind;
  id: string;
  subjectId: string;
  subjectDisplayName: string | null;
  /** Only populated for shop_customer rows; null for patient rows. */
  subjectEmail: string | null;
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
