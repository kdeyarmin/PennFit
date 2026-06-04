// Hand-rolled fetch wrappers for the admin customers endpoints.
//
// Same rationale as insurance-leads-api / shop-reviews-api: the
// surface isn't in the OpenAPI spec yet, and the type shapes are
// small enough that hand-rolling stays readable.
//
// Auth: the browser sends the `pf_session` cookie automatically on
// same-origin requests, so no per-call auth header is needed.

import { ApiError } from "@workspace/api-client-react/admin";

export interface AdminCustomerSavedAddress {
  line1: string;
  line2?: string | null;
  city: string;
  state: string;
  postalCode: string;
  country: "US";
}

export interface AdminCustomerCpapDevice {
  manufacturer: string;
  model: string;
  serialNumber?: string | null;
  pressureSetting?: string | null;
  humidifierSetting?: string | null;
  notes?: string | null;
}

export interface AdminCustomerPhysicianInfo {
  name: string;
  practice?: string | null;
  phone?: string | null;
  fax?: string | null;
  email?: string | null;
  addressLine1?: string | null;
  addressLine2?: string | null;
  city?: string | null;
  state?: string | null;
  postalCode?: string | null;
  npi?: string | null;
}

export interface AdminCustomerFacialMeasurements {
  noseWidth: number;
  noseHeight: number;
  noseToChin: number;
  mouthWidth: number;
  faceWidthAtCheekbones: number;
  calibrationMethod: "iris" | "manual_card";
  capturedAt: string;
}

export interface AdminCustomerClinicalInfo {
  cpapDevice: AdminCustomerCpapDevice | null;
  physicianInfo: AdminCustomerPhysicianInfo | null;
  /**
   * Latest on-device fitter scan for this customer. Null until the
   * customer completes a fitting tied to their signed-in account.
   * See migration 0066.
   */
  facialMeasurements: AdminCustomerFacialMeasurements | null;
}

export interface AdminCustomerCard {
  brand: string | null;
  last4: string | null;
  expMonth: number | null;
  expYear: number | null;
}

export interface AdminCustomerProfile {
  userId: string;
  displayName: string | null;
  email: string | null;
  stripeCustomerId: string | null;
  shippingAddress: AdminCustomerSavedAddress | null;
  defaultPaymentMethod: AdminCustomerCard | null;
  clinicalInfo: AdminCustomerClinicalInfo;
  createdAt: string;
  updatedAt: string;
  isGuest: boolean;
  /**
   * The clinical patient that shares this customer's portal login
   * (patients.portal_auth_user_id === shop_customers.auth_user_id), or
   * null when there's no match. Drives the "view patient record" jump.
   */
  linkedPatientId: string | null;
}

export interface AdminCustomerOrder {
  id: string;
  stripeSessionId: string;
  stripePaymentIntentId: string | null;
  status: string;
  amountTotalCents: number | null;
  currency: string | null;
  createdAt: string;
  paidAt: string | null;
  shippedAt: string | null;
  deliveredAt: string | null;
  trackingCarrier: string | null;
  trackingNumber: string | null;
  shippingAddress: AdminCustomerSavedAddress | null;
  itemCount: number;
}

export interface AdminCustomerSubscription {
  id: string;
  stripeSubscriptionId: string;
  stripeCustomerId: string | null;
  status: string;
  items: Array<{
    priceId: string;
    quantity: number;
    productId?: string | null;
  }>;
  currentPeriodEnd: string | null;
  cancelAtPeriodEnd: boolean;
  canceledAt: string | null;
  initialAmountTotalCents: number | null;
  createdAt: string;
  updatedAt: string;
}

export interface AdminCustomerInAppConversation {
  id: string;
  status: "open" | "awaiting_patient" | "awaiting_admin" | "closed";
  messageCount: number;
  /**
   * Number of inbound customer messages that arrived AFTER the most
   * recent CSR reply (or every inbound message when there's no CSR
   * reply yet). Drives the "X new from customer" badge.
   */
  unreadFromCustomer: number;
  lastMessageAt: string | null;
  lastInboundAt: string | null;
  lastOutboundAt: string | null;
  createdAt: string;
}

export interface AdminCustomerStats {
  ordersCount: number;
  lifetimeValueCents: number;
  avgOrderValueCents: number;
  firstOrderAt: string | null;
  lastOrderAt: string | null;
  pendingReviewsCount: number;
}

