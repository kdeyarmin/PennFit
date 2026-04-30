// Typed helpers for reading product/bundle metadata off Stripe Product
// objects. We keep this in one place so the shape we set in the seed
// script and the shape we read in the products endpoint can never
// drift.
//
// Per the Stripe integration guidance, Stripe is the source of truth
// for product data. We attach our own taxonomy (category, bundle,
// included items) via the `metadata` field on each Stripe Product.
//
// Categories supported by the shop UI's category bar:
//   - mask           (full mask + cushion)
//   - cushion        (replacement silicone)
//   - tubing         (standard + heated)
//   - filter         (disposable + reusable)
//   - headgear       (straps, chinstraps)
//   - chamber        (humidifier water chambers)
//   - accessory      (wipes, travel cases)
//   - bundle         (curated multi-item kits)
//
// Subscribe & Save:
//   In addition to the one-time `price`, every product MAY surface a
//   `recurringPrice` derived from a separate active recurring Stripe
//   Price on the same product (cheapest match wins). The shop UI
//   shows the toggle only when `recurringPrice` is non-null. v1
//   policy: subscribe price is the SAME unit_amount as one-time —
//   we don't model a discount. Auto-ship is sold as convenience, not
//   savings, so the merchant simply creates a recurring Price with
//   matching `unit_amount`.

import type Stripe from "stripe";

export const SHOP_CATEGORIES = [
  "mask",
  "cushion",
  "tubing",
  "filter",
  "headgear",
  "chamber",
  "accessory",
  "bundle",
] as const;

export type ShopCategory = (typeof SHOP_CATEGORIES)[number];

export interface ShopRecurringPriceView {
  id: string;
  /** In whole-dollar cents. */
  unitAmount: number;
  currency: string;
  /** Stripe interval ('day' | 'week' | 'month' | 'year'). */
  interval: "day" | "week" | "month" | "year";
  /** Stripe interval_count (e.g. 3 for "every 3 months"). */
  intervalCount: number;
  /**
   * Pre-rendered human label for UI ("month", "3 months", "year").
   * Computed server-side so the toggle, cart, and account page all
   * say the same thing without duplicating the formatting rule.
   */
  intervalLabel: string;
}

export interface ShopProductView {
  id: string;
  name: string;
  description: string | null;
  category: ShopCategory;
  /** Tagline shown on cards (subtitle / one-liner). */
  tagline: string | null;
  /** Whether this product is a curated bundle. */
  isBundle: boolean;
  /** For bundles: the human-readable contents list. */
  bundleContents: string[];
  /** Replacement-cycle hint shown on cards (e.g. "every 3 months"). */
  replacementHint: string | null;
  /** Optional image URL (set via Stripe Dashboard or seed script). */
  imageUrl: string | null;
  /** Manufacturer brand, e.g. "ResMed". From metadata.manufacturer. */
  manufacturer: string | null;
  /** Manufacturer model / part number, e.g. "62932". From metadata.model_number. */
  modelNumber: string | null;
  /**
   * Available stock for the one-time-purchase path. Stripe is the
   * source of truth — we read `metadata.stock_count` (parsed as int)
   * so an admin can edit it from the resupply-dashboard inventory
   * editor without us shipping a separate inventory table.
   *
   * Semantics:
   *   * `null`  — not tracked. Treat as "available". This is the
   *               default state for products created before the
   *               admin set a stock number.
   *   * `0`     — out of stock. UI shows "Out of stock" and disables
   *               the one-time add-to-cart. Subscribe & ship stays
   *               available because subscription replenishment runs
   *               on a separate cadence and pulls from a different
   *               warehouse pool in practice.
   *   * `>0`    — available; the UI may show "Only N left" when the
   *               number is small.
   *
   * Negative or non-numeric metadata values normalise to `null` so a
   * typo in the Stripe Dashboard never accidentally takes a SKU
   * offline.
   */
  stockCount: number | null;
  /**
   * Per-SKU "low stock" threshold. The storefront renders the
   * "Only N left" badge when `stockCount > 0 && stockCount <=
   * lowStockThreshold`. When `null`, the storefront falls back to
   * a hardcoded default of 5 — preserving v1 behavior for SKUs
   * the admin hasn't customized.
   *
   * Source of truth: Stripe `metadata.low_stock_threshold`. Same
   * Stripe-as-truth philosophy as `stockCount` — admins can edit it
   * from the resupply-dashboard inventory editor or directly from
   * the Stripe Dashboard.
   *
   * Semantics:
   *   * `null`  — not set; storefront uses default of 5.
   *   * `0`     — never show the "low" badge. Useful for SKUs where
   *               the merchant doesn't want to surface stock anxiety.
   *   * `>0`    — explicit threshold.
   *
   * Negative or non-numeric metadata values normalise to `null` —
   * a typo in the Stripe Dashboard never silently changes the
   * threshold.
   */
  lowStockThreshold: number | null;
  price: {
    id: string;
    /** In whole-dollar cents (Stripe's `unit_amount`). */
    unitAmount: number;
    currency: string;
  };
  /**
   * Optional recurring (subscription) price for this product. When
   * present, the shop UI surfaces a "Subscribe & ship" toggle.
   * v1: same unit_amount as one-time price; we don't display a
   * discount and don't enforce one server-side.
   */
  recurringPrice: ShopRecurringPriceView | null;
}

export function isShopCategory(v: string | undefined): v is ShopCategory {
  return !!v && (SHOP_CATEGORIES as readonly string[]).includes(v);
}

