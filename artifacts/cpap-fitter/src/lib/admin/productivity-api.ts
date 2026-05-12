// Hand-rolled fetch wrapper for /admin/productivity.

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
  const res = await fetch(
    `/resupply-api/admin/productivity?window=${encodeURIComponent(window)}`,
    {
      credentials: "include",
      headers: { Accept: "application/json" },
    },
  );
  if (!res.ok) {
    let message = `${res.status} ${res.statusText}`;
    try {
      const body = (await res.json()) as { message?: string; error?: string };
      message = body.message ?? body.error ?? message;
    } catch {
      // ignore
    }
    throw new Error(message);
  }
  return (await res.json()) as ProductivityResponse;
}
