// Fetch wrapper for /admin/billing/eligibility-verification-worklist
// (Biller #31). Route returns camelCase already.

import { ApiError } from "@workspace/api-client-react/admin";

import { csrfHeader } from "../csrf";

export type VerificationStatus =
  | "never_verified"
  | "terminating_soon"
  | "stale"
  | "ok";

export interface VerificationWorkItem {
  id: string;
  patientId: string;
  rank: string;
  payerName: string | null;
  memberIdTail: string | null;
  verifiedAt: string | null;
  terminationDate: string | null;
  status: VerificationStatus;
  daysSinceVerified: number | null;
  daysUntilTermination: number | null;
  priority: number;
}

export interface VerificationWorklistResponse {
  staleDays: number;
  items: VerificationWorkItem[];
  counts: {
    neverVerified: number;
    terminatingSoon: number;
    stale: number;
    ok: number;
    total: number;
  };
  generatedAt: string;
}

export async function fetchEligibilityVerificationWorklist(
  staleDays = 30,
): Promise<VerificationWorklistResponse> {
  const url = `/resupply-api/admin/billing/eligibility-verification-worklist?staleDays=${staleDays}`;
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
  return (await res.json()) as VerificationWorklistResponse;
}

export interface ReverifyBatchSummary {
  scanned: number;
  due: number;
  selected: number;
  fired: number;
  uploadOk: number;
  errored: number;
}

/**
 * Fire the re-verification batch on demand (admin.tools.manage). Emits
 * outbound 270s for the most-urgent, not-recently-attempted coverages,
 * capped per run; returns a counts summary.
 */
export async function runEligibilityBatch(opts?: {
  cap?: number;
  staleDays?: number;
}): Promise<{ summary: ReverifyBatchSummary }> {
  const url = "/resupply-api/admin/billing/eligibility-batch-run";
  const res = await fetch(url, {
    method: "POST",
    credentials: "include",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      ...csrfHeader(),
    },
    body: JSON.stringify(opts ?? {}),
  });
  if (!res.ok) {
    let data: unknown = null;
    try {
      data = await res.json();
    } catch {
      // body not JSON
    }
    throw new ApiError(res, data, { method: "POST", url });
  }
  return (await res.json()) as { summary: ReverifyBatchSummary };
}
