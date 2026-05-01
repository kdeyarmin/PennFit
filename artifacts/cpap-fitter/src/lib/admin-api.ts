/**
 * Thin fetch wrappers for the auth-gated admin endpoints. We deliberately
 * keep these OUT of the public OpenAPI client (`@workspace/api-client-react`)
 * because the public spec advertises a no-PHI service to patients — adding
 * admin endpoints there would muddy that contract.
 *
 * All calls use `credentials: "include"` so the session cookie is sent.
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
  userId: string;
  /**
   * Caller's effective role. `admin` has full privileges; `agent` is
   * a junior-admin role used by customer-service staff (identical
   * permissions today since cpap-fitter has no destructive admin
   * routes, but exposed so the UI can render a role badge and so
   * future destructive operations can gate cleanly without a
   * second round-trip). Optional in the type because older API
   * builds may not include it; consumers should default to "admin"
   * to avoid silently downgrading real admins.
   */
  role?: "admin" | "agent";
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
  adminUserId: string;
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

// ---------- Reminders ----------

export interface AdminReminderItemView {
  sku: string;
  lastReplacedAt: string;
  intervalDays: number;
  nextDueAt: string;
}
export interface AdminReminderSubscriber {
  id: string;
  email: string;
  status: "active" | "unsubscribed";
  items: AdminReminderItemView[];
  itemCount: number;
  dueCount: number;
  lastSentAt: string | null;
  createdAt: string;
}
export interface AdminRemindersResponse {
  subscribers: AdminReminderSubscriber[];
  total: number;
}
export interface SendDueRemindersResponse {
  sent: number;
  skippedQuiet: number;
  skippedNoneDue: number;
  skippedNotConfigured: number;
  failed: number;
  errors: Array<{ id: string; error: string }>;
  candidateCount: number;
  sendgridConfigured: boolean;
}

export const fetchAdminReminders = () =>
  adminFetch<AdminRemindersResponse>("/admin/reminders");

/**
 * Generic mutation helper for non-GET admin calls. Mirrors
 * `adminFetch` but takes a method + optional JSON body and tolerates
 * a 204 (no body) response. Used by sendDueReminders and the team
 * routes below; centralizing here keeps credentials/Accept/error
 * semantics in one place.
 */
async function adminMutate<T>(
  path: string,
  method: "POST" | "PATCH" | "DELETE",
  body?: unknown,
): Promise<T> {
  const init: RequestInit = {
    method,
    credentials: "include",
    headers: {
      Accept: "application/json",
      ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
    },
  };
  if (body !== undefined) init.body = JSON.stringify(body);

  const res = await fetch(`${base}/api${path}`, init);
  if (!res.ok) {
    let payload: { error?: string } | null = null;
    try {
      payload = (await res.json()) as { error?: string };
    } catch {}
    throw new AdminApiError(res.status, payload);
  }
  if (res.status === 204) return undefined as unknown as T;
  return (await res.json()) as T;
}

export async function sendDueReminders(): Promise<SendDueRemindersResponse> {
  return adminMutate<SendDueRemindersResponse>(
    "/admin/reminders/send-due",
    "POST",
  );
}

// ---------- Team / users ----------

export type AdminTeamRole = "admin" | "agent";

export interface AdminTeamMember {
  id: string;
  email: string;
  name: string | null;
  role: AdminTeamRole;
  /** True for the row representing the currently signed-in admin. */
  isSelf: boolean;
  createdAt: number;
  lastSignInAt: number | null;
}

export interface AdminTeamPendingInvitation {
  id: string;
  email: string;
  role: AdminTeamRole;
  createdAt: number;
}

export interface AdminTeamResponse {
  /** Caller's own role — drives whether mutate buttons render. */
  role: AdminTeamRole;
  self: { email?: string; userId?: string };
  members: AdminTeamMember[];
  pendingInvitations: AdminTeamPendingInvitation[];
}

export const fetchAdminUsers = () =>
  adminFetch<AdminTeamResponse>("/admin/users");

export interface AdminInvitationCreated {
  id: string;
  email: string;
  role: AdminTeamRole;
  createdAt: number;
}

