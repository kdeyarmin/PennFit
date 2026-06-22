// Restock a received return's items back into sellable inventory.
//
// Returns are whole-order (no line-level detail), so a restock adds the
// returned order's line-item quantities back to each product's Stripe
// `stock_count` (the documented inventory source of truth). This is the
// inverse of decrementStockForPurchase and is OPT-IN per return: a CSR sets
// `restock: true` at mark-received only when the item is genuinely resaleable
// (most DME consumables — opened masks/supplies — are NOT, so the default is
// false). Tracked SKUs only (a product with null stock_count is
// untracked/unlimited and is left alone). Fail-soft per product: a failed
// Stripe write is logged, never thrown — the receipt already succeeded and
// drift is caught by the monthly inventory reconciliation.

import type Stripe from "stripe";

import type { OrgScopedClient } from "@workspace/resupply-db";

import { getStripeClient } from "../stripe/config";
import { parseStockCount } from "../stripe/products-meta";

type RestockLogger = {
  info?: (obj: unknown, msg?: string) => void;
  warn?: (obj: unknown, msg?: string) => void;
};

export interface RestockResult {
  productsRestocked: number;
}

/**
 * Add the returned order's line-item quantities back to each tracked
 * product's Stripe stock_count. No-op when the order has no items or no
 * tracked products.
 */
export async function restockReturnedOrder(opts: {
  stripe: ReturnType<typeof getStripeClient>;
  accountOptions: Stripe.RequestOptions;
  supabase: OrgScopedClient;
  orderId: string | null;
  sessionId: string | null;
  log?: RestockLogger;
}): Promise<RestockResult> {
  const { stripe, accountOptions, supabase, orderId, sessionId, log } = opts;
  if (!orderId && !sessionId) return { productsRestocked: 0 };

  // Whole-order line items. Prefer the stable order_id; fall back to the
  // session id (older rows / guest flows).
  const base = supabase.from("shop_order_items").select("product_id, quantity");
  const { data: items, error } = await (orderId
    ? base.eq("order_id", orderId)
    : base.eq("stripe_session_id", sessionId as string));
  if (error) throw error;

  const qtyByProduct = new Map<string, number>();
  for (const it of (items ?? []) as Array<{
    product_id: string | null;
    quantity: number | null;
  }>) {
    if (!it.product_id) continue;
    qtyByProduct.set(
      it.product_id,
      (qtyByProduct.get(it.product_id) ?? 0) + (it.quantity ?? 1),
    );
  }
  if (qtyByProduct.size === 0) return { productsRestocked: 0 };

  let productsRestocked = 0;
  for (const [productId, qty] of qtyByProduct) {
    try {
      // Re-read CURRENT stock so a concurrent debit/restock isn't overwritten
      // from a stale value. Untracked (null) products are left alone.
      const fresh = await stripe.products.retrieve(
        productId,
        undefined,
        accountOptions,
      );
      const current = parseStockCount(
        (fresh.metadata as Record<string, string | undefined> | undefined)
          ?.stock_count,
      );
      if (current === null) continue; // not stock-tracked → unlimited, skip
      const next = current + qty;
      await stripe.products.update(
        productId,
        { metadata: { stock_count: String(next) } },
        accountOptions,
      );
      productsRestocked += 1;
      log?.info?.(
        { productId, from: current, to: next },
        "stock_count restocked from return",
      );
    } catch (err) {
      log?.warn?.(
        { productId, err },
        "stock_count restock failed (non-fatal — reconciled by monthly count)",
      );
    }
  }
  return { productsRestocked };
}
