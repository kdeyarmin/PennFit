// Server-side catalog guard for checkout routes.
//
// Both POST /shop/checkout and POST /shop/me/quick-checkout accept a
// basket of { priceId, quantity, mode } from the client. Without this
// guard the server blindly passes those price IDs to Stripe, allowing
// a tampered request to purchase:
//   * products intentionally excluded from /shop/products (no `category`
//     metadata, wrong Stripe account, internal/test SKUs)
//   * one-time products whose `stock_count` is 0 (out of stock) or
//     where the requested quantity exceeds available stock
//   * stale/legacy/internal prices on catalog products that are not
//     the storefront-approved price for that product
//   * recurring prices when `one_time` mode is claimed (or vice-versa)
//
// This module provides a single `validateCartItems` function that each
// checkout route calls before constructing a Stripe Session.
//
// Enforcement rules (mirror /shop/products projection):
//
// one_time mode:
//   1. price exists, is active, type === "one_time"
//   2. product is active and has valid `category` metadata (catalog guard)
//   3. product.default_price is expanded, active, type === "one_time"
//      AND priceId === product.default_price.id  ← storefront-approved price
//   4. stock_count !== 0 (not out of stock)
//   5. stock_count is null OR quantity <= stock_count (quantity vs. stock)
//
// subscription mode:
//   1. price exists, is active, type === "recurring"
//   2. product is active and has valid `category` metadata (catalog guard)
//   3. priceId is the cheapest active recurring price on that product
//      (matches the selection logic in GET /shop/products)

import type Stripe from "stripe";
import { isShopCategory, parseStockCount } from "./products-meta";

export interface CartItem {
  priceId: string;
  quantity: number;
  mode: "one_time" | "subscription";
}

export interface CartValidationError {
  priceId: string;
  reason:
    | "price_not_found"
    | "price_inactive"
    | "wrong_price_type"
    | "product_inactive"
    | "not_in_catalog"
    | "price_not_storefront_approved"
    | "out_of_stock"
    | "exceeds_stock";
  message: string;
}

export interface CartValidationResult {
  ok: boolean;
  errors: CartValidationError[];
}

/**
 * Validate each basket item against the live Stripe catalog.
 *
 * Each price is fetched individually (with product and default_price
 * expanded) so we always operate on the live state. The cart is bounded
 * to 20 items max and the checkout endpoints are already rate-limited to
 * 10 req/min/IP, so the extra Stripe round-trips are acceptable.
 *
 * Quantities are aggregated per priceId before stock comparison so that
 * split-line attacks (e.g., two lines of qty=3 each against stock=5)
 * are caught even though each individual line passes the per-line check.
 */
export async function validateCartItems(
  stripe: Stripe,
  items: CartItem[],
): Promise<CartValidationResult> {
  const errors: CartValidationError[] = [];

  // Aggregate total requested quantity per priceId for stock comparison.
  // Items with different modes for the same priceId are unusual but we
  // sum them conservatively — if any line for a price is one_time, the
  // aggregated quantity must fit within stock.
  const aggregatedQty = new Map<string, number>();
  for (const item of items) {
    if (item.mode === "one_time") {
      aggregatedQty.set(
        item.priceId,
        (aggregatedQty.get(item.priceId) ?? 0) + item.quantity,
      );
    }
  }

  // Deduplicate by priceId+mode for the Stripe fetch: each unique
  // (priceId, mode) pair is validated once, but stock is checked
  // against the aggregated quantity computed above.
  const seen = new Set<string>();
  const uniqueItems: CartItem[] = [];
  for (const item of items) {
    const key = `${item.priceId}:${item.mode}`;
    if (!seen.has(key)) {
      seen.add(key);
      uniqueItems.push(item);
    }
  }

  await Promise.all(
    uniqueItems.map(async (item) => {
      const totalQty = aggregatedQty.get(item.priceId) ?? item.quantity;
      const itemError = await validateSingleItem(stripe, {
        ...item,
        // Pass the aggregated quantity so the stock check uses the real
        // total across all duplicate lines, not just this one line's qty.
        quantity: item.mode === "one_time" ? totalQty : item.quantity,
      });
      if (itemError) errors.push(itemError);
    }),
  );

  return { ok: errors.length === 0, errors };
}

async function validateSingleItem(
  stripe: Stripe,
  item: CartItem,
): Promise<CartValidationError | null> {
  // Fetch price with product AND product.default_price expanded so we
  // can run the full projectProduct catalog-membership check in one call.
  let price: Stripe.Price;
  try {
    price = await stripe.prices.retrieve(item.priceId, {
      expand: ["product", "product.default_price"],
    });
  } catch {
    return {
      priceId: item.priceId,
      reason: "price_not_found",
      message: `Price ${item.priceId} could not be retrieved.`,
    };
  }

  if (!price.active) {
    return {
      priceId: item.priceId,
      reason: "price_inactive",
      message: `Price ${item.priceId} is no longer active.`,
    };
  }

  // Validate mode ↔ Stripe price type correspondence.
  const expectedType = item.mode === "subscription" ? "recurring" : "one_time";
  if (price.type !== expectedType) {
    return {
      priceId: item.priceId,
      reason: "wrong_price_type",
      message: `Price ${item.priceId} has type "${price.type}" but mode "${item.mode}" was requested.`,
    };
  }

  const product = price.product;
  if (!product || typeof product === "string" || product.deleted) {
    return {
      priceId: item.priceId,
      reason: "product_inactive",
      message: `Product for price ${item.priceId} is unavailable.`,
    };
  }

  if (!product.active) {
    return {
      priceId: item.priceId,
      reason: "product_inactive",
      message: `Product for price ${item.priceId} is no longer active.`,
    };
  }

  const meta = (product.metadata ?? {}) as Record<string, string | undefined>;

  // Catalog-membership guard: same fence that /shop/products applies
  // via projectProduct — only products with a recognised `category`
  // metadata key are part of the approved storefront.
  if (!isShopCategory(meta.category)) {
    return {
      priceId: item.priceId,
      reason: "not_in_catalog",
      message: `Price ${item.priceId} does not belong to the shop catalog.`,
    };
  }

  if (item.mode === "one_time") {
    return validateOneTimeItem(item, product, meta);
  } else {
    return validateSubscriptionItem(stripe, item, product);
  }
}