/**
 * Render a Stripe interval + count into a human-friendly label.
 * Examples: ("month", 1) → "month"; ("month", 3) → "3 months";
 * ("week", 2) → "2 weeks"; ("year", 1) → "year".
 */
export function formatIntervalLabel(
  interval: "day" | "week" | "month" | "year",
  intervalCount: number,
): string {
  if (intervalCount === 1) return interval;
  return `${intervalCount} ${interval}s`;
}

/**
 * Convert a Stripe recurring Price into the client-facing shape.
 * Returns null for prices missing required fields.
 */
export function projectRecurringPrice(
  price: Stripe.Price,
): ShopRecurringPriceView | null {
  if (!price.active) return null;
  if (price.unit_amount == null) return null;
  if (price.type !== "recurring") return null;
  const recurring = price.recurring;
  if (!recurring) return null;
  // Stripe constrains interval to one of these four values; the cast
  // is safe because it comes off the live Stripe API.
  const interval = recurring.interval as "day" | "week" | "month" | "year";
  const intervalCount = recurring.interval_count ?? 1;
  return {
    id: price.id,
    unitAmount: price.unit_amount,
    currency: price.currency,
    interval,
    intervalCount,
    intervalLabel: formatIntervalLabel(interval, intervalCount),
  };
}

/**
 * Project a Stripe Product (with its default Price expanded) into the
 * client-facing shape the shop UI consumes. Returns null for products
 * that don't carry a valid `category` metadata key — that's the fence
 * that keeps non-shop products (e.g. legacy or test products in the
 * same Stripe account) from leaking into the patient-facing catalog.
 *
 * `recurringPrice` is attached separately by the products endpoint
 * (see routes/shop/products.ts), since it requires a second Stripe
 * call to enumerate non-default prices on the product.
 */
export function projectProduct(p: Stripe.Product): ShopProductView | null {
  if (!p.active) return null;

  const meta = (p.metadata ?? {}) as Record<string, string | undefined>;
  const category = meta.category;
  if (!isShopCategory(category)) return null;

  // Price guard: Stripe Products and Prices are separate objects.
  // We require `default_price` to be expanded into a Price object
  // (the seed script always sets a default price). If a product
  // exists without one, skip rather than render a "Free" item.
  //
  // The default_price is required to be one_time — that's the price
  // the cart adds when the user clicks "Add to cart" in default mode.
  // Subscribe mode uses the separately-attached recurringPrice.
  const defaultPrice = p.default_price;
  if (!defaultPrice || typeof defaultPrice === "string") return null;
  if (!defaultPrice.active) return null;
  if (defaultPrice.unit_amount == null) return null;
  if (defaultPrice.type !== "one_time") return null;

  const isBundle = category === "bundle" || meta.bundle === "true";
  const bundleContents = isBundle
    ? parseBundleContents(meta.bundle_contents)
    : [];

  return {
    id: p.id,
    name: p.name,
    description: p.description,
    category,
    tagline: meta.tagline ?? null,
    isBundle,
    bundleContents,
    replacementHint: meta.replacement_hint ?? null,
    imageUrl: p.images?.[0] ?? null,
    manufacturer: meta.manufacturer ?? null,
    modelNumber: meta.model_number ?? null,
    stockCount: parseStockCount(meta.stock_count),
    lowStockThreshold: parseLowStockThreshold(meta.low_stock_threshold),
    price: {
      id: defaultPrice.id,
      unitAmount: defaultPrice.unit_amount,
      currency: defaultPrice.currency,
    },
    recurringPrice: null,
  };
}

/**
 * Parse a Stripe metadata `stock_count` value. Returns `null` for any
 * unset / non-integer / negative input — we never want a typo in the
 * Stripe Dashboard to silently take a SKU off the storefront. See the
 * doc on `ShopProductView.stockCount` for the semantics.
 */
export function parseStockCount(raw: string | undefined): number | null {
  if (raw == null || raw === "") return null;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n < 0) return null;
  // Cap at a sane upper bound so an accidental "9999999999" doesn't
  // overflow a downstream `integer` column. The cap is generous —
  // anything above 1m is operationally indistinguishable from "lots".
  return Math.min(n, 1_000_000);
}

/**
 * Parse a Stripe metadata `low_stock_threshold` value. Returns
 * `null` for any unset / non-integer / negative input — the
 * storefront treats `null` as "use the default of 5". See the doc
 * on `ShopProductView.lowStockThreshold` for full semantics.
 *
 * Why a separate parser (vs reusing parseStockCount): these two
 * fields share the "non-negative int or null" contract, but I want
 * the option to evolve them separately (e.g. a future cap of 50 on
 * threshold) without breaking the stock_count parser.
 */
export function parseLowStockThreshold(raw: string | undefined): number | null {
  if (raw == null || raw === "") return null;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n < 0) return null;
  // Cap at 1000 — anything above is operationally indistinguishable
  // from "always show low" and a typo of 1000000 would be confusing
  // in the admin UI. The storefront just won't render anything
  // useful at extreme values anyway.
  return Math.min(n, 1000);
}

function parseBundleContents(raw: string | undefined): string[] {
  if (!raw) return [];
  // Stripe metadata values are strings. We pack bundle contents as a
  // JSON-encoded string array in the seed script; if that ever fails
  // to parse we fall back to splitting on `|` so a hand-edited
  // metadata field in the Stripe Dashboard still works.
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed) && parsed.every((x) => typeof x === "string")) {
      return parsed;
    }
  } catch {
    /* fallthrough to | split */
  }
  return raw
    .split("|")
    .map((s) => s.trim())
    .filter(Boolean);
}
