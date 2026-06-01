// Fetch wrapper for /admin/billing/denials-worklist (Biller #33). The
// route returns camelCase already.

import { ApiError } from "@workspace/api-client-react/admin";

export type DenialRecommendation =
  | "auto_resubmit"
  | "manual_resubmit"
  | "appeal"
  | "bill_patient"
  | "write_off"
  | "manual_review";

export interface DenialWorkItem {
  claimId: string;
  patientId: string;
  payerName: string | null;
  recoverableCents: number;
  confidence: number | null;
  recommendation: DenialRecommendation | null;
  canAutoResubmit: boolean;
  denialReason: string | null;
  decisionAt: string | null;
  winProbability: number;
  scoreCents: number;
  hasAnalysis: boolean;
}

export interface DenialsWorklistResponse {
  items: DenialWorkItem[];
  totals: {
    count: number;
    recoverableCents: number;
    expectedRecoverableCents: number;
    autoResubmittable: number;
    unanalyzed: number;
  };
  generatedAt: string;
}

export async function fetchDenialsWorklist(): Promise<DenialsWorklistResponse> {
  const url = "/resupply-api/admin/billing/denials-worklist";
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
  return (await res.json()) as DenialsWorklistResponse;
}
