// Hand-rolled fetch wrappers for the admin abandoned-carts endpoints.
//
// Same rationale as shop-reviews-api.ts and shop-inventory-api.ts:
// these v1 endpoints aren't in the OpenAPI spec yet (they were
// added directly to the API for internal admin tooling). Adding
// them to the spec + regen would be the right next step if the
// surface grows; for the v1 admin queue this thin wrapper avoids a
// codegen cycle for every backend tweak.
//
// Auth: the browser sends the `pf_session` cookie automatically on
// same-origin requests, so no per-call auth header is needed.

import { ApiError } from "@workspace/api-client-react/admin";

import { csrfHeader } from "../csrf";

export interface AbandonedCartRow {
  id: string;
  customerId: string | null;
  emailRedacted: string | null;
  itemCount: number;
  subtotalCents: number;
  currency: string;
  updatedAt: string;
  remindedAt: string | null;
  recoveredAt: string | null;
  clearedAt: string | null;
  createdAt: string;
}

export interface ListAbandonedCartsResponse {
  rows: AbandonedCartRow[];
}

export interface SendDueResponse {
  scanned: number;
  sent: number;
  skippedNoConfig: number;
  skippedFailed: number;
  sendgridConfigured: boolean;
}

export async function listAdminAbandonedCarts(): Promise<ListAbandonedCartsResponse> {
  const url = `/resupply-api/admin/shop/abandoned-carts`;
  const res = await fetch(url, {
    headers: { Accept: "application/json" },
  });
  if (!res.ok) {
    let data: unknown = null;
    try {
      data = await res.json();
    } catch {
      /* body not JSON */
    }
    throw new ApiError(res, data, { method: "GET", url });
  }
  return (await res.json()) as ListAbandonedCartsResponse;
}

export async function sendDueAbandonedCarts(): Promise<SendDueResponse> {
  const url = `/resupply-api/admin/shop/abandoned-carts/send-due`;
  const res = await fetch(url, {
    method: "POST",
    headers: { Accept: "application/json", ...csrfHeader() },
  });
  if (!res.ok) {
    let data: unknown = null;
    try {
      data = await res.json();
    } catch {
      /* body not JSON */
    }
    throw new ApiError(res, data, { method: "POST", url });
  }
  return (await res.json()) as SendDueResponse;
}
