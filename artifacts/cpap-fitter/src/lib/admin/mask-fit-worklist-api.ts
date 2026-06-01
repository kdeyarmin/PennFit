// Fetch wrappers for the RT mask-fit triage worklist (RT #22a slice 2).
// clinical.read to view; triage needs clinical.intervention.write
// (enforced server-side).

import { ApiError } from "@workspace/api-client-react/admin";

import { csrfHeader } from "../csrf";

export type FitOutcome = "good" | "leaking" | "uncomfortable";

export interface MaskFitWorkItem {
  id: string;
  order_id: string;
  fit_outcome: FitOutcome;
  comment: string | null;
  status: "new" | "reviewed" | "actioned";
  created_at: string;
  patientId: string | null;
}

export interface MaskFitWorklistResponse {
  items: MaskFitWorkItem[];
  count: number;
  counts: { uncomfortable: number; leaking: number };
}

export async function getMaskFitWorklist(): Promise<MaskFitWorklistResponse> {
  const url = "/resupply-api/admin/clinical/mask-fit/worklist";
  const res = await fetch(url, {
    credentials: "include",
    headers: { Accept: "application/json" },
  });
  if (!res.ok) {
    let data: unknown = null;
    try {
      data = await res.json();
    } catch {
      // not JSON
    }
    throw new ApiError(res, data, { method: "GET", url });
  }
  return (await res.json()) as MaskFitWorklistResponse;
}

export async function triageMaskFit(
  id: string,
  status: "reviewed" | "actioned",
): Promise<{ ok: boolean; status: string }> {
  const url = `/resupply-api/admin/clinical/mask-fit/${encodeURIComponent(
    id,
  )}/triage`;
  const res = await fetch(url, {
    method: "POST",
    credentials: "include",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      ...csrfHeader(),
    },
    body: JSON.stringify({ status }),
  });
  if (!res.ok) {
    let data: unknown = null;
    try {
      data = await res.json();
    } catch {
      // not JSON
    }
    throw new ApiError(res, data, { method: "POST", url });
  }
  return (await res.json()) as { ok: boolean; status: string };
}
