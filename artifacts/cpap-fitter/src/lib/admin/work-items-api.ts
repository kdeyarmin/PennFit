// Fetch wrapper for /admin/work-items (Phase 4, CSR #10) — the unified,
// prioritized CSR work queue. One round-trip UNIONs the open work across
// every triage source (conversations, returns, reviews, patient
// documents, followups, faxes), oldest / most-overdue first. The route
// returns camelCase already.

import { ApiError } from "@workspace/api-client-react/admin";

export type WorkItemKind =
  | "conversation"
  | "return"
  | "review"
  | "patient_document"
  | "followup"
  | "fax";

export interface WorkItem {
  kind: WorkItemKind;
  refId: string;
  createdAt: string;
  dueAt: string | null;
  sortAt: string;
  /** Hours past due for followups (>= 0); null for non-due items. */
  overdueHours: number | null;
}

export interface WorkItemsResponse {
  workItems: WorkItem[];
  count: number;
  serverTime: string;
}

export async function fetchWorkItems(): Promise<WorkItemsResponse> {
  const url = "/resupply-api/admin/work-items";
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
  return (await res.json()) as WorkItemsResponse;
}
