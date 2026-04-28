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
  price: {
    id: string;
    unitAmount: number;
    currency: string;
  };
}

export interface ShopProductsResponse {
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
  return (await res.json()) as ShopProductsResponse;
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
