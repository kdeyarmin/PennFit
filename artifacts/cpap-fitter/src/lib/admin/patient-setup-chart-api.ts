// Chart calls for the Setup tab: dispense readiness (E0601) and the
// manual Medicare same-or-similar record. Neither had a page.

import { ApiError } from "@workspace/api-client-react/admin";

import { csrfHeader } from "../csrf";

export interface DispenseReviewSummary {
  id: string;
  hcpcs_code: string;
  ready_to_dispense: boolean;
  overall_verdict: string;
  checks_failed: number;
  checks_passed: number;
  ai_summary: string | null;
  created_at: string;
  deterministic_findings_json: unknown;
}

export interface DispenseRunResult {
  reviewId: string;
  readyToDispense: boolean;
  overallVerdict: string;
  counts: { failed: number; passed: number; warning: number; total: number };
  findings: Array<{
    key: string;
    label: string;
    severity: string;
    detail?: string;
    blocksDispense?: boolean;
  }>;
}

export interface SameOrSimilarCheck {
  id: string;
  hcpcs_code: string;
  status: "clear" | "inactive" | "active" | "unknown";
  last_dispense_on: string | null;
  checked_at: string;
  window?: { clearsOn?: string | null; daysRemaining?: number | null };
}

async function readError(
  res: Response,
  method: string,
  url: string,
): Promise<ApiError> {
  let data: unknown = null;
  try {
    data = await res.json();
  } catch {
    // body not JSON
  }
  return new ApiError(res, data, { method, url });
}

export async function fetchDispenseReviews(
  patientId: string,
): Promise<DispenseReviewSummary[]> {
  const url = `/resupply-api/admin/patients/${encodeURIComponent(patientId)}/dispense-readiness-reviews`;
  const res = await fetch(url, {
    headers: { Accept: "application/json" },
    credentials: "include",
  });
  if (!res.ok) throw await readError(res, "GET", url);
  const body = (await res.json()) as { reviews?: DispenseReviewSummary[] };
  return body.reviews ?? [];
}

export async function runDispenseReadiness(
  patientId: string,
): Promise<DispenseRunResult> {
  const url = `/resupply-api/admin/patients/${encodeURIComponent(patientId)}/dispense-readiness-reviews`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
      ...csrfHeader(),
    },
    credentials: "include",
    body: JSON.stringify({ hcpcsCode: "E0601" }),
  });
  if (!res.ok) throw await readError(res, "POST", url);
  return (await res.json()) as DispenseRunResult;
}

export async function fetchSameOrSimilar(
  patientId: string,
): Promise<SameOrSimilarCheck[]> {
  const url = `/resupply-api/admin/patients/${encodeURIComponent(patientId)}/same-or-similar`;
  const res = await fetch(url, {
    headers: { Accept: "application/json" },
    credentials: "include",
  });
  if (!res.ok) throw await readError(res, "GET", url);
  const body = (await res.json()) as { checks?: SameOrSimilarCheck[] };
  return body.checks ?? [];
}

export async function recordSameOrSimilar(
  patientId: string,
  body: {
    status: SameOrSimilarCheck["status"];
    lastDispenseOn?: string | null;
    notes?: string;
  },
): Promise<void> {
  const url = `/resupply-api/admin/patients/${encodeURIComponent(patientId)}/same-or-similar`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
      ...csrfHeader(),
    },
    credentials: "include",
    body: JSON.stringify({ hcpcsCode: "E0601", ...body }),
  });
  if (!res.ok) throw await readError(res, "POST", url);
}
