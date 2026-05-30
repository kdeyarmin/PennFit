// Hand-rolled fetch wrappers for the admin insurance-leads endpoints.
//
// Same rationale as shop-reviews-api.ts and abandoned-carts-api.ts:
// these v1 admin endpoints aren't in the OpenAPI spec yet. Adding
// them to the spec + regen would be the right next step if the
// surface grows; for the v1 admin queue this thin wrapper avoids a
// codegen cycle for every backend tweak.
//
// Auth: the browser sends the `pf_session` cookie automatically on
// same-origin requests, so no per-call auth header is needed.

import { ApiError } from "@workspace/api-client-react/admin";

import { csrfHeader } from "../csrf";

export type InsuranceLeadStatus = "new" | "contacted" | "verified" | "closed";

export interface InsuranceLeadRow {
  id: string;
  fullName: string;
  email: string;
  phone: string;
  dateOfBirth: string;
  insuranceCarrier: string;
  memberId: string;
  groupNumber: string | null;
  prescribingPhysician: string | null;
  notes: string | null;
  status: InsuranceLeadStatus;
  csrNote: string | null;
  notificationEmailDelivered: boolean;
  confirmationEmailDelivered: boolean;
  moderatedAt: string | null;
  moderatedBy: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ListInsuranceLeadsResponse {
  rows: InsuranceLeadRow[];
  counts: Record<InsuranceLeadStatus, number>;
}

export async function listInsuranceLeads(
  status: InsuranceLeadStatus | "all" = "all",
): Promise<ListInsuranceLeadsResponse> {
  const qs = status === "all" ? "" : `?status=${encodeURIComponent(status)}`;
  const url = `/resupply-api/admin/shop/insurance-leads${qs}`;
  const res = await fetch(url, {
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
  return (await res.json()) as ListInsuranceLeadsResponse;
}

export interface UpdateInsuranceLeadInput {
  status?: InsuranceLeadStatus;
  csrNote?: string | null;
}

export interface UpdateInsuranceLeadResponse {
  id: string;
  status: InsuranceLeadStatus;
  csrNote: string | null;
  moderatedAt: string | null;
  moderatedBy: string | null;
  updatedAt: string;
}

export async function updateInsuranceLead(
  id: string,
  body: UpdateInsuranceLeadInput,
): Promise<UpdateInsuranceLeadResponse> {
  const url = `/resupply-api/admin/shop/insurance-leads/${encodeURIComponent(id)}`;
  const res = await fetch(url, {
    method: "PATCH",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
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
    throw new ApiError(res, data, { method: "PATCH", url });
  }
  return (await res.json()) as UpdateInsuranceLeadResponse;
}
