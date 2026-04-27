/**
 * Thin fetch wrappers for the Clerk-gated admin endpoints. We deliberately
 * keep these OUT of the public OpenAPI client (`@workspace/api-client-react`)
 * because the public spec advertises a no-PHI service to patients — adding
 * admin endpoints there would muddy that contract.
 *
 * All calls use `credentials: "include"` so Clerk's session cookie is sent.
 * Errors are surfaced as thrown `AdminApiError` with status + payload, so
 * callers can render auth gates ("not authorized") differently from
 * unexpected failures.
 */

const base = import.meta.env.BASE_URL.replace(/\/$/, "");

export class AdminApiError extends Error {
  constructor(
    public status: number,
    public payload: { error?: string } | null,
  ) {
    super(payload?.error ?? `Admin API error ${status}`);
  }
}

async function adminFetch<T>(path: string): Promise<T> {
  const res = await fetch(`${base}/api${path}`, {
    credentials: "include",
    headers: { Accept: "application/json" },
  });
  if (!res.ok) {
    let body: { error?: string } | null = null;
    try {
      body = (await res.json()) as { error?: string };
    } catch {}
    throw new AdminApiError(res.status, body);
  }
  return (await res.json()) as T;
}

export interface AdminMe {
  email: string;
  clerkId: string;
}
export const fetchAdminMe = () => adminFetch<AdminMe>("/admin/me");

export interface AdminOrderSummary {
  id: string;
  orderReference: string;
  patientFirstName: string;
  patientLastName: string;
  patientEmail: string;
  maskName: string;
  maskManufacturer: string;
  shippingCity: string;
  shippingState: string;
  emailStatus: "pending" | "sent" | "failed" | "skipped";
  createdAt: string;
}

export interface AdminOrdersResponse {
  orders: AdminOrderSummary[];
  total: number;
  page: number;
  pageSize: number;
}

export const fetchAdminOrders = (params: {
  q?: string;
  status?: string;
  page?: number;
  pageSize?: number;
}) => {
  const usp = new URLSearchParams();
  if (params.q) usp.set("q", params.q);
  if (params.status) usp.set("status", params.status);
  if (params.page) usp.set("page", String(params.page));
  if (params.pageSize) usp.set("pageSize", String(params.pageSize));
  return adminFetch<AdminOrdersResponse>(`/admin/orders?${usp.toString()}`);
};

export interface AdminOrderDetail {
  order: AdminOrderSummary & {
    patientPhone: string;
    patientDateOfBirth: string;
    maskId: string;
    maskModelNumber: string;
    shippingZip: string;
    payload: Record<string, unknown>;
    emailError: string | null;
    emailDeliveredAt: string | null;
  };
}
export const fetchAdminOrder = (id: string) =>
  adminFetch<AdminOrderDetail>(`/admin/orders/${id}`);

export interface AdminAnalytics {
  totalOrders: number;
  statusBreakdown: Array<{ status: string; count: number }>;
  topMasks: Array<{ maskName: string; maskManufacturer: string; count: number }>;
  funnel: Array<{ step: string; count: number }>;
  ordersByDay: Array<{ day: string; count: number }>;
}
export const fetchAdminAnalytics = () =>
  adminFetch<AdminAnalytics>("/admin/analytics");

export interface AdminAuditEvent {
  id: string;
  adminEmail: string;
  adminClerkId: string;
  action: string;
  targetOrderId: string | null;
  ip: string | null;
  occurredAt: string;
}
export interface AdminAuditResponse {
  events: AdminAuditEvent[];
  total: number;
  page: number;
  pageSize: number;
}
export const fetchAdminAuditLog = (params: { page?: number; pageSize?: number }) => {
  const usp = new URLSearchParams();
  if (params.page) usp.set("page", String(params.page));
  if (params.pageSize) usp.set("pageSize", String(params.pageSize));
  return adminFetch<AdminAuditResponse>(`/admin/audit-log?${usp.toString()}`);
};
