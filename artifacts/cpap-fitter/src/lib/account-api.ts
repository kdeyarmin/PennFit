// Tiny typed client for /shop/me/* endpoints. Mirrors lib/shop-api.ts
// but for the auth-gated routes — uses `credentials: "include"` so the
// session cookie travels along.
//
// Why a separate file (not bolted onto shop-api.ts): the public shop
// catalog is callable WITHOUT auth and the components that consume it
// shouldn't have to think about the auth provider. The /shop/me/* surface is
// fundamentally different (auth-required, returns user-scoped data)
// and benefits from its own narrower set of types + error handling.

export interface SavedShippingAddress {
  line1: string;
  line2?: string | null;
  city: string;
  state: string;
  postalCode: string;
  country: "US";
}

export interface SavedCard {
  brand: string | null;
  last4: string | null;
  expMonth: number | null;
  expYear: number | null;
}

/**
 * The customer's CPAP machine, captured on /account so the
 * storefront and customer-service team don't have to ask for it
 * every time. Stored server-side as JSONB on `shop_customers`;
 * see `lib/resupply-db/src/schema/shop-customers.ts`.
 */
export interface CpapDeviceInfo {
  manufacturer: string;
  model: string;
  serialNumber?: string | null;
  pressureSetting?: string | null;
  humidifierSetting?: string | null;
  notes?: string | null;
}

/**
 * The customer's prescribing physician — PHI when bound to the
 * customer's identity. Server audit-logs every write.
 */
export interface PhysicianInfo {
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
  /** 10-digit National Provider Identifier. */
  npi?: string | null;
}

export interface ShopMeProfile {
  customerId: string;
  email: string | null;
  displayName: string | null;
  shippingAddress: SavedShippingAddress | null;
  cpapDevice: CpapDeviceInfo | null;
  physicianInfo: PhysicianInfo | null;
}

export interface ShopRecentOrder {
  id: string;
  sessionId: string;
  status: string;
  amountTotalCents: number | null;
  currency: string | null;
  createdAt: string;
}

export interface ShopMeResponse {
  signedIn: boolean;
  profile?: ShopMeProfile;
  savedCard?: SavedCard | null;
  recentOrders?: ShopRecentOrder[];
}

export class AccountApiError extends Error {
  constructor(
    public status: number,
    public payload: { error?: string; message?: string } | null,
  ) {
    super(payload?.message ?? payload?.error ?? `Account API error ${status}`);
  }
}

async function meFetch<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(`/resupply-api${path}`, {
    credentials: "include",
    headers: {
      Accept: "application/json",
      ...(init.body ? { "Content-Type": "application/json" } : {}),
      ...(init.headers ?? {}),
    },
    ...init,
  });
  if (!res.ok) {
    let body: { error?: string; message?: string } | null = null;
    try {
      body = (await res.json()) as { error?: string; message?: string };
    } catch {
      // ignore parse error
    }
    throw new AccountApiError(res.status, body);
  }
  return (await res.json()) as T;
}

export const fetchShopMe = () => meFetch<ShopMeResponse>("/shop/me");

export const updateShopMe = (input: {
  displayName?: string | null;
  shippingAddress?: SavedShippingAddress | null;
}) =>
  meFetch<{ profile: ShopMeProfile }>("/shop/me", {
    method: "PUT",
    body: JSON.stringify(input),
  });

/**
 * Clinical info — CPAP device + prescribing physician — split out
 * from the main /shop/me payload so the account-page sub-section
 * can fetch and persist independently. The API returns BOTH fields
 * on every call (each may be null when the customer hasn't filled
 * the form out yet).
 */
export interface ShopClinicalInfoResponse {
  cpapDevice: CpapDeviceInfo | null;
  physicianInfo: PhysicianInfo | null;
}

export const fetchShopClinicalInfo = () =>
  meFetch<ShopClinicalInfoResponse>("/shop/me/clinical-info");

/**
 * Update CPAP device and/or prescribing-physician info.
 *
 *   - Omit a field to leave it unchanged.
 *   - Pass `null` to clear it.
 *   - Pass an object to replace it.
 *
 * The server validates the shape with Zod and audit-logs every
 * successful mutation with non-PHI metadata only.
 */
