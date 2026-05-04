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
  const res = await fetch(`/resupply-api/admin/shop/abandoned-carts`, {
    headers: { Accept: "application/json" },
  });
  if (!res.ok) {
    throw new Error(`Failed to load abandoned carts (${res.status})`);
  }
  return (await res.json()) as ListAbandonedCartsResponse;
}

export async function sendDueAbandonedCarts(): Promise<SendDueResponse> {
  const res = await fetch(`/resupply-api/admin/shop/abandoned-carts/send-due`, {
    method: "POST",
    headers: { Accept: "application/json" },
  });
  if (!res.ok) {
    throw new Error(`Send-due failed (${res.status})`);
  }
  return (await res.json()) as SendDueResponse;
}