export interface AdminCustomerDetailResponse {
  customer: AdminCustomerProfile;
  orders: AdminCustomerOrder[];
  subscriptions: AdminCustomerSubscription[];
  abandonedCart: {
    id: string;
    items: Array<{ priceId: string; quantity: number }>;
    subtotalCents: number;
    currency: string;
    updatedAt: string;
    remindedAt: string | null;
    recoveredAt: string | null;
    clearedAt: string | null;
    createdAt: string;
  } | null;
  reviews: Array<{
    id: string;
    productId: string;
    rating: number;
    title: string | null;
    body: string;
    status: string;
    moderationNote: string | null;
    moderatedAt: string | null;
    createdAt: string;
    updatedAt: string;
  }>;
  stats: AdminCustomerStats;
  inAppConversation: AdminCustomerInAppConversation | null;
}

export class AdminCustomerNotFoundError extends Error {
  constructor() {
    super("Customer not found.");
  }
}

// =====================================================================
// List endpoint (paginated directory)
// =====================================================================

/**
 * Each row carries a redacted email (e.g. "ja******@example.com")
 * NOT the full address — the directory view is intentionally
 * read-light. The full email comes from the detail endpoint.
 */
export interface AdminCustomerListRow {
  userId: string;
  displayName: string | null;
  emailRedacted: string | null;
  stripeCustomerId: string | null;
  ordersCount: number;
  lifetimeValueCents: number;
  lastOrderAt: string | null;
  hasActiveSubscription: boolean;
  /**
   * Phase 9: true when the customer's in-app conversation is in
   * `awaiting_admin` status — i.e. a CSR owes them a reply. Drives
   * the "Awaiting reply" badge on the directory.
   * Optional + nullable so older clients hitting an upgraded server
   * don't crash if the field is missing.
   */
  inAppNeedsReply?: boolean;
  createdAt: string;
}

export type AdminCustomerListSortBy =
  | "last_order"
  | "lifetime_value"
  | "created_at";

export interface AdminCustomerListInput {
  q?: string;
  page?: number;
  pageSize?: number;
  sortBy?: AdminCustomerListSortBy;
  order?: "asc" | "desc";
  /**
   * `'active'` → only customers with at least one active subscription.
   * `'none'`   → only customers with no active subscription.
   * undefined  → both.
   */
  subscription?: "active" | "none";
  /**
   * Phase 9: when true, restrict to customers whose in-app
   * conversation is currently in `awaiting_admin` status. Surfaces
   * as `?awaitingReply=1` on the wire.
   */
  awaitingReply?: boolean;
}

export interface AdminCustomerListResponse {
  customers: AdminCustomerListRow[];
  total: number;
  page: number;
  pageSize: number;
}

export async function listAdminCustomers(
  input: AdminCustomerListInput = {},
): Promise<AdminCustomerListResponse> {
  const qs = new URLSearchParams();
  if (input.q) qs.set("q", input.q);
  if (input.page) qs.set("page", String(input.page));
  if (input.pageSize) qs.set("pageSize", String(input.pageSize));
  if (input.sortBy) qs.set("sortBy", input.sortBy);
  if (input.order) qs.set("order", input.order);
  if (input.subscription) qs.set("subscription", input.subscription);
  if (input.awaitingReply) qs.set("awaitingReply", "1");
  const suffix = qs.toString();
  const res = await fetch(
    `/resupply-api/admin/shop/customers${suffix ? `?${suffix}` : ""}`,
    {
      headers: { Accept: "application/json" },
    },
  );
  if (!res.ok) {
    let data: unknown = null;
    try {
      data = await res.json();
    } catch {
      // non-JSON error body — status alone is enough
    }
    throw new ApiError(res, data, { method: "GET", url: res.url });
  }
  return (await res.json()) as AdminCustomerListResponse;
}

// =====================================================================
// Detail endpoint (single customer)
// =====================================================================

export async function getAdminCustomerDetail(
  userId: string,
): Promise<AdminCustomerDetailResponse> {
  const res = await fetch(
    `/resupply-api/admin/shop/customers/${encodeURIComponent(userId)}`,
    {
      headers: { Accept: "application/json" },
    },
  );
  if (res.status === 404) {
    throw new AdminCustomerNotFoundError();
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
  return (await res.json()) as AdminCustomerDetailResponse;
}
