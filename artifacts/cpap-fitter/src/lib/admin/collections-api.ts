// Fetch wrappers for the patient AR collections worklist (migration 0461).
// reports.read to view; patients.update for the manual transitions. Gated
// server-side behind the collections.dunning flag.

import { ApiError } from "@workspace/api-client-react/admin";

import { csrfHeader } from "../csrf";

export interface CollectionsRun {
  id: string;
  patient_id: string;
  opened_balance_cents: number;
  current_step: string;
  next_action_at: string | null;
  status: "active" | "paused";
  paused_reason: string | null;
  opened_on: string;
  last_step_at: string | null;
}

export interface CollectionsWorklist {
  items: CollectionsRun[];
  counts: {
    total: number;
    active: number;
    paused: number;
    atAgency: number;
    totalBalanceCents: number;
  };
}

async function err(
  res: Response,
  method: string,
  url: string,
): Promise<ApiError> {
  let data: unknown = null;
  try {
    data = await res.json();
  } catch {
    /* not json */
  }
  return new ApiError(res, data, { method, url });
}

export async function getCollectionsWorklist(): Promise<CollectionsWorklist> {
  const url = "/resupply-api/admin/billing/collections-worklist";
  const res = await fetch(url, {
    credentials: "include",
    headers: { Accept: "application/json" },
  });
  if (!res.ok) throw await err(res, "GET", url);
  return (await res.json()) as CollectionsWorklist;
}

/** Download the final-notice letter print batch. Returns {empty:true} when no
 *  runs are at the final-notice step. */
export async function downloadDunningLetters(): Promise<
  { blob: Blob; count: number } | { empty: true }
> {
  const url = "/resupply-api/admin/billing/collections/letter-batch";
  const res = await fetch(url, {
    credentials: "include",
    headers: { Accept: "application/pdf" },
  });
  if (res.status === 404) return { empty: true };
  if (!res.ok) throw await err(res, "GET", url);
  return {
    blob: await res.blob(),
    count: Number(res.headers.get("X-Dunning-Letter-Count") ?? 0),
  };
}

export async function transitionRun(
  id: string,
  action: "pause" | "resolve" | "cancel",
): Promise<void> {
  const url = `/resupply-api/admin/billing/collections/${encodeURIComponent(id)}/${action}`;
  const res = await fetch(url, {
    method: "POST",
    credentials: "include",
    headers: { Accept: "application/json", ...csrfHeader() },
  });
  if (!res.ok) throw await err(res, "POST", url);
}
