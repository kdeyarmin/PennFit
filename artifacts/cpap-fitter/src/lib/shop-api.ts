// Tiny typed client for the public shop endpoints exposed by
// resupply-api. Cross-artifact calls go through the shared reverse
// proxy at root, so the absolute path `/resupply-api/...` is the
// correct way to reach the API from the cpap-fitter web app — no
// custom Vite proxy or env-var base URL needed (see pnpm-workspace
// skill for routing rules).
//
// We hand-roll fetch here (instead of pulling in the resupply-api
// generated React Query client) because the shop is the only public
// surface that crosses artifact boundaries; adding a workspace dep
// just for three endpoints would be more weight than three small
// typed wrappers.

export interface ShopProductView {
  id: string;
  name: string;
  description: string | null;
  category:
    | "mask"
    | "cushion"
    | "tubing"
    | "filter"
    | "headgear"
    | "chamber"
    | "accessory"
    | "bundle";
  tagline: string | null;
  isBundle: boolean;
  bundleContents: string[];
  replacementHint: string | null;
  imageUrl: string | null;
  /** Manufacturer brand, e.g. "ResMed". From product metadata. */
  manufacturer: string | null;
  /** Manufacturer model / part number, e.g. "62932". From product metadata. */
  modelNumber: string | null;
  price: {
    id: string;
    unitAmount: number;
    currency: string;
  };
  /**
   * Optional recurring (subscription) price for this product. When
   * present, the shop UI surfaces a "Subscribe & ship" toggle. v1
   * policy: same unit_amount as one-time — convenience, not savings.
   */
  recurringPrice: {
    id: string;
    unitAmount: number;
    currency: string;
    interval: "day" | "week" | "month" | "year";
    intervalCount: number;
    /** Pre-rendered label like "month" or "3 months". */
    intervalLabel: string;
  } | null;
  /**
   * Stripe-tracked stock count for one-time purchases.
   *   * `null` → SKU is **not** stock-tracked. Treat as available.
   *   * `0`    → out of stock; one-time purchase disabled.
   *   * `1..N` → "Only N left" hint, where N = `lowStockThreshold`.
   *   * `>N`   → no UI affordance; treat as plenty.
   * Subscriptions ignore this — auto-ship inventory is reconciled
   * by the fulfilment workflow weekly, not at the storefront.
   * Source of truth: Stripe `product.metadata.stock_count`.
   */
  stockCount: number | null;
  /**
   * Per-SKU "low stock" threshold. The "Only N left" badge fires
   * when `stockCount > 0 && stockCount <= lowStockThreshold`. When
   * `null`, the storefront falls back to a default of 5 — preserving
   * v1 behavior for SKUs the admin hasn't customized.
   * Source of truth: Stripe `product.metadata.low_stock_threshold`.
   */
  lowStockThreshold: number | null;
}

// Default threshold used when a SKU has no per-product
// `lowStockThreshold` set. Mirrors the v1 hardcoded behavior so
// existing SKUs render identically to before A15.
export const DEFAULT_LOW_STOCK_THRESHOLD = 5;

/**
 * Resolve a product `imageUrl` returned by the API into something the
 * `<img>` tag can render. The API returns either:
 *   - an absolute https URL (production: Stripe CDN), or
 *   - a path relative to the cpap-fitter base, e.g. "/products/foo.webp"
 *     (preview catalog, served out of the cpap-fitter `public/` dir).
 *
 * For the relative case we prepend `import.meta.env.BASE_URL` so the
 * image works correctly when the app is mounted under a path prefix
 * (e.g. `/cpap-fitter/`).
 */
export function resolveProductImage(imageUrl: string | null): string | null {
  if (!imageUrl) return null;
  if (/^https?:\/\//i.test(imageUrl) || imageUrl.startsWith("data:")) {
    return imageUrl;
  }
  const base = import.meta.env.BASE_URL || "/";
  const baseWithSlash = base.endsWith("/") ? base : `${base}/`;
  const trimmed = imageUrl.replace(/^\/+/, "");
  return `${baseWithSlash}${trimmed}`;
}

