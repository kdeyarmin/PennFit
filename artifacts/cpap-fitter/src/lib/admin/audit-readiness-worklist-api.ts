// Fetch wrapper for the proactive audit-readiness worklist (migration 0460).
// reports.read; gated server-side behind billing.adr_queue.

import { ApiError } from "@workspace/api-client-react/admin";

export interface AuditReadinessItem {
  patientId: string;
  patientName: string;
  auditableClaims: number;
  billedCents: number;
  score: number;
  missing: string[];
}

export interface AuditReadinessWorklist {
  items: AuditReadinessItem[];
  counts: { short: number; billedAtRiskCents: number };
}

export async function getAuditReadinessWorklist(): Promise<AuditReadinessWorklist> {
  const url = "/resupply-api/admin/billing/audit-readiness-worklist";
  const res = await fetch(url, {
    credentials: "include",
    headers: { Accept: "application/json" },
  });
  if (!res.ok) {
    let data: unknown = null;
    try {
      data = await res.json();
    } catch {
      /* not json */
    }
    throw new ApiError(res, data, { method: "GET", url });
  }
  return (await res.json()) as AuditReadinessWorklist;
}