/**
 * Returned when the invite email already maps to a auth account
 * that has no `pennRole` yet. Rather than send a fresh invitation
 * (the auth provider would reject a duplicate identity, and a re-invite is the
 * wrong UX for someone who already has an account), the server
 * stamps `pennRole` on their existing user and reports back here.
 * The UI uses this to switch from "Invitation sent" → "Granted
 * access to existing account".
 */
export interface AdminInvitationAdopted {
  adopted: true;
  userId: string;
  email: string;
  role: AdminTeamRole;
}

export type AdminInvitationResult =
  | AdminInvitationCreated
  | AdminInvitationAdopted;

export const inviteAdminUser = (params: {
  email: string;
  role: AdminTeamRole;
}) =>
  adminMutate<AdminInvitationResult>(
    "/admin/users/invite",
    "POST",
    params,
  );

export const updateAdminUserRole = (params: {
  userId: string;
  role: AdminTeamRole;
}) =>
  adminMutate<{ ok: true; userId: string; role: AdminTeamRole }>(
    `/admin/users/${encodeURIComponent(params.userId)}/role`,
    "PATCH",
    { role: params.role },
  );

export const revokeAdminUser = (params: { userId: string }) =>
  adminMutate<{ ok: true; userId: string }>(
    `/admin/users/${encodeURIComponent(params.userId)}`,
    "DELETE",
  );

export const revokeAdminInvitation = (params: { invitationId: string }) =>
  adminMutate<{ ok: true; invitationId: string }>(
    `/admin/users/invitations/${encodeURIComponent(params.invitationId)}`,
    "DELETE",
  );

// =====================================================================
// Customer 360 — cross-API helpers (resupply-api, not api-server)
// =====================================================================
//
// These helpers call the resupply-api admin endpoints at
// `/resupply-api/admin/shop/customers/*` rather than `/api/admin/...`.
// resupply-api owns the shop tables (shop_customers, shop_orders,
// shop_subscriptions, shop_reviews, shop_abandoned_carts) and runs its
// own `requireAdmin` middleware (DB role on `auth.users.role`; the
// initial admin is bootstrapped separately via `auth:bootstrap-admin`).
//
// We deliberately don't add these to the resupply-api OpenAPI spec —
// no admin shop endpoint is in that spec today (see shop-orders,
// shop-reviews, shop-inventory consumed via raw fetch from
// resupply-dashboard). Keeping the convention consistent.
//
// Cross-API auth caveat: an admin signed in to cpap-fitter must also
// be granted admin/agent on the resupply-api side. The 403 we surface
// from resupply-api becomes an AdminApiError(403) here and the calling
// page renders a "grant this account admin access on the resupply API"
// hint.