export const updateShopClinicalInfo = (input: {
  cpapDevice?: CpapDeviceInfo | null;
  physicianInfo?: PhysicianInfo | null;
}) =>
  meFetch<ShopClinicalInfoResponse>("/shop/me/clinical-info", {
    method: "PUT",
    body: JSON.stringify(input),
  });

export interface ShopMyOrdersResponse {
  orders: Array<ShopRecentOrder & { paidAt: string | null }>;
}
export const fetchShopMyOrders = () =>
  meFetch<ShopMyOrdersResponse>("/shop/me/orders");

export interface QuickCheckoutInput {
  items?: Array<{
    priceId: string;
    quantity: number;
    /** "subscription" routes the line through Stripe Subscriptions. */
    mode?: "one_time" | "subscription";
  }>;
  reorderSessionId?: string;
  successPath?: string;
  cancelPath?: string;
}

/**
 * Subscribe & Save — patient-managed auto-ship subscriptions.
 * Mirror of the Stripe-backed shop_subscriptions table.
 */
export interface ShopSubscriptionItemView {
  priceId: string;
  productId: string | null;
  quantity: number;
  name: string | null;
  unitAmountCents: number | null;
  currency: string | null;
  intervalLabel: string | null;
}
export interface ShopSubscriptionView {
  id: string;
  stripeSubscriptionId: string;
  /**
   * Mirrors Stripe's subscription status: active, past_due, unpaid,
   * canceled, incomplete, incomplete_expired, trialing, paused.
   */
  status: string;
  items: ShopSubscriptionItemView[];
  /** ISO 8601 string. */
  currentPeriodEnd: string | null;
  cancelAtPeriodEnd: boolean;
  /** ISO 8601 string. */
  canceledAt: string | null;
  createdAt: string;
}
export interface ShopSubscriptionsResponse {
  subscriptions: ShopSubscriptionView[];
}
export const fetchShopMySubscriptions = () =>
  meFetch<ShopSubscriptionsResponse>("/shop/me/subscriptions");

export const cancelShopSubscription = (id: string) =>
  meFetch<{ ok: true; alreadyCanceled?: boolean }>(
    `/shop/me/subscriptions/${encodeURIComponent(id)}/cancel`,
    { method: "POST" },
  );

/**
 * T-C5 — pause / resume / cadence change.
 *
 * `pause` and `resume` mirror Stripe's `pause_collection` field. We
 * don't track paused state in our local schema yet (no-schema slice),
 * so the UI shows BOTH options whenever the subscription is active
 * and not pending cancellation. Both endpoints are idempotent server-
 * side; clicking the wrong one returns 200 without making a no-op
 * Stripe round-trip needlessly visible to the patient.
 */
export const pauseShopSubscription = (id: string) =>
  meFetch<{ ok: true }>(
    `/shop/me/subscriptions/${encodeURIComponent(id)}/pause`,
    { method: "POST" },
  );

export const resumeShopSubscription = (id: string) =>
  meFetch<{ ok: true }>(
    `/shop/me/subscriptions/${encodeURIComponent(id)}/resume`,
    { method: "POST" },
  );

export interface ShopCadenceOption {
  priceId: string;
  intervalLabel: string;
  unitAmountCents: number | null;
  currency: string | null;
  isCurrent: boolean;
}
export interface ShopCadenceOptionsResponse {
  options: ShopCadenceOption[];
}
export const fetchShopCadenceOptions = (id: string) =>
  meFetch<ShopCadenceOptionsResponse>(
    `/shop/me/subscriptions/${encodeURIComponent(id)}/cadence-options`,
  );

export const changeShopSubscriptionCadence = (id: string, priceId: string) =>
  meFetch<{ ok: true; unchanged?: boolean }>(
    `/shop/me/subscriptions/${encodeURIComponent(id)}/cadence`,
    { method: "POST", body: JSON.stringify({ priceId }) },
  );

