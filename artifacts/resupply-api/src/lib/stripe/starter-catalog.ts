// Tenant-neutral "starter catalog" + a reusable idempotent seeder.
//
// Why this exists (G6, per-tenant catalogs):
//   The platform runs Stripe Connect *direct charges* — a connected
//   tenant's storefront reads its catalog from, and routes checkout to,
//   THEIR OWN connected account (see lib/stripe/connect.ts). A brand-new
//   tenant therefore starts with an EMPTY store. This module lets a tenant
//   one-click a generic CPAP/sleep-apnea supply catalog into their own
//   account so the storefront isn't empty; they then edit names/prices to
//   match their business.
//
//   The copy here is deliberately BRAND-NEUTRAL (no manufacturer names, no
//   first-person voice) so it's appropriate for any tenant. The seed
//   tenant (Penn Home Medical Supply / PennPaps) keeps its own branded
//   catalog via scripts/src/seed-stripe-products.ts — that stays as-is and
//   is NOT replaced by this.
//
// Idempotency mirrors the seed script: each item carries a stable
// `metadata.shop_sku`; we search by it before creating, so re-running only
// updates the existing product (and rotates the price when the amount
// changed) rather than duplicating. Re-seeding is always safe.
//
// Account scoping: every Stripe call takes the caller's `requestOptions`
// (`{ stripeAccount }` for a connected tenant, `{}` for the platform
// account) so products land in the SAME account the storefront reads from.

import type Stripe from "stripe";

import type { ShopCategory } from "./products-meta";

export interface StarterProduct {
  /** Stable, unique SKU; the idempotency key (written to metadata.shop_sku). */
  sku: string;
  name: string;
  description: string;
  category: ShopCategory;
  /** Short subtitle shown on cards (metadata.tagline). */
  tagline: string;
  /** Replacement-cadence hint (metadata.replacement_hint). */
  replacementHint: string;
  /** One-time price in whole-dollar cents (USD). */
  unitAmountCents: number;
  /** For bundles only: human-readable contents list. */
  bundleContents?: string[];
}

