// Fetch wrapper for /admin/approval-gates — the set of transitions that
// require a person, with live counts. Read-only; the route changes no
// gate.

import { ApiError } from "@workspace/api-client-react/admin";

export interface ApprovalGateRow {
  key: string;
  label: string;
  actor: "biller" | "csr" | "clinician" | "owner";
  actorLabel: string;
  /** Why a person is required. Shown verbatim — it is the answer to the
   *  question the panel provokes. */
  why: string;
  href: string;
  permission: string;
  /** `null` when there is no single countable queue, or the count failed.
   *  Never render this as zero. */
  waiting: number | null;
}

export interface ApprovalGatesResponse {
  gates: ApprovalGateRow[];
  totals: {
    gateCount: number;
    waiting: number;
    /** Gates excluded from `waiting` because they could not be counted. */
    uncountedGates: number;
  };
}

export async function fetchApprovalGates(): Promise<ApprovalGatesResponse> {
  const url = "/resupply-api/admin/approval-gates";
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
  return (await res.json()) as ApprovalGatesResponse;
}
