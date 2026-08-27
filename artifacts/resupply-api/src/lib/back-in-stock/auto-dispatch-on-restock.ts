// Auto-dispatch back-in-stock emails when a SKU returns to positive on-hand.
//
// `dispatchBackInStockForProduct` already drains the pending signup queue;
// until this hook existed nothing called it from the stock RPC path — only
// manual admin dispatch (removed with the cash-pay shop) could fire alerts.
// Wiring it here closes the loop the same way `autoClearBackorderForSku`
// clears open backorders on restock.
//
// Opt-in via `RESUPPLY_BACK_IN_STOCK_AUTO_DISPATCH=1` (off by default).
// Fail-soft: never throws; a dispatch failure must not undo a recorded
// stock movement.

import {
  countPendingBackInStock,
  dispatchBackInStockForProduct,
} from "../back-in-stock-record";
import { getProduct } from "../catalog/store";
import { logger } from "../logger";
import { resolveTenantBaseUrl } from "../tenant-branding";

export function isBackInStockAutoDispatchEnabled(): boolean {
  return process.env.RESUPPLY_BACK_IN_STOCK_AUTO_DISPATCH === "1";
}

export interface AutoDispatchBackInStockInput {
  orgId: string;
  /** Resupply catalog SKU — also used as `product_id` in the notify queue. */
  sku: string;
}

export interface AutoDispatchBackInStockResult {
  /** True when a dispatch was started (fire-and-forget). */
  started: boolean;
  pending: number;
}

export async function autoDispatchBackInStockOnRestock(
  input: AutoDispatchBackInStockInput,
): Promise<AutoDispatchBackInStockResult> {
  const result: AutoDispatchBackInStockResult = { started: false, pending: 0 };
  if (!isBackInStockAutoDispatchEnabled()) return result;

  const sku = input.sku?.trim();
  if (!sku || !input.orgId?.trim()) return result;

  try {
    const pending = await countPendingBackInStock(sku, input.orgId);
    result.pending = pending;
    if (pending === 0) return result;

    const product = await getProduct(input.orgId, sku);
    if (!product) return result;

    const tenantBase =
      (await resolveTenantBaseUrl(input.orgId)) ?? "https://cmbreathe.com";
    const base = tenantBase.replace(/\/$/, "");
    // Cash-pay product pages redirect to /insurance; contact is the live
    // patient surface for supply questions (same posture as review-request
    // emails post-insurance-only).
    const productUrl = `${base}/contact?utm_source=email&utm_medium=transactional&utm_campaign=back_in_stock&sku=${encodeURIComponent(sku)}`;

    void dispatchBackInStockForProduct({
      orgId: input.orgId,
      productId: sku,
      productName: product.name,
      productUrl,
      priceLabel: null,
      productImageUrl: null,
    });
    result.started = true;
    logger.info(
      { orgId: input.orgId, sku, pending },
      "back-in-stock-auto-dispatch: started on restock",
    );
    return result;
  } catch (err) {
    logger.warn(
      { err, orgId: input.orgId, sku },
      "back-in-stock-auto-dispatch: failed (non-fatal)",
    );
    return result;
  }
}
