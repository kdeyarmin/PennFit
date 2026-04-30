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

export interface ShopMeProfile {
  clerkUserId: string;
  email: string | null;
  displayName: string | null;
  shippingAddress: SavedShippingAddress | null;
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

async function meFetch<T>(
  path: string,
  init: RequestInit = {},
): Promise<T> {
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