export interface ShopProductsResponse {
  /**
   * `true` when the API is serving the built-in preview catalog
   * because Stripe isn't configured in this environment. The shop UI
   * renders normally but checkout is disabled. See
   * resupply-api/src/lib/stripe/preview-catalog.ts.
   */
  previewMode: boolean;
  categories: readonly ShopProductView["category"][];
  products: ShopProductView[];
  byCategory: Record<ShopProductView["category"], ShopProductView[]>;
}

export interface ShopUnavailable {
  unavailable: true;
  message: string;
}

export type ShopProductsResult = ShopProductsResponse | ShopUnavailable;

export async function fetchShopProducts(): Promise<ShopProductsResult> {
  const res = await fetch("/resupply-api/shop/products", {
    headers: { Accept: "application/json" },
  });
  if (res.status === 503) {
    const body = (await res.json().catch(() => ({}))) as {
      message?: string;
    };
    return {
      unavailable: true,
      message:
        body.message ??
        "The shop isn't available right now. Please check back soon.",
    };
  }
  if (!res.ok) {
    throw new Error(`Failed to load shop products (${res.status})`);
  }
  // Older API versions didn't include `previewMode`; default to false
  // so the cart never falsely disables checkout when talking to a
  // legacy server.
  const json = (await res.json()) as Partial<ShopProductsResponse>;
  return {
    previewMode: json.previewMode ?? false,
    categories: json.categories ?? [],
    products: json.products ?? [],
    byCategory:
      json.byCategory ??
      ({} as Record<ShopProductView["category"], ShopProductView[]>),
  };
}

export interface CheckoutItem {
  priceId: string;
  quantity: number;
  /**
   * "subscription" → recurring line item; "one_time" (default) →
   * invoice line. When ANY item carries "subscription", the API
   * builds the Session in subscription mode (Stripe supports mixed
   * recurring + one-time line items in subscription mode).
   */
  mode?: "one_time" | "subscription";
}

function getCsrfToken(): string | null {
  if (typeof document === "undefined") return null;
  const match = document.cookie
    .split("; ")
    .find((row) => row.startsWith("pf_csrf="));
  return match ? decodeURIComponent(match.split("=")[1]) : null;
}

// Spread into a fetch() `headers` object on every state-changing call
// so the server can verify the double-submit CSRF token. When the
// cookie is missing (unauthenticated visitor, SSR, tests) we omit the
// header rather than send an empty value — the server rejects empty
// tokens, so an explicit absence is clearer.
function csrfHeader(): Record<string, string> {
  const token = getCsrfToken();
  return token ? { "X-PF-CSRF": token } : {};
}

export async function startCheckout(
  items: CheckoutItem[],
  options?: { successPath?: string; cancelPath?: string },
): Promise<{ url: string; sessionId: string }> {
  // Per-attempt idempotency key — re-clicking "Checkout" within a
  // few seconds will hit Stripe's idempotency cache and reuse the
  // same Session URL instead of creating a duplicate.
  const idempotencyKey = crypto.randomUUID();
  const res = await fetch("/resupply-api/shop/checkout", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Idempotency-Key": idempotencyKey,
      ...csrfHeader(),
    },
    body: JSON.stringify({
      items,
      successPath: options?.successPath,
      cancelPath: options?.cancelPath,
    }),
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { message?: string };
    throw new Error(body.message ?? `Couldn't start checkout (${res.status})`);
  }
  return (await res.json()) as { url: string; sessionId: string };
}

