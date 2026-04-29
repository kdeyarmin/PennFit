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
}

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
    },
    body: JSON.stringify({
      items,
      successPath: options?.successPath,
      cancelPath: options?.cancelPath,
    }),
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { message?: string };
    throw new Error(
      body.message ?? `Couldn't start checkout (${res.status})`,
    );
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

/**
 * Build the Authorization header from Clerk's global session, when
 * the SDK has loaded. Returns an empty object when signed-out so
 * public reads still work.
 */
async function authHeader(): Promise<Record<string, string>> {
  const clerk = (
    globalThis as unknown as {
      Clerk?: { session?: { getToken?: () => Promise<string | null> } | null };
    }
  ).Clerk;
  if (!clerk?.session?.getToken) return {};
  try {
    const token = await clerk.session.getToken();
    return token ? { Authorization: `Bearer ${token}` } : {};
  } catch {
    return {};
  }
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
  const headers = { Accept: "application/json", ...(await authHeader()) };
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
    ...(await authHeader()),
  };
  const res = await fetch(
    `/resupply-api/shop/products/${encodeURIComponent(productId)}/reviews`,
    { method: "POST", headers, body: JSON.stringify(payload) },
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
    ...(await authHeader()),
  };
  const res = await fetch(
    `/resupply-api/shop/me/reviews/${encodeURIComponent(productId)}`,
    { method: "PATCH", headers, body: JSON.stringify(payload) },
  );
  if (!res.ok) throw new Error(`Failed to update review (${res.status})`);
  return (await res.json()) as MyReview;
}

export async function deleteMyReview(productId: string): Promise<void> {
  const headers = { Accept: "application/json", ...(await authHeader()) };
  const res = await fetch(
    `/resupply-api/shop/me/reviews/${encodeURIComponent(productId)}`,
    { method: "DELETE", headers },
  );
  if (!res.ok) throw new Error(`Failed to delete review (${res.status})`);
}

export function formatMoneyCents(cents: number, currency = "usd"): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: currency.toUpperCase(),
    minimumFractionDigits: 2,
  }).format(cents / 100);
}