export const startQuickCheckout = (input: QuickCheckoutInput) =>
  meFetch<{ url: string; sessionId: string }>("/shop/me/quick-checkout", {
    method: "POST",
    headers: { "Idempotency-Key": crypto.randomUUID() },
    body: JSON.stringify(input),
  });

/**
 * Aggregated status digest powering the signed-in home banner.
 * One round-trip across orders + subscriptions + abandoned cart.
 */
export interface ShopMeDashboardResponse {
  nextShipment: {
    subscriptionId: string;
    /** ISO 8601 string. */
    date: string;
    firstItemName: string | null;
    cancelAtPeriodEnd: boolean;
  } | null;
  latestOrder: {
    id: string;
    sessionId: string;
    paidAt: string | null;
    shippedAt: string | null;
    deliveredAt: string | null;
    trackingCarrier: string | null;
    trackingNumber: string | null;
  } | null;
  activeSubscriptions: number;
  pendingOrders: number;
  abandonedCart: {
    itemCount: number;
    updatedAt: string;
  } | null;
}

export const fetchShopMeDashboard = () =>
  meFetch<ShopMeDashboardResponse>("/shop/me/dashboard");

export interface CommunicationPreferences {
  emailMarketing: boolean;
  emailResupplyReminders: boolean;
  emailAbandonedCart: boolean;
  emailReviewRequests: boolean;
  smsMarketing: boolean;
  smsTransactional: boolean;
  preferredChannel: "email" | "sms";
  dndStartHour: number | null;
  dndEndHour: number | null;
  timezone: string | null;
}

export const fetchCommPrefs = () =>
  meFetch<{ preferences: CommunicationPreferences }>("/shop/me/comm-prefs");

export const updateCommPrefs = (input: Partial<CommunicationPreferences>) =>
  meFetch<{ preferences: CommunicationPreferences }>("/shop/me/comm-prefs", {
    method: "PUT",
    body: JSON.stringify(input),
  });

/**
 * In-account customer ↔ CSR messaging — Phase 2 of the account
 * messaging foundation. Server-side these are stored in the same
 * `conversations` + `messages` tables that the resupply patient
 * flow uses, on the new `in_app` channel introduced in
 * migration 0033. The customer's view here is intentionally narrow:
 * one thread per customer, append-only history, simple compose.
 */
export interface AccountMessage {
  id: string;
  direction: "inbound" | "outbound";
  /**
   * Who sent the message:
   *   "customer" — the signed-in shopper (this user)
   *   "admin"    — full admin role at PennPaps
   *   "agent"    — limited customer-service-agent role at PennPaps
   *   "system"   — automated event marker
   */
  senderRole: "customer" | "admin" | "agent" | "system";
  body: string;
  /** ISO 8601 string. */
  createdAt: string;
  /** Always null for in-app channel; included for shape symmetry. */
  deliveryStatus: string | null;
}

export interface AccountThread {
  id: string;
  status: "open" | "awaiting_patient" | "awaiting_admin" | "closed";
  /** ISO 8601 string. Null when the thread has no messages yet. */
  lastMessageAt: string | null;
  /** ISO 8601 string. */
  createdAt: string;
}

export interface ShopMessagesResponse {
  thread: AccountThread | null;
  messages: AccountMessage[];
}

export const fetchShopMessages = () =>
  meFetch<ShopMessagesResponse>("/shop/me/messages");

export interface ShopMessagePostResponse {
  threadId: string;
  messageId: string;
  threadCreated: boolean;
}

export const postShopMessage = (body: string) =>
  meFetch<ShopMessagePostResponse>("/shop/me/messages", {
    method: "POST",
    body: JSON.stringify({ body }),
  });

export interface ReorderSuggestion {
  productId: string;
  productName: string;
  category: string;
  imageUrl: string | null;
  cadenceDays: number;
  lastPaidAt: string;
  ageDays: number;
  dueOn: string;
  status: "overdue" | "due_soon";
  totalQuantityHistorical: number;
}

export const fetchReorderSuggestions = () =>
  meFetch<{ suggestions: ReorderSuggestion[]; previewMode?: boolean }>(
    "/shop/me/reorder-suggestions",
  );
