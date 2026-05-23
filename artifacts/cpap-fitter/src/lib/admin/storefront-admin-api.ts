/**
 * Typed fetch wrappers for the PennPaps storefront admin endpoints
 * (`/api/admin/*`) that resupply-api now mounts alongside its own
 * `/resupply-api/*` routes (Task #37 consolidation).
 *
 * These are deliberately kept OUT of the OpenAPI client
 * (`@workspace/api-client-react/admin`) because:
 *   1. The resupply API spec describes the conversation/episode
 *      surface; the storefront admin surface is a separate,
 *      cookie-gated set of routes hosted by the same Express app
 *      via the storefront sub-router.
 *   2. Adding them to the spec would force a regen on every change
 *      to the storefront admin contract and force every spec
 *      consumer (mobile, internal tools) to ship the storefront
 *      types they don't need.
 *
 * All requests use `credentials: "include"` so the `pf_session`
 * cookie issued by `/api/auth/sign-in` is sent. Errors are surfaced
 * as `StorefrontAdminApiError` with `status` + parsed payload so
 * callers can render auth gates ("not authorized") differently from
 * unexpected failures.
 */

const BASE = "/api"; // resupply-api artifact.toml mounts the storefront router under /api

export class StorefrontAdminApiError extends Error {
  constructor(
    public status: number,
    public payload: { error?: string } | null,
  ) {
    super(payload?.error ?? `Storefront admin API error ${status}`);
  }
}

async function adminFetch<T>(path: string): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    credentials: "include",
    headers: { Accept: "application/json" },
  });
  if (!res.ok) {
    let body: { error?: string } | null = null;
    try {
      body = (await res.json()) as { error?: string };
    } catch {
      // ignore — empty/non-JSON error body is fine, status alone is enough
    }
    throw new StorefrontAdminApiError(res.status, body);
  }
  return (await res.json()) as T;
}

async function adminPost<T>(
  path: string,
  body?: Record<string, unknown>,
): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    method: "POST",
    credentials: "include",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    let payload: { error?: string } | null = null;
    try {
      payload = (await res.json()) as { error?: string };
    } catch {
      // ignore
    }
    throw new StorefrontAdminApiError(res.status, payload);
  }
  // Some endpoints return 204; tolerate empty bodies by returning
  // an empty object cast to T.
  if (res.status === 204) return {} as T;
  return (await res.json()) as T;
}

/* --------------------------------- Orders -------------------------------- */

export interface AdminOrderRow {
  id: string;
  orderReference: string;
  patientFirstName: string;
  patientLastName: string;
  patientEmail: string;
  patientPhone?: string | null;
  patientDateOfBirth?: string | null;
  maskId: string;
  maskName: string;
  maskManufacturer: string;
  maskModelNumber?: string | null;
  shippingCity: string;
  shippingState: string;
  shippingZip: string;
  emailStatus: "pending" | "sent" | "failed" | "skipped";
  emailDeliveredAt?: string | null;
  emailError?: string | null;
  createdAt: string;
}

export interface AdminOrderListResponse {
  orders: AdminOrderRow[];
  page: number;
  pageSize: number;
  total: number;
}

export const fetchAdminOrders = (params: {
  q?: string;
  status?: string;
  page?: number;
  pageSize?: number;
}): Promise<AdminOrderListResponse> => {
  const search = new URLSearchParams();
  if (params.q) search.set("q", params.q);
  if (params.status) search.set("status", params.status);
  if (params.page) search.set("page", String(params.page));
  if (params.pageSize) search.set("pageSize", String(params.pageSize));
  const qs = search.toString();
  return adminFetch<AdminOrderListResponse>(
    `/admin/orders${qs ? `?${qs}` : ""}`,
  );
};

export interface AdminOrderDetail extends AdminOrderRow {
  payload: Record<string, unknown>;
}

export const fetchAdminOrder = (id: string) =>
  adminFetch<{ order: AdminOrderDetail }>(
    `/admin/orders/${encodeURIComponent(id)}`,
  );

/* ------------------------------ Reminders -------------------------------- */

export interface AdminReminderItem {
  sku: string;
  nextDueAt: string;
}

export interface AdminReminderSubscriber {
  id: string;
  email: string;
  status: "active" | "unsubscribed";
  createdAt: string;
  lastSentAt?: string | null;
  dueCount: number;
  items: AdminReminderItem[];
}

export interface AdminReminderListResponse {
  subscribers: AdminReminderSubscriber[];
}

export const fetchAdminReminders = () =>
  adminFetch<AdminReminderListResponse>("/admin/reminders");

export interface SendDueRemindersResponse {
  sent: number;
  skippedQuiet: number;
  skippedNoneDue: number;
  failed: number;
  sendgridConfigured: boolean;
}

export const sendDueReminders = () =>
  adminPost<SendDueRemindersResponse>("/admin/reminders/send-due");

/* ------------------------------ Analytics -------------------------------- */

export interface AdminStatusBreakdown {
  status: "pending" | "sent" | "failed" | "skipped";
  count: number;
}

export interface AdminMaskBreakdown {
  maskName: string;
  maskManufacturer: string;
  count: number;
}

export interface AdminFunnelStep {
  step: string;
  count: number;
}

export interface AdminOrdersByDay {
  day: string;
  count: number;
}

export interface AdminAnalyticsResponse {
  totalOrders: number;
  statusBreakdown: AdminStatusBreakdown[];
  topMasks: AdminMaskBreakdown[];
  funnel: AdminFunnelStep[];
  ordersByDay: AdminOrdersByDay[];
}

export const fetchAdminAnalytics = () =>
  adminFetch<AdminAnalyticsResponse>("/admin/analytics");