async function resupplyAdminFetch<T>(path: string): Promise<T> {
  const res = await fetch(`${base}/resupply-api${path}`, {
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

async function resupplyAdminMutate<T>(
  path: string,
  method: "POST" | "PATCH" | "DELETE",
  body?: unknown,
): Promise<T> {
  const init: RequestInit = {
    method,
    credentials: "include",
    headers: {
      Accept: "application/json",
      ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
    },
  };
  if (body !== undefined) init.body = JSON.stringify(body);
  const res = await fetch(`${base}/resupply-api${path}`, init);
  if (!res.ok) {
    let payload: { error?: string } | null = null;
    try {
      payload = (await res.json()) as { error?: string };
    } catch {}
    throw new AdminApiError(res.status, payload);
  }
  if (res.status === 204) return undefined as unknown as T;
  return (await res.json()) as T;
}

export interface AdminCustomerSummary {
  userId: string;
  displayName: string | null;
  emailRedacted: string | null;
  stripeCustomerId: string | null;
  ordersCount: number;
  lifetimeValueCents: number;
  lastOrderAt: string | null;
  hasActiveSubscription: boolean;
  createdAt: string | null;
}

export interface AdminCustomersResponse {
  customers: AdminCustomerSummary[];
  total: number;
  page: number;
  pageSize: number;
}

export type AdminCustomerSortBy =
  | "lifetime_value"
  | "last_order"
  | "created_at";

export const fetchAdminCustomers = (params: {
  q?: string;
  page?: number;
  pageSize?: number;
  sortBy?: AdminCustomerSortBy;
  order?: "asc" | "desc";
  subscription?: "active" | "none";
}): Promise<AdminCustomersResponse> => {
  const usp = new URLSearchParams();
  if (params.q) usp.set("q", params.q);
  if (params.page) usp.set("page", String(params.page));
  if (params.pageSize) usp.set("pageSize", String(params.pageSize));
  if (params.sortBy) usp.set("sortBy", params.sortBy);
  if (params.order) usp.set("order", params.order);
  if (params.subscription) usp.set("subscription", params.subscription);
  const qs = usp.toString();
  return resupplyAdminFetch<AdminCustomersResponse>(
    `/admin/shop/customers${qs ? `?${qs}` : ""}`,
  );
};

export interface AdminCustomerShippingAddress {
  line1?: string | null;
  line2?: string | null;
  city?: string | null;
  state?: string | null;
  postalCode?: string | null;
  postal_code?: string | null;
  country?: string | null;
  name?: string | null;
}

export interface AdminCustomerProfile {
  userId: string;
  displayName: string | null;
  email: string | null;
  stripeCustomerId: string | null;
  shippingAddress: AdminCustomerShippingAddress | null;
  defaultPaymentMethod: {
    brand: string | null;
    last4: string | null;
    expMonth: number | null;
    expYear: number | null;
  } | null;
  createdAt: string;
  updatedAt: string;
  /**
   * True when this profile was synthesized from order rows because no
   * `shop_customers` mirror row exists for this userId (guest-only
   * checkout history). The detail page shows a small "Guest customer"
   * pill in this case.
   */
  isGuest: boolean;
}

export interface AdminCustomerOrderRow {
  id: string;
  stripeSessionId: string | null;
  stripePaymentIntentId: string | null;
  status: string;
  // Pending orders may not yet have an amount stamped by Stripe.
  // Frontend renders null as an em dash via fmtCents().
  amountTotalCents: number | null;
  currency: string | null;
  createdAt: string;
  paidAt: string | null;
  shippedAt: string | null;
  deliveredAt: string | null;
  trackingCarrier: string | null;
  trackingNumber: string | null;
  shippingAddress: unknown;
  itemCount: number;
}

export interface AdminCustomerSubscriptionRow {
  id: string;
  stripeSubscriptionId: string | null;
  stripeCustomerId: string | null;
  status: string;
  items: unknown[];
  currentPeriodEnd: string | null;
  cancelAtPeriodEnd: boolean | null;
  canceledAt: string | null;
  initialAmountTotalCents: number | null;
  createdAt: string;
  updatedAt: string;
}

export interface AdminCustomerAbandonedCart {
  id: string;
  items: unknown[];
  subtotalCents: number;
  currency: string | null;
  updatedAt: string;
  remindedAt: string | null;
  recoveredAt: string | null;
  clearedAt: string | null;
  createdAt: string;
}

export interface AdminCustomerReviewRow {
  id: string;
  productId: string | null;
  rating: number;
  title: string | null;
  body: string | null;
  status: string;
  moderationNote: string | null;
  moderatedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface AdminCustomerStats {
  ordersCount: number;
  lifetimeValueCents: number;
  avgOrderValueCents: number;
  firstOrderAt: string | null;
  lastOrderAt: string | null;
  pendingReviewsCount: number;
}

export interface AdminCustomerDetail {
  customer: AdminCustomerProfile;
  orders: AdminCustomerOrderRow[];
  subscriptions: AdminCustomerSubscriptionRow[];
  abandonedCart: AdminCustomerAbandonedCart | null;
  reviews: AdminCustomerReviewRow[];
  stats: AdminCustomerStats;
}

export const fetchAdminCustomer = (
  userId: string,
): Promise<AdminCustomerDetail> =>
  resupplyAdminFetch<AdminCustomerDetail>(
    `/admin/shop/customers/${encodeURIComponent(userId)}`,
  );

export interface AdminCustomerReorderResponse {
  checkoutUrl: string;
  sessionId: string;
  expiresAt: string | null;
}

export const reorderForCustomer = (params: {
  userId: string;
  sourceOrderId: string;
}): Promise<AdminCustomerReorderResponse> =>
  resupplyAdminMutate<AdminCustomerReorderResponse>(
    `/admin/shop/customers/${encodeURIComponent(params.userId)}/reorder`,
    "POST",
    { sourceOrderId: params.sourceOrderId },
  );
