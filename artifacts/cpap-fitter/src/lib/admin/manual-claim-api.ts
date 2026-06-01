// Fetch wrapper for POST /admin/patients/:id/manual-claims (Biller #32).

import { ApiError } from "@workspace/api-client-react/admin";

import { csrfHeader } from "../csrf";

export type ClaimFrequencyCode = "1" | "7" | "8";

export interface CreateManualClaimBody {
  payerName: string;
  dateOfService: string;
  claimFrequencyCode: ClaimFrequencyCode;
  originalClaimNumber?: string | null;
  claimNumber?: string | null;
  notes?: string | null;
}

export interface CreateManualClaimResult {
  id: string;
  entrySource: "manual" | "adjustment";
  claimFrequencyCode: ClaimFrequencyCode;
}

export async function createManualClaim(
  patientId: string,
  body: CreateManualClaimBody,
): Promise<CreateManualClaimResult> {
  const url = `/resupply-api/admin/patients/${encodeURIComponent(patientId)}/manual-claims`;
  const res = await fetch(url, {
    method: "POST",
    credentials: "include",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      ...csrfHeader(),
    },
    body: JSON.stringify(body),
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
  return (await res.json()) as CreateManualClaimResult;
}