export const STARTER_CATALOG: StarterProduct[] = [
  // ── Masks ──
  {
    sku: "starter-mask-nasal-pillows",
    name: "Nasal Pillows CPAP Mask — Fit Pack",
    description:
      "A lightweight nasal pillows mask that seals at the nostrils for minimal facial contact and an open line of sight. The fit pack includes multiple pillow sizes so the seal can be dialed in at home. Includes frame and headgear.",
    category: "mask",
    tagline: "Minimal-contact nasal pillows",
    replacementHint: "Replace mask every 3 months",
    unitAmountCents: 7900,
  },
  {
    sku: "starter-mask-nasal",
    name: "Nasal CPAP Mask — Fit Pack",
    description:
      "A traditional nasal mask with a soft silicone cushion that covers the nose for stable sealing across a wide pressure range. The fit pack ships with several cushion sizes for an at-home fitting. Includes frame and headgear.",
    category: "mask",
    tagline: "Soft cushion, multiple sizes",
    replacementHint: "Replace mask every 3 months",
    unitAmountCents: 9900,
  },
  {
    sku: "starter-mask-full-face",
    name: "Full Face CPAP Mask — Medium",
    description:
      "A full face mask that covers both the nose and mouth, suited to mouth-breathers and to higher prescribed pressures. A quick-release elbow simplifies removal during the night. Includes frame, cushion, and headgear.",
    category: "mask",
    tagline: "Covers nose and mouth",
    replacementHint: "Replace mask every 3 months",
    unitAmountCents: 12900,
  },
  {
    sku: "starter-mask-full-face-top-tube",
    name: "Full Face CPAP Mask, Top-of-Head Tube — Medium",
    description:
      "A full face mask that routes the tubing over the top of the head to keep the hose clear of the sleeping surface, helping side and stomach sleepers maintain the seal. Includes frame, cushion, headgear, and short tube.",
    category: "mask",
    tagline: "Tube routes over the head",
    replacementHint: "Replace mask every 3 months",
    unitAmountCents: 15900,
  },

  // ── Cushions ──
  {
    sku: "starter-cushion-nasal-pillows",
    name: "Replacement Nasal Pillows — Fit Pack",
    description:
      "Replacement nasal pillows compatible with standard nasal-pillow frames, supplied in multiple sizes so the seal can be adjusted as needed. Pillows wear faster than any other part, so a fresh set keeps the seal quiet and leak-free.",
    category: "cushion",
    tagline: "All sizes included",
    replacementHint: "Replace every 2 weeks to 1 month",
    unitAmountCents: 1900,
  },
  {
    sku: "starter-cushion-nasal",
    name: "Replacement Nasal Cushion",
    description:
      "A replacement silicone cushion for standard nasal masks. Swapping the cushion on a regular cadence restores a clean sealing edge and helps prevent overnight leaks and skin marks. Direct fit, no tools required.",
    category: "cushion",
    tagline: "Restores a clean seal",
    replacementHint: "Replace every 1 month",
    unitAmountCents: 2400,
  },
  {
    sku: "starter-cushion-full-face",
    name: "Replacement Full Face Cushion",
    description:
      "A replacement cushion for standard full face masks covering the nose and mouth. A fresh cushion keeps the larger sealing surface conforming correctly at higher pressures. Direct fit, no tools required.",
    category: "cushion",
    tagline: "Reliable full-face seal",
    replacementHint: "Replace every 1 month",
    unitAmountCents: 2900,
  },
  {
    sku: "starter-cushion-nasal-pillows-single",
    name: "Replacement Nasal Pillows — Single Size",
    description:
      "A single-size pack of replacement nasal pillows for users who already know their size and want a simple recurring refill. Keeping pillows fresh is the lowest-cost way to maintain a quiet, leak-free fit.",
    category: "cushion",
    tagline: "Single-size refill",
    replacementHint: "Replace every 2 weeks to 1 month",
    unitAmountCents: 1900,
  },

  // ── Tubing ──
  {
    sku: "starter-tubing-standard",
    name: "Standard CPAP Tubing — 6 ft",
    description:
      "A standard six-foot CPAP hose with universal cuffs that fit most masks and machines. Replacing tubing on a regular cadence avoids small cracks and pinholes that can quietly reduce delivered pressure.",
    category: "tubing",
    tagline: "Universal-fit hose",
    replacementHint: "Replace every 3 months",
    unitAmountCents: 2900,
  },
  {
    sku: "starter-tubing-heated",
    name: "Heated CPAP Tubing — 6 ft",
    description:
      "A heated CPAP hose that warms the air path to reduce condensation, or rainout, when used with a compatible humidifier. Includes the standard cuffs found on most masks and machines. Confirm machine compatibility before use.",
    category: "tubing",
    tagline: "Reduces hose rainout",
    replacementHint: "Replace every 3 months",
    unitAmountCents: 4900,
  },

  // ── Filters ──
  {
    sku: "starter-filter-disposable",
    name: "Disposable CPAP Filters — Pack",
    description:
      "A pack of disposable fine filters that trap dust and airborne particles before they reach the airflow path. These filters are not washable and should be discarded and replaced on schedule. Confirm fit for your machine.",
    category: "filter",
    tagline: "Single-use fine filters",
    replacementHint: "Replace every 2 weeks",
    unitAmountCents: 1200,
  },
  {
    sku: "starter-filter-reusable",
    name: "Reusable CPAP Filter",
    description:
      "A washable foam filter that captures larger particles and can be rinsed and air-dried between uses. Rinse regularly and replace periodically as the foam breaks down over time. Confirm fit for your machine.",
    category: "filter",
    tagline: "Washable foam filter",
    replacementHint: "Replace every 6 months",
    unitAmountCents: 1500,
  },
  {
    sku: "starter-filter-variety-pack",
    name: "CPAP Filter Variety Pack",
    description:
      "A combined pack of disposable fine filters and a washable foam filter, covering both filtration stages most machines use. A convenient single SKU for keeping spares of each on hand. Confirm fit for your machine.",
    category: "filter",
    tagline: "Disposable + reusable in one",
    replacementHint: "Replace per filter type",
    unitAmountCents: 1900,
  },

  // ── Headgear ──
  {
    sku: "starter-headgear-nasal-pillows",
    name: "Replacement Headgear — Nasal Pillows Mask",
    description:
      "Replacement headgear straps for standard nasal-pillow masks. Elastic loses tension with washing and wear, so fresh straps restore a secure, even hold and help maintain the seal through the night.",
    category: "headgear",
    tagline: "Restores strap tension",
    replacementHint: "Replace every 6 months",
    unitAmountCents: 2400,
  },
  {
    sku: "starter-headgear-nasal",
    name: "Replacement Headgear — Nasal Mask",
    description:
      "Replacement headgear straps for standard nasal masks. Worn-out elastic is a common cause of slow leaks and overtightening; new straps keep the cushion seated with comfortable, even pressure.",
    category: "headgear",
    tagline: "Even, comfortable hold",
    replacementHint: "Replace every 6 months",
    unitAmountCents: 2900,
  },
  {
    sku: "starter-headgear-full-face",
    name: "Replacement Headgear — Full Face Mask",
    description:
      "Replacement headgear straps for standard full face masks. The larger cushion relies on balanced strap tension to seal; fresh headgear helps it hold evenly without overtightening at higher pressures.",
    category: "headgear",
    tagline: "Balanced full-face support",
    replacementHint: "Replace every 6 months",
    unitAmountCents: 3900,
  },
  {
    sku: "starter-chinstrap",
    name: "CPAP Chinstrap",
    description:
      "An adjustable chinstrap that helps keep the mouth gently closed during therapy, often used alongside a nasal or nasal-pillow mask to reduce mouth leak. Fits a range of head sizes. Not a substitute for a full face mask.",
    category: "headgear",
    tagline: "Helps reduce mouth leak",
    replacementHint: "Replace every 6 months",
    unitAmountCents: 2400,
  },

  // ── Chamber ──
  {
    sku: "starter-chamber-humidifier",
    name: "Humidifier Water Chamber",
    description:
      "A replacement water chamber for heated CPAP humidifiers. Over time chambers develop mineral scale and cloudiness that cleaning cannot fully remove, so periodic replacement keeps humidification clean. Confirm fit for your machine.",
    category: "chamber",
    tagline: "Clean, scale-free humidity",
    replacementHint: "Replace every 6 months",
    unitAmountCents: 5500,
  },

  // ── Accessories ──
  {
    sku: "starter-accessory-cleaning-wipes",
    name: "CPAP Cleaning Wipes",
    description:
      "Unscented cleaning wipes sized for masks, cushions, and tubing to remove oils and residue between deeper washes. A quick daily wipe of the cushion helps the seal last longer and keeps equipment fresh.",
    category: "accessory",
    tagline: "Daily mask cleaning",
    replacementHint: "Reorder when running low",
    unitAmountCents: 1900,
  },
  {
    sku: "starter-accessory-travel-case",
    name: "CPAP Travel Case",
    description:
      "A padded carry case sized for a typical travel CPAP machine plus mask and tubing, with interior room for filters and small accessories. Helps protect equipment in luggage and keep a setup organized on the go.",
    category: "accessory",
    tagline: "Protects gear on the go",
    replacementHint: "Replace as needed",
    unitAmountCents: 3900,
  },
  {
    sku: "starter-accessory-tube-brush",
    name: "CPAP Tube Cleaning Brush",
    description:
      "A long flexible brush sized to clean the inside of standard CPAP tubing, reaching residue a rinse alone leaves behind. Regular cleaning helps keep the air path clear. Reorder when the bristles wear down.",
    category: "accessory",
    tagline: "Cleans inside the hose",
    replacementHint: "Reorder when worn",
    unitAmountCents: 900,
  },
  {
    sku: "starter-accessory-mask-clips",
    name: "Replacement Mask Clips — Pair",
    description:
      "A pair of replacement clips that connect headgear to the mask frame. Clips can loosen or crack with daily use; a fresh pair restores a secure attachment without replacing the whole mask. Confirm fit for your mask.",
    category: "accessory",
    tagline: "Secure headgear attachment",
    replacementHint: "Replace as needed",
    unitAmountCents: 1200,
  },

  // ── Bundles ──
  {
    sku: "starter-bundle-comfort-starter-kit",
    name: "Comfort Starter Kit",
    description:
      "A starting set of the everyday parts that wear fastest, gathered into one order so a new setup has fresh consumables on hand. A simple way to begin a regular resupply habit without picking each item separately.",
    category: "bundle",
    tagline: "Everyday essentials in one box",
    replacementHint: "Set-and-forget every 3 months",
    unitAmountCents: 5500,
    bundleContents: [
      "1x Replacement cushion or nasal pillows",
      "1x Standard CPAP tubing",
      "2x Disposable filters",
    ],
  },
  {
    sku: "starter-bundle-quarterly-refresh-kit",
    name: "Quarterly Refresh Kit",
    description:
      "A quarterly bundle of the consumables most therapy schedules replace every few months, combined to keep a setup performing well between visits. Sized to align with a typical three-month resupply cadence.",
    category: "bundle",
    tagline: "One order per quarter",
    replacementHint: "Set-and-forget every 3 months",
    unitAmountCents: 8900,
    bundleContents: [
      "1x Replacement cushion or nasal pillows",
      "1x Standard CPAP tubing",
      "2x Disposable filters",
      "1x Reusable filter",
    ],
  },
  {
    sku: "starter-bundle-headgear-refresh-kit",
    name: "Headgear Refresh Kit",
    description:
      "A focused bundle for the soft goods that hold the mask in place. Refreshing straps and chinstrap together restores even tension across the setup and helps prevent the slow leaks that come with stretched elastic.",
    category: "bundle",
    tagline: "Fresh straps, steady seal",
    replacementHint: "Set-and-forget every 6 months",
    unitAmountCents: 6500,
    bundleContents: ["1x Replacement headgear", "1x CPAP chinstrap"],
  },
  {
    sku: "starter-bundle-travel-kit",
    name: "Travel Kit",
    description:
      "A travel-ready bundle pairing a padded carry case with a spare set of fast-wearing consumables, so a trip does not interrupt therapy. Keeps backups and equipment organized in one place for the road.",
    category: "bundle",
    tagline: "Therapy that travels",
    replacementHint: "Refresh before each trip",
    unitAmountCents: 7900,
    bundleContents: [
      "1x CPAP travel case",
      "1x Replacement cushion or nasal pillows",
      "2x Disposable filters",
      "1x CPAP cleaning wipes",
    ],
  },
  {
    sku: "starter-bundle-annual-reset-kit",
    name: "Annual Reset Kit",
    description:
      "A once-a-year bundle that brings the whole setup back to like-new, covering the longer-life parts a yearly reset typically replaces. A convenient way to refresh the items that are easy to forget between routine reorders.",
    category: "bundle",
    tagline: "Whole-setup yearly refresh",
    replacementHint: "Set-and-forget once a year",
    unitAmountCents: 19900,
    bundleContents: [
      "1x Replacement mask of choice",
      "1x Humidifier water chamber",
      "1x Heated CPAP tubing",
      "1x Replacement headgear",
    ],
  },
];

