// Hand-rolled fetch wrappers for the admin shop-order notes
// endpoints (Phase 14). Mirrors customer-notes-api.ts.
//
// Auth: the browser sends the `pf_session` cookie automatically on
// same-origin requests, so no per-call auth header is needed.

import { ApiError } from "@workspace/api-client-react/admin";

import { csrfHeader } from "../csrf";

export interface AdminOrderNote {
  id: string;
  body: string;
  authorEmail: string;
  authorUserId: string | null;
  createdAt: string;
}

export interface AdminOrderNotesListResponse {
  notes: AdminOrderNote[];
}

export interface CreateAdminOrderNoteResponse {
  id: string;
  createdAt: string;
}

export class AdminOrderNotesNotFoundError extends Error {
  constructor() {
    super("Order not found.");
  }
}

export async function listAdminOrderNotes(
  orderId: string,
): Promise<AdminOrderNotesListResponse> {
  const res = await fetch(
    `/resupply-api/admin/shop/orders/${encodeURIComponent(orderId)}/notes`,
    { headers: { Accept: "application/json" } },
  );
  if (res.status === 404) {
    throw new AdminOrderNotesNotFoundError();
  }
  if (!res.ok) {
    let data: unknown = null;
    try {
      data = await res.json();
    } catch {
      // non-JSON error body — status alone is enough
    }
    throw new ApiError(res, data, { method: "GET", url: res.url });
  }
  return (await res.json()) as AdminOrderNotesListResponse;
}

export async function createAdminOrderNote(
  orderId: string,
  body: string,
): Promise<CreateAdminOrderNoteResponse> {
  const res = await fetch(
    `/resupply-api/admin/shop/orders/${encodeURIComponent(orderId)}/notes`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        ...csrfHeader(),
      },
      body: JSON.stringify({ body }),
    },
  );
  if (res.status === 404) {
    throw new AdminOrderNotesNotFoundError();
  }
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new ApiError(res, text || null, { method: "POST", url: res.url });
  }
  return (await res.json()) as CreateAdminOrderNoteResponse;
}
