// Hand-rolled fetch wrapper for GET /admin/staffing/live (CSR #C3).

import { ApiError } from "@workspace/api-client-react/admin";

export interface StaffAgentLoad {
  adminUserId: string;
  email: string;
  displayName: string | null;
  role: string;
  availability: string;
  onShift: boolean;
  openConversations: number;
}

export interface LiveStaffingSnapshot {
  agents: StaffAgentLoad[];
  unassignedOpenConversations: number;
  totalOpenConversations: number;
  activeAgents: number;
  onShiftAgents: number;
}

export async function getLiveStaffing(): Promise<LiveStaffingSnapshot> {
  const url = "/resupply-api/admin/staffing/live";
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
  return (await res.json()) as LiveStaffingSnapshot;
}