export interface OrderSummaryResponse {
  sessionId: string;
  status: string;
  paymentStatus: string | null;
  amountTotalCents: number | null;
  currency: string | null;
  lineItems: Array<{
    name: string;
    quantity: number;
    amountSubtotalCents: number | null;
    // Reorder fields — needed so the /account "Buy this again" flow
    // can rebuild a cart from a past order. `priceId` is null for
    // historical edge cases (e.g. one-off custom prices); the client
    // filters those out before populating the cart.
    priceId: string | null;
    productId: string | null;
    unitAmountCents: number | null;
    imageUrl: string | null;
  }>;
  shippingCity: string | null;
  shippingState: string | null;
}

export async function fetchOrderSummary(
  sessionId: string,
): Promise<OrderSummaryResponse> {
  const res = await fetch(
    `/resupply-api/shop/orders/${encodeURIComponent(sessionId)}`,
    { headers: { Accept: "application/json" } },
  );
  if (!res.ok) {
    throw new Error(`Failed to load order (${res.status})`);
  }
  return (await res.json()) as OrderSummaryResponse;
}

// ───────────────────────────────────────────────────────────────── reviews

export interface ReviewItem {
  id: string;
  rating: 1 | 2 | 3 | 4 | 5;
  title: string | null;
  body: string;
  authorDisplayName: string;
  createdAt: string;
  /**
   * True iff the API found a paid `shop_order_items` row matching
   * this review's customerId + productId. Server-computed — the
   * client can render a "Verified purchaser" pill but never decide
   * the bit on its own. Older API versions may omit the field;
   * absent is treated as `false` by the UI.
   */
  verifiedPurchaser?: boolean;
}

export interface ReviewAggregate {
  count: number;
  averageRating: number;
  distribution: Record<"1" | "2" | "3" | "4" | "5", number>;
}

export interface ReviewListResponse {
  items: ReviewItem[];
  nextCursor: string | null;
  aggregate: ReviewAggregate;
}

export interface ReviewBulkAggregateResponse {
  /** Always populated for every requested productId (zeros if none). */
  aggregates: Record<string, { count: number; averageRating: number }>;
}

export interface MyReview {
  id: string;
  rating: 1 | 2 | 3 | 4 | 5;
  title: string | null;
  body: string;
  status: "pending" | "approved" | "rejected";
  moderationNote: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ReviewWritePayload {
  rating: 1 | 2 | 3 | 4 | 5;
  title: string | null;
  body: string;
}

export async function fetchProductReviews(
  productId: string,
  opts?: { cursor?: string; limit?: number },
): Promise<ReviewListResponse> {
  const params = new URLSearchParams();
  if (opts?.cursor) params.set("cursor", opts.cursor);
  if (opts?.limit) params.set("limit", String(opts.limit));
  const qs = params.toString() ? `?${params.toString()}` : "";
  const res = await fetch(
    `/resupply-api/shop/products/${encodeURIComponent(productId)}/reviews${qs}`,
    { headers: { Accept: "application/json" } },
  );
  if (!res.ok) throw new Error(`Failed to load reviews (${res.status})`);
  return (await res.json()) as ReviewListResponse;
}

export async function fetchReviewAggregates(
  productIds: string[],
): Promise<ReviewBulkAggregateResponse> {
  if (productIds.length === 0) return { aggregates: {} };
  // Endpoint caps at 50 ids per call. Slice the request just in case
  // a future shop page exceeds that — the caller can chunk further.
  const capped = productIds.slice(0, 50);
  const res = await fetch(
    `/resupply-api/shop/products/reviews/aggregates?productIds=${encodeURIComponent(capped.join(","))}`,
    { headers: { Accept: "application/json" } },
  );
  if (!res.ok) throw new Error(`Failed to load aggregates (${res.status})`);
  return (await res.json()) as ReviewBulkAggregateResponse;
}

export async function fetchMyReview(
  productId: string,
): Promise<MyReview | null> {
  const headers = { Accept: "application/json" };
  const res = await fetch(
    `/resupply-api/shop/me/reviews/${encodeURIComponent(productId)}`,
    { headers },
  );
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`Failed to load your review (${res.status})`);
  return (await res.json()) as MyReview;
}

