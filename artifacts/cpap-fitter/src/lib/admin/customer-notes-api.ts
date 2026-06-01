// Hand-rolled fetch wrappers for the admin shop-customer notes
// endpoints (Phase 10).
//
// Auth: same pattern as customers-api.ts — the browser sends the
// `pf_session` cookie automatically on same-origin requests, so no
// per-call auth header is needed.

import { ApiError } from "@workspace/api-client-react/admin";

import { csrfHeader } from "../csrf";

export interface AdminCustomerNote {
  id: string;
  body: string;
  authorEmail: string;
  authorUserId: string | null;
  createdAt: string;
}

export interface AdminCustomerNotesListResponse {
  notes: AdminCustomerNote[];
}

export interface CreateAdminCustomerNoteResponse {
  id: string;
  createdAt: string;
}

export class AdminCustomerNotesNotFoundError extends Error {
  constructor() {
    super("Customer not found.");
  }
}

export async function listAdminCustomerNotes(
  userId: string,
): Promise<AdminCustomerNotesListResponse> {
  const res = await fetch(
    `/resupply-api/admin/shop/customers/${encodeURIComponent(userId)}/notes`,
    { headers: { Accept: "application/json" } },
  );
  if (res.status === 404) {
    throw new AdminCustomerNotesNotFoundError();
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
  return (await res.json()) as AdminCustomerNotesListResponse;
}

export async function createAdminCustomerNote(
  userId: string,
  body: string,
): Promise<CreateAdminCustomerNoteResponse> {
  const res = await fetch(
    `/resupply-api/admin/shop/customers/${encodeURIComponent(userId)}/notes`,
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
    throw new AdminCustomerNotesNotFoundError();
  }
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new ApiError(res, text || null, { method: "POST", url: res.url });
  }
  return (await res.json()) as CreateAdminCustomerNoteResponse;
}
