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

export function formatMoneyCents(cents: number, currency = "usd"): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: currency.toUpperCase(),
    minimumFractionDigits: 2,
  }).format(cents / 100);
}