/**
 * Result of a write-review POST. Distinguishes "you already have one"
 * from a generic failure so the form can swap into edit mode.
 */
export type WriteReviewResult =
  | { ok: true; review: MyReview }
  | { ok: false; alreadyReviewed: true }
  | { ok: false; error: string };

export async function submitReview(
  productId: string,
  payload: ReviewWritePayload,
): Promise<WriteReviewResult> {
  const headers = {
    Accept: "application/json",
    "Content-Type": "application/json",
    ...csrfHeader(),
  };
  const res = await fetch(
    `/resupply-api/shop/products/${encodeURIComponent(productId)}/reviews`,
    {
      method: "POST",
      headers,
      body: JSON.stringify(payload),
    },
  );
  if (res.status === 409) return { ok: false, alreadyReviewed: true };
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    return {
      ok: false,
      error: body.error ?? `Couldn't post review (${res.status})`,
    };
  }
  const created = (await res.json()) as MyReview;
  return { ok: true, review: created };
}

export async function updateMyReview(
  productId: string,
  payload: ReviewWritePayload,
): Promise<MyReview> {
  const headers = {
    Accept: "application/json",
    "Content-Type": "application/json",
    ...csrfHeader(),
  };
  const res = await fetch(
    `/resupply-api/shop/me/reviews/${encodeURIComponent(productId)}`,
    {
      method: "PATCH",
      headers,
      body: JSON.stringify(payload),
    },
  );
  if (!res.ok) throw new Error(`Failed to update review (${res.status})`);
  return (await res.json()) as MyReview;
}

export async function deleteMyReview(productId: string): Promise<void> {
  const headers = {
    Accept: "application/json",
    ...csrfHeader(),
  };
  const res = await fetch(
    `/resupply-api/shop/me/reviews/${encodeURIComponent(productId)}`,
    { method: "DELETE", headers },
  );
  if (!res.ok) throw new Error(`Failed to delete review (${res.status})`);
}

// ──────────────────────────────────────────────────────────── order history

export interface OrderHistoryLineItem {
  productId: string;
  /**
   * Display name. Server tries Stripe in bulk and falls back to
   * `Product <id-prefix>` when Stripe is offline or the SKU has been
   * retired. Always populated.
   */
  productName: string;
  quantity: number;
  unitAmountCents: number | null;
  currency: string | null;
}

/**
 * Per-order shipping address snapshot. Captured by the webhook at
 * paid time from Stripe Checkout (or written by the customer via
 * `updateOrderShippingAddress` while shipped_at IS NULL). Older orders
 * — paid before migration 0014 — return `null`.
 */
export interface OrderShippingAddress {
  line1: string;
  line2: string | null;
  city: string;
  state: string;
  postalCode: string;
  country: "US";
}

/** Tracking projection (W3 T-C6). Server computes the carrier-specific URL. */
export interface OrderTracking {
  carrier: string;
  number: string;
  /** Pre-computed tracking URL; null when the carrier isn't recognised. */
  url: string | null;
}

export interface OrderHistoryItem {
  id: string;
  sessionId: string;
  status: "paid";
  amountTotalCents: number | null;
  currency: string | null;
  createdAt: string;
  paidAt: string | null;
  /** Snapshot at paid-time. May be null for orders paid pre-migration-0014. */
  shippingAddress: OrderShippingAddress | null;
  /** null until the admin enters tracking. */
  tracking: OrderTracking | null;
  shippedAt: string | null;
  deliveredAt: string | null;
  /**
   * Server-side hint: customer is allowed to PATCH the shipping
   * address only while the parcel hasn't shipped. The server
   * re-validates this on write (a stale `true` is harmless).
   */
  canEditAddress: boolean;
  items: OrderHistoryLineItem[];
}

export interface OrderHistoryResponse {
  orders: OrderHistoryItem[];
  /** Composite `paidAt|id` cursor; null when there are no more pages. */
  nextCursor: string | null;
}

