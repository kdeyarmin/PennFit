// Fetch wrapper for /admin/billing/timely-filing (Biller #36) — the
// open-claim filing-deadline worklist. The route returns camelCase
// already, so there's no field mapping here.

import { ApiError } from "@workspace/api-client-react/admin";

export type TimelyFilingStatus = "ok" | "due_soon" | "overdue" | "unknown";

export interface TimelyFilingClaim {
  id: string;
  patientId: string;
  payerName: string | null;
  status: string;
  dateOfService: string;
  totalBilledCents: number | null;
  filingStatus: TimelyFilingStatus;
  daysRemaining: number | null;
  deadline: string | null;
}

export interface TimelyFilingCounts {
  overdue: number;
  dueSoon: number;
  ok: number;
  unknown: number;
  total: number;
}

export interface TimelyFilingResponse {
  claims: TimelyFilingClaim[];
  counts: TimelyFilingCounts;
  generatedAt: string;
}

export type TimelyFilingFilter = TimelyFilingStatus | "all";

export async function listTimelyFiling(
  status?: TimelyFilingFilter,
): Promise<TimelyFilingResponse> {
  const qs = status && status !== "all" ? `?status=${status}` : "";
  const url = `/resupply-api/admin/billing/timely-filing${qs}`;
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
  return (await res.json()) as TimelyFilingResponse;
}
