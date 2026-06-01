// Hand-rolled fetch wrapper for /admin/productivity.

import { ApiError } from "@workspace/api-client-react/admin";

export type ProductivityWindow = "today" | "7d" | "30d";

export interface AgentStats {
  adminUserId: string;
  email: string;
  displayName: string | null;
  role: string;
  assignedConversationsOpen: number;
  conversationsClosedInWindow: number;
  returnsApproved: number;
  returnsRejected: number;
  complianceAlertsResolved: number;
  followupsCompleted: number;
}

export interface ProductivityResponse {
  window: { kind: ProductivityWindow; from: string; to: string };
  agents: AgentStats[];
}

export async function getProductivity(
  window: ProductivityWindow,
): Promise<ProductivityResponse> {
  const url = `/resupply-api/admin/productivity?window=${encodeURIComponent(window)}`;
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
  return (await res.json()) as ProductivityResponse;
}