/**
 * Paginated order history for the signed-in caller. Newest first.
 * Throws on 401 — the caller is expected to gate the page behind a
 * the auth provider's `<SignedIn>` so this only fires for authenticated sessions.
 */
export async function fetchMyOrders(opts?: {
  cursor?: string;
  limit?: number;
}): Promise<OrderHistoryResponse> {
  const params = new URLSearchParams();
  if (opts?.cursor) params.set("cursor", opts.cursor);
  if (opts?.limit) params.set("limit", String(opts.limit));
  const qs = params.toString() ? `?${params.toString()}` : "";
  const headers = { Accept: "application/json" };
  const res = await fetch(`/resupply-api/shop/me/orders${qs}`, { headers });
  if (!res.ok) {
    throw new Error(`Failed to load your orders (${res.status})`);
  }
  return (await res.json()) as OrderHistoryResponse;
}

/**
 * Re-send the Stripe email receipt for an order to the original
 * purchaser (C8). Returns the masked destination email so the UI
 * can confirm "we just sent it to a***@example.com".
 *
 * Server enforces:
 *   - ownership (caller must be the auth user that paid)
 *   - status === 'paid'
 *   - per-session rate limit (5 sends / 10 min)
 *
 * Throws an Error whose `code` field is the server's error string
 * (rate_limited / not_payable / stripe_error / etc) so the caller
 * can render targeted UX messages.
 */
export async function resendOrderReceipt(
  sessionId: string,
): Promise<{ sent: true; email: string }> {
  const headers = {
    Accept: "application/json",
  };
  const res = await fetch(
    `/resupply-api/shop/me/orders/${encodeURIComponent(sessionId)}/resend-receipt`,
    { method: "POST", headers },
  );
  if (!res.ok) {
    let code = `http_${res.status}`;
    try {
      const body = (await res.json()) as { error?: string };
      if (body && typeof body.error === "string") code = body.error;
    } catch {
      // Body wasn't JSON — keep the http_<status> fallback.
    }
    const err = new Error(`Failed to re-send receipt (${code})`) as Error & {
      code: string;
    };
    err.code = code;
    throw err;
  }
  return (await res.json()) as { sent: true; email: string };
}

/**
 * Update the per-order shipping address. Only allowed while the
 * parcel hasn't shipped — the server returns 409 once shipped_at IS
 * NOT NULL. Throws an Error whose `code` field carries the server's
 * machine-readable error string so the caller can branch on it.
 *
 * Possible codes:
 *   - "invalid_order_id" / "invalid_body" — caller bug
 *   - "order_not_found"                   — wrong id, or someone
 *                                            else's order (server
 *                                            collapses both into 404
 *                                            for privacy)
 *   - "order_not_paid"                    — never billed, can't edit
 *   - "order_already_shipped"             — too late, contact support
 */
export async function updateOrderShippingAddress(
  orderId: string,
  address: OrderShippingAddress,
): Promise<{
  order: {
    id: string;
    shippingAddress: OrderShippingAddress;
    shippedAt: string | null;
    canEditAddress: boolean;
  };
}> {
  const headers = {
    Accept: "application/json",
    "Content-Type": "application/json",
  };
  const res = await fetch(
    `/resupply-api/shop/me/orders/${encodeURIComponent(orderId)}/shipping-address`,
    {
      method: "POST",
      headers,
      body: JSON.stringify(address),
    },
  );
  if (!res.ok) {
    let code = `http_${res.status}`;
    try {
      const body = (await res.json()) as { error?: string };
      if (body && typeof body.error === "string") code = body.error;
    } catch {
      // Body wasn't JSON — keep http_<status>.
    }
    const err = new Error(
      `Failed to update shipping address (${code})`,
    ) as Error & { code: string };
    err.code = code;
    throw err;
  }
  return (await res.json()) as {
    order: {
      id: string;
      shippingAddress: OrderShippingAddress;
      shippedAt: string | null;
      canEditAddress: boolean;
    };
  };
}

