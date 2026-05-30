// Hand-rolled fetch wrappers for the admin shop-customer followups
// endpoints (Phase 17). Mirrors customer-notes-api.ts.

import { ApiError } from "@workspace/api-client-react/admin";

import { csrfHeader } from "../csrf";

export interface AdminCustomerFollowup {
  id: string;
  body: string;
  dueAt: string;
  completedAt: string | null;
  completedByEmail: string | null;
  createdByEmail: string;
  createdAt: string;
}

export interface AdminCustomerFollowupsListResponse {
  followups: AdminCustomerFollowup[];
}

export interface CreateAdminCustomerFollowupResponse {
  id: string;
  dueAt: string;
  createdAt: string;
}

export interface CompleteAdminCustomerFollowupResponse {
  id: string;
  completedAt: string | null;
}

export class AdminCustomerFollowupsNotFoundError extends Error {
  constructor() {
    super("Customer or followup not found.");
  }
}

export async function listAdminCustomerFollowups(
  userId: string,
  options: { includeCompleted?: boolean } = {},
): Promise<AdminCustomerFollowupsListResponse> {
  const qs = options.includeCompleted ? "?include=completed" : "";
  const res = await fetch(
    `/resupply-api/admin/shop/customers/${encodeURIComponent(userId)}/followups${qs}`,
    { headers: { Accept: "application/json" } },
  );
  if (res.status === 404) {
    throw new AdminCustomerFollowupsNotFoundError();
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
  return (await res.json()) as AdminCustomerFollowupsListResponse;
}

export async function createAdminCustomerFollowup(
  userId: string,
  body: string,
  dueAt: Date,
): Promise<CreateAdminCustomerFollowupResponse> {
  const res = await fetch(
    `/resupply-api/admin/shop/customers/${encodeURIComponent(userId)}/followups`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        ...csrfHeader(),
      },
      body: JSON.stringify({ body, dueAt: dueAt.toISOString() }),
    },
  );
  if (res.status === 404) {
    throw new AdminCustomerFollowupsNotFoundError();
  }
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new ApiError(res, text || null, { method: "POST", url: res.url });
  }
  return (await res.json()) as CreateAdminCustomerFollowupResponse;
}

export async function completeAdminCustomerFollowup(
  userId: string,
  followupId: string,
): Promise<CompleteAdminCustomerFollowupResponse> {
  const res = await fetch(
    `/resupply-api/admin/shop/customers/${encodeURIComponent(userId)}/followups/${encodeURIComponent(followupId)}/complete`,
    {
      method: "PATCH",
      headers: { Accept: "application/json", ...csrfHeader() },
    },
  );
  if (res.status === 404) {
    throw new AdminCustomerFollowupsNotFoundError();
  }
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new ApiError(res, text || null, { method: "PATCH", url: res.url });
  }
  return (await res.json()) as CompleteAdminCustomerFollowupResponse;
}
