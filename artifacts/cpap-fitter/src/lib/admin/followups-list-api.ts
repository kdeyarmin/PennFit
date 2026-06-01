// Hand-rolled fetch wrapper for /admin/followups (Phase 18 + 20).
// Cross-flow queue across shop_customers and patients.

import { ApiError } from "@workspace/api-client-react/admin";

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
  const url = "/resupply-api/admin/followups";
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
  return (await res.json()) as AdminFollowupsListResponse;
}