export interface StarterCatalogSeedResult {
  /** Products newly created this run. */
  created: number;
  /** Existing products (matched by shop_sku) updated this run. */
  updated: number;
  /** Prices created (new product, or amount changed → rotated default_price). */
  pricesCreated: number;
  /** Total catalog items processed. */
  total: number;
}

function metadataFor(item: StarterProduct): Record<string, string> {
  const metadata: Record<string, string> = {
    shop_sku: item.sku,
    category: item.category,
    tagline: item.tagline,
    replacement_hint: item.replacementHint,
  };
  if (item.bundleContents && item.bundleContents.length > 0) {
    metadata.bundle = "true";
    // Stripe metadata values cap at 500 chars; bundle contents are short.
    // JSON-encode for robust round-tripping (parsed by products-meta.ts).
    metadata.bundle_contents = JSON.stringify(item.bundleContents);
  }
  return metadata;
}

/**
 * Idempotently provision the tenant-neutral starter catalog into the Stripe
 * account selected by `requestOptions` (a connected account when
 * `{ stripeAccount }` is passed, otherwise the platform account).
 *
 * For each item: find the existing product by `metadata.shop_sku` and update
 * it, or create it; then ensure a one-time USD `default_price` at the listed
 * amount exists (creating + repointing only when missing or changed). Safe
 * to re-run — it never duplicates a SKU.
 *
 * Returns counts for the caller to surface / audit. Throws on the first
 * Stripe error so the route can report a clean failure; partial progress
 * from a mid-run failure is harmless because a re-run is idempotent.
 */
