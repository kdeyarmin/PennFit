// Hand-rolled fetch wrappers for the admin fit-request queue.
//
// Same rationale as insurance-leads-api.ts: this admin surface isn't in
// an OpenAPI spec, and a thin wrapper avoids a codegen cycle for every
// backend tweak.
//
// Auth: the browser sends the `pf_session` cookie automatically on
// same-origin requests, so no per-call auth header is needed.

import { ApiError } from "@workspace/api-client-react/admin";

import { csrfHeader } from "../csrf";

export type FitRequestStatus = "new" | "contacted" | "in_progress" | "closed";
export type FitRequestType = "full_details" | "callback";
/** How a closed request turned out (migration 0519). Only `fulfilled`
 *  stamps the linked fitting as dispensed. */
export type FitRequestClosedOutcome =
  | "fulfilled"
  | "not_proceeding"
  | "unreachable"
  | "duplicate";

export interface FitRequestRow {
  id: string;
  requestType: FitRequestType;
  status: FitRequestStatus;
  fullName: string;
  email: string;
  /** Null when the patient asked to be reached by email. */
  phone: string | null;
  preferredContactMethod: "phone" | "email" | "text";
  preferredContactTime: string | null;
  dateOfBirth: string | null;
  insuranceCarrier: string | null;
  memberId: string | null;
  groupNumber: string | null;
  prescribingPhysician: string | null;
  notes: string | null;
  population: "adult" | "pediatric";
  fitterLeadId: string | null;
  fitSessionId: string | null;
  recommendedMaskId: string | null;
  recommendedMaskName: string | null;
  recommendedMaskType: string | null;
  recommendedMaskSize: string | null;
  csrNote: string | null;
  contactedAt: string | null;
  contactedBy: string | null;
  closedAt: string | null;
  closedOutcome: FitRequestClosedOutcome | null;
  createdAt: string;
  updatedAt: string;
}

export interface ListFitRequestsResponse {
  rows: FitRequestRow[];
  counts: Record<FitRequestStatus, number>;
}

async function readError(res: Response, method: string, url: string) {
  let data: unknown = null;
  try {
    data = await res.json();
  } catch {
    // body not JSON
  }
  return new ApiError(res, data, { method, url });
}

export async function listFitRequests(
  status: FitRequestStatus | "all" = "all",
  requestType: FitRequestType | "all" = "all",
): Promise<ListFitRequestsResponse> {
  const params = new URLSearchParams();
  if (status !== "all") params.set("status", status);
  if (requestType !== "all") params.set("requestType", requestType);
  const qs = params.toString();
  const url = `/resupply-api/admin/fitter-requests${qs ? `?${qs}` : ""}`;
  const res = await fetch(url, { headers: { Accept: "application/json" } });
  if (!res.ok) throw await readError(res, "GET", url);
  return (await res.json()) as ListFitRequestsResponse;
}

export interface UpdateFitRequestInput {
  status?: FitRequestStatus;
  csrNote?: string | null;
  /** Omit to leave the recorded outcome alone; null clears it. */
  closedOutcome?: FitRequestClosedOutcome | null;
}

export interface UpdateFitRequestResponse {
  id: string;
  status: FitRequestStatus;
  csrNote: string | null;
  contactedAt: string | null;
  contactedBy: string | null;
  closedAt: string | null;
  closedOutcome: FitRequestClosedOutcome | null;
  updatedAt: string;
}

export async function updateFitRequest(
  id: string,
  body: UpdateFitRequestInput,
): Promise<UpdateFitRequestResponse> {
  const url = `/resupply-api/admin/fitter-requests/${encodeURIComponent(id)}`;
  const res = await fetch(url, {
    method: "PATCH",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
      ...csrfHeader(),
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw await readError(res, "PATCH", url);
  return (await res.json()) as UpdateFitRequestResponse;
}
