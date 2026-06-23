// Fetch wrappers for the billing team's free-form notes log (migration
// 0467). Any admin staffer can read + post (requireAdmin server-side).

import { ApiError } from "@workspace/api-client-react/admin";

import { csrfHeader } from "../csrf";

export type BillingNoteCategory =
  | "claims"
  | "collections"
  | "payer"
  | "patient"
  | "general";

export interface BillingNote {
  id: string;
  category: BillingNoteCategory;
  patientId: string | null;
  body: string;
  authorEmail: string;
  authorUserId: string | null;
  createdAt: string;
}

export interface CreateBillingNoteRequest {
  category: BillingNoteCategory;
  body: string;
  patientId?: string | null;
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

export async function getBillingNotes(opts?: {
  category?: BillingNoteCategory;
  patientId?: string;
}): Promise<BillingNote[]> {
  const params = new URLSearchParams();
  if (opts?.category) params.set("category", opts.category);
  if (opts?.patientId) params.set("patientId", opts.patientId);
  const qs = params.toString();
  const url = "/resupply-api/admin/billing/notes" + (qs ? `?${qs}` : "");
  const res = await fetch(url, {
    credentials: "include",
    headers: { Accept: "application/json" },
  });
  if (!res.ok) throw await err(res, "GET", url);
  const json = (await res.json()) as { notes?: BillingNote[] };
  // Strict contract: the route always returns a `notes` array (even when
  // empty). A missing/malformed shape is a server regression we want to
  // surface as an error, not silently render as "no notes".
  if (!Array.isArray(json.notes)) {
    throw new ApiError(res, json, { method: "GET", url });
  }
  return json.notes;
}

export async function createBillingNote(
  input: CreateBillingNoteRequest,
): Promise<{ id: string; createdAt: string }> {
  const url = "/resupply-api/admin/billing/notes";
  const res = await fetch(url, {
    method: "POST",
    credentials: "include",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      ...csrfHeader(),
    },
    body: JSON.stringify(input),
  });
  if (!res.ok) throw await err(res, "POST", url);
  return (await res.json()) as { id: string; createdAt: string };
}
