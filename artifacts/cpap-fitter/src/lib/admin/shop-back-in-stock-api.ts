// Hand-rolled fetch wrappers for the back-in-stock admin queue
// endpoints. Mirrors the pattern in shop-inventory-api.ts — the
// admin surface is small enough that the OpenAPI codegen overhead
// isn't worth it yet.
//
// Auth: the browser sends the `pf_session` cookie automatically on
// same-origin requests, so no per-call auth header is needed.

export interface BackInStockQueueRow {
  productId: string;
  productName: string;
  productImageUrl: string | null;
  priceLabel: string | null;
  pendingCount: number;
  notifiedCount: number;
  deliveredCount: number;
  /** ISO timestamp of the oldest pending signup, or null if none. */
  oldestPendingAt: string | null;
  /** ISO timestamp of the most recent notification of any kind. */
  lastNotifiedAt: string | null;
}

export interface BackInStockQueueResponse {
  queue: BackInStockQueueRow[];
  totals: { pending: number; notified: number; delivered: number };
  /** False when STRIPE_SECRET_KEY is unset — rows still render but
   *  product names fall back to the bare product id and the manual
   *  dispatch button is disabled. */
  stripeAvailable: boolean;
}

export interface BackInStockDispatchResult {
  productId: string;
  productName: string;
  pending: number;
  attempted: number;
  delivered: number;
  failed: number;
}

export async function listBackInStockQueue(): Promise<BackInStockQueueResponse> {
  const res = await fetch("/resupply-api/admin/shop/back-in-stock-queue", {
    headers: { Accept: "application/json" },
  });
  if (!res.ok) {
    throw new Error(`Failed to load back-in-stock queue (${res.status})`);
  }
  return (await res.json()) as BackInStockQueueResponse;
}

export async function dispatchBackInStockNow(
  productId: string,
): Promise<BackInStockDispatchResult> {
  const res = await fetch(
    `/resupply-api/admin/shop/back-in-stock-queue/${encodeURIComponent(productId)}/dispatch`,
    {
      method: "POST",
      headers: { Accept: "application/json" },
    },
  );
  if (!res.ok) {
    let detail = "";
    try {
      const body = (await res.json()) as { error?: string };
      detail = body?.error ?? "";
    } catch {
      // ignore
    }
    if (res.status === 503 && detail === "stripe_not_configured") {
      throw new Error(
        "Stripe is not configured — set STRIPE_SECRET_KEY to dispatch.",
      );
    }
    throw new Error(`Dispatch failed (${res.status}${detail ? `: ${detail}` : ""})`);
  }
  return (await res.json()) as BackInStockDispatchResult;
}