// ────────────────────────────────────────── site-wide reviews aggregate
//
// Powers the trust-signal strip on the marketing home page. One
// number (count) and one float (averageRating) across ALL approved
// reviews — the rating chip self-hides when count === 0 so a fresh
// install never shows "0.0★ from 0 reviews".

export interface ShopReviewsSiteAggregate {
  count: number;
  /** Mean star rating, 0–5, rounded to one decimal. */
  averageRating: number;
}

export async function getShopReviewsSiteAggregate(): Promise<ShopReviewsSiteAggregate> {
  const res = await fetch("/resupply-api/shop/reviews/site-aggregate", {
    headers: { Accept: "application/json" },
  });
  if (!res.ok) {
    throw new Error(`http_${res.status}`);
  }
  const body = (await res.json()) as ShopReviewsSiteAggregate;
  return {
    count: typeof body.count === "number" ? body.count : 0,
    averageRating:
      typeof body.averageRating === "number" ? body.averageRating : 0,
  };
}

// ─────────────────────────────────────────── insurance lead-capture form
//
// Posts to /shop/insurance-leads. Server fires two SendGrid emails
// (team notification + patient confirmation). Server always 200s
// once the body validates and the rate limit clears, even when
// SendGrid hiccups — the team also has the inbox to fall back on.

export interface InsuranceLeadInput {
  fullName: string;
  email: string;
  phone: string;
  dateOfBirth: string;
  insuranceCarrier: string;
  memberId: string;
  groupNumber: string | null;
  prescribingPhysician: string | null;
  notes: string | null;
  /** Honeypot — must be passed through but should always be empty. */
  website: string;
}

export async function submitInsuranceLead(
  input: InsuranceLeadInput,
): Promise<{ ok: true; delivered: boolean }> {
  const res = await fetch("/resupply-api/shop/insurance-leads", {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      ...csrfHeader(),
    },
    body: JSON.stringify(input),
  });
  if (!res.ok) {
    let code = `http_${res.status}`;
    try {
      const body = (await res.json()) as { error?: string };
      if (body && typeof body.error === "string") code = body.error;
    } catch {
      /* keep http_<status> */
    }
    if (code === "rate_limited") {
      throw new Error(
        "We've received a lot of requests from your network. Please wait a few minutes and try again, or call us.",
      );
    }
    if (code === "invalid_body") {
      throw new Error(
        "Please double-check the form — one of the fields didn't look right.",
      );
    }
    throw new Error(
      "Something went wrong on our end. Please try again or call us.",
    );
  }
  return (await res.json()) as { ok: true; delivered: boolean };
}

export async function submitBackInStockNotify(input: {
  productId: string;
  email: string;
}): Promise<{
  ok: true;
  status: "inserted" | "duplicate" | "error" | "queued";
}> {
  const res = await fetch("/resupply-api/shop/back-in-stock", {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      ...csrfHeader(),
    },
    body: JSON.stringify(input),
  });
  if (!res.ok) {
    let code = `http_${res.status}`;
    try {
      const body = (await res.json()) as { error?: string };
      if (body && typeof body.error === "string") code = body.error;
    } catch {
      /* keep http_<status> */
    }
    if (code === "rate_limited") {
      throw new Error(
        "Too many requests from your network. Please wait a few minutes and try again.",
      );
    }
    if (code === "invalid_body") {
      throw new Error(
        "That email didn't look right — please double-check and try again.",
      );
    }
    throw new Error("Something went wrong. Please try again.");
  }
  return (await res.json()) as {
    ok: true;
    status: "inserted" | "duplicate" | "error" | "queued";
  };
}

export function formatMoneyCents(cents: number, currency = "usd"): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: currency.toUpperCase(),
    minimumFractionDigits: 2,
  }).format(cents / 100);
}
