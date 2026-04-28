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
  price: {
    id: string;
    /** In whole-dollar cents (Stripe's `unit_amount`). */
    unitAmount: number;
    currency: string;
  };
}

function isShopCategory(v: string | undefined): v is ShopCategory {
  return !!v && (SHOP_CATEGORIES as readonly string[]).includes(v);
}

/**
 * Project a Stripe Product (with its default Price expanded) into the
 * client-facing shape the shop UI consumes. Returns null for products
 * that don't carry a valid `category` metadata key — that's the fence
 * that keeps non-shop products (e.g. legacy or test products in the
 * same Stripe account) from leaking into the patient-facing catalog.
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
    price: {
      id: defaultPrice.id,
      unitAmount: defaultPrice.unit_amount,
      currency: defaultPrice.currency,
    },
  };
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
