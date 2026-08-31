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
  /** Whether this gate has a queue to count at all — static, from the
   *  registry. Distinguishes a permanent dash from a failed lookup. */
  countable: boolean;
  /** `null` when there is no single countable queue, or the count failed.
   *  Never render this as zero; read `countable` to tell the two apart. */
  waiting: number | null;
}

export interface ApprovalGatesResponse {
  gates: ApprovalGateRow[];
  totals: {
    gateCount: number;
    waiting: number;
    /** Gates with no single queue to count — a constant of the registry. */
    uncountableGates: number;
    /** Gates whose count failed on THIS request. Non-zero means the
     *  totals are understated right now, which is an outage, not a
     *  quiet day. */
    failedCounts: number;
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