function validateOneTimeItem(
  item: CartItem,
  product: Stripe.Product,
  meta: Record<string, string | undefined>,
): CartValidationError | null {
  // Storefront-approved price guard: for one-time purchases, the only
  // accepted price is the product's `default_price`. Any other active
  // price on the same product (stale, internal, legacy) is not surfaced
  // by /shop/products and must not be purchasable via checkout.
  const defaultPrice = product.default_price;
  if (
    !defaultPrice ||
    typeof defaultPrice === "string" ||
    !defaultPrice.active ||
    defaultPrice.type !== "one_time" ||
    defaultPrice.unit_amount == null
  ) {
    // Product doesn't have a valid storefront default price — same
    // exclusion rule as projectProduct(...) in products-meta.ts.
    return {
      priceId: item.priceId,
      reason: "not_in_catalog",
      message: `Product for price ${item.priceId} does not have a valid storefront price.`,
    };
  }

  if (item.priceId !== defaultPrice.id) {
    // The submitted price exists and is a valid one-time price, but it
    // is not the storefront-approved price for this product. This is
    // the "stale/internal price bypass" the vulnerability describes.
    return {
      priceId: item.priceId,
      reason: "price_not_storefront_approved",
      message: `Price ${item.priceId} is not the active storefront price for this product.`,
    };
  }

  // Stock check: reject if explicitly out of stock (stock_count === 0),
  // and reject if quantity exceeds tracked stock.
  const stockCount = parseStockCount(meta.stock_count);
  if (stockCount === 0) {
    return {
      priceId: item.priceId,
      reason: "out_of_stock",
      message: `Price ${item.priceId} is currently out of stock.`,
    };
  }
  if (stockCount !== null && item.quantity > stockCount) {
    return {
      priceId: item.priceId,
      reason: "exceeds_stock",
      message: `Requested quantity (${item.quantity}) exceeds available stock (${stockCount}) for price ${item.priceId}.`,
    };
  }

  return null;
}

async function validateSubscriptionItem(
  stripe: Stripe,
  item: CartItem,
  product: Stripe.Product,
): Promise<CartValidationError | null> {
  // Full catalog-membership gate: mirror projectProduct(...) from
  // products-meta.ts so products excluded from /shop/products for
  // default_price reasons (missing, inactive, non-one-time, or zero
  // unit_amount) are equally excluded from subscription checkout.
  // `product.default_price` is expanded from the parent retrieve call
  // (`expand: ['product', 'product.default_price']`).
  const defaultPrice = product.default_price;
  if (
    !defaultPrice ||
    typeof defaultPrice === "string" ||
    !defaultPrice.active ||
    defaultPrice.unit_amount == null ||
    defaultPrice.type !== "one_time"
  ) {
    return {
      priceId: item.priceId,
      reason: "not_in_catalog",
      message: `Product for price ${item.priceId} does not meet storefront catalog requirements.`,
    };
  }

  // For subscription mode, the storefront selects the cheapest active
  // recurring price per product (see /shop/products). Enforce that the
  // submitted priceId is that approved recurring price so clients cannot
  // target stale/internal recurring prices on catalog products.
  let recurringPrices: Stripe.Price[];
  try {
    const list = await stripe.prices.list({
      product: product.id,
      active: true,
      type: "recurring",
      limit: 100,
    });
    recurringPrices = list.data;
  } catch {
    // If we can't confirm the price is the storefront-approved one,
    // fail closed rather than allowing through an unverified price.
    return {
      priceId: item.priceId,
      reason: "price_not_found",
      message: `Could not verify recurring prices for price ${item.priceId}.`,
    };
  }

  // Mirror the storefront selection: cheapest active recurring price wins.
  // If multiple prices share the minimum unit_amount, the first one from
  // Stripe's list wins (same as the storefront's first-write-wins map).
  const cheapest = recurringPrices
    .filter((p) => p.unit_amount != null)
    .reduce<Stripe.Price | null>((best, p) => {
      if (!best) return p;
      return (p.unit_amount ?? Infinity) < (best.unit_amount ?? Infinity)
        ? p
        : best;
    }, null);

  if (!cheapest || item.priceId !== cheapest.id) {
    return {
      priceId: item.priceId,
      reason: "price_not_storefront_approved",
      message: `Price ${item.priceId} is not the active storefront recurring price for this product.`,
    };
  }

  return null;
}