export async function seedStarterCatalog(
  stripe: Stripe,
  opts: {
    requestOptions?: Stripe.RequestOptions;
    /** Catalog to seed; defaults to {@link STARTER_CATALOG}. Injectable for tests. */
    catalog?: StarterProduct[];
  } = {},
): Promise<StarterCatalogSeedResult> {
  const requestOptions = opts.requestOptions ?? {};
  const catalog = opts.catalog ?? STARTER_CATALOG;
  const result: StarterCatalogSeedResult = {
    created: 0,
    updated: 0,
    pricesCreated: 0,
    total: catalog.length,
  };

  for (const item of catalog) {
    // Match by SKU regardless of active state (an archived SKU must be
    // matched + reactivated, not duplicated) — same rule as the seed script.
    const existing = await stripe.products.search(
      { query: `metadata['shop_sku']:'${item.sku}'`, limit: 1 },
      requestOptions,
    );

    const metadata = metadataFor(item);
    let product: Stripe.Product;
    if (existing.data[0]) {
      product = await stripe.products.update(
        existing.data[0].id,
        {
          name: item.name,
          description: item.description,
          metadata,
          active: true,
        },
        requestOptions,
      );
      result.updated += 1;
    } else {
      product = await stripe.products.create(
        { name: item.name, description: item.description, metadata },
        requestOptions,
      );
      result.created += 1;
    }

    // Reuse the existing default price when its amount/currency/type still
    // match; otherwise create a new one-time price and repoint default_price
    // (Stripe Prices are immutable).
    const currentDefaultId =
      typeof product.default_price === "string"
        ? product.default_price
        : product.default_price?.id;

    let needsNewPrice = true;
    if (currentDefaultId) {
      const current = await stripe.prices.retrieve(
        currentDefaultId,
        {},
        requestOptions,
      );
      if (
        current.active &&
        current.unit_amount === item.unitAmountCents &&
        current.currency === "usd" &&
        current.type === "one_time"
      ) {
        needsNewPrice = false;
      }
    }

    if (needsNewPrice) {
      const price = await stripe.prices.create(
        {
          product: product.id,
          unit_amount: item.unitAmountCents,
          currency: "usd",
        },
        requestOptions,
      );
      await stripe.products.update(
        product.id,
        { default_price: price.id },
        requestOptions,
      );
      result.pricesCreated += 1;
    }
  }

  return result;
}
