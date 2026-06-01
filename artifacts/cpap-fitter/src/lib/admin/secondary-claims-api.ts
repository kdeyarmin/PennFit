// Fetch wrappers for Biller #28 — secondary / COB claims. Read the
// eligible worklist on reports.read; generate a secondary on
// admin.tools.manage (enforced server-side).

import { ApiError } from "@workspace/api-client-react/admin";

import { csrfHeader } from "../csrf";

export interface SecondaryEligibleItem {
  claimId: string;
  patientId: string;
  primaryPayerName: string;
  billedCents: number;
  primaryPaidCents: number;
  patientResponsibilityCents: number;
}

export interface GenerateSecondaryResult {
  secondaryClaimId: string;
  cob: {
    primaryPaidCents: number;
    contractualCents: number;
    patientRespCents: number;
    billableToSecondaryCents: number;
  };
  lineCount: number;
}

export async function getSecondaryEligible(): Promise<{
  eligible: SecondaryEligibleItem[];
  count: number;
}> {
  const url = "/resupply-api/admin/billing/secondary-eligible";
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
  return (await res.json()) as {
    eligible: SecondaryEligibleItem[];
    count: number;
  };
}

export async function generateSecondaryClaim(
  claimId: string,
): Promise<GenerateSecondaryResult> {
  const url = `/resupply-api/admin/claims/${encodeURIComponent(
    claimId,
  )}/generate-secondary`;
  const res = await fetch(url, {
    method: "POST",
    credentials: "include",
    headers: { Accept: "application/json", ...csrfHeader() },
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
  return (await res.json()) as GenerateSecondaryResult;
}
