// Fetch wrappers for RT #23 clinical outreach. clinical.read to view the
// eligible list; running the batch needs clinical.intervention.write
// (enforced server-side).

import { ApiError } from "@workspace/api-client-react/admin";

import { csrfHeader } from "../csrf";

export interface OutreachEligibleItem {
  patientId: string;
  interventionId: string | null;
  category: string | null;
}

export interface OutreachBatchSummary {
  openInterventions: number;
  selected: number;
  sent: number;
  failed: number;
  skipped: number;
}

async function err(res: Response, method: string, url: string) {
  let data: unknown = null;
  try {
    data = await res.json();
  } catch {
    /* not json */
  }
  return new ApiError(res, data, { method, url });
}

export async function getOutreachEligible(): Promise<{
  eligible: OutreachEligibleItem[];
  count: number;
}> {
  const url = "/resupply-api/admin/clinical/outreach/eligible";
  const res = await fetch(url, {
    credentials: "include",
    headers: { Accept: "application/json" },
  });
  if (!res.ok) throw await err(res, "GET", url);
  return (await res.json()) as {
    eligible: OutreachEligibleItem[];
    count: number;
  };
}

export async function runOutreachBatch(
  cap?: number,
): Promise<{ summary: OutreachBatchSummary }> {
  const url = "/resupply-api/admin/clinical/outreach/run";
  const res = await fetch(url, {
    method: "POST",
    credentials: "include",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      ...csrfHeader(),
    },
    body: JSON.stringify(cap ? { cap } : {}),
  });
  if (!res.ok) throw await err(res, "POST", url);
  return (await res.json()) as { summary: OutreachBatchSummary };
}
