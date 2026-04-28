// Preview catalog — fixture products served by /shop/products when no
// STRIPE_SECRET_KEY is configured.
//
// Why this exists:
//   The shop is a real-money surface, so we fail-closed on the
//   payment side (checkout + webhook still 503 without Stripe). But
//   the catalog itself is just product copy/prices, and the storefront
//   UX is much easier to build, demo, and design for if it always
//   renders SOMETHING. So instead of a "shop coming soon" wall, an
//   un-configured environment serves this static catalog with a
//   `previewMode: true` flag so the frontend can show a banner and
//   gate the Checkout button.
//
// Source of truth:
//   The data here MUST mirror scripts/src/seed-stripe-products.ts.
//   When you add or change a SKU there, mirror it here. Both files
//   are short and reading them side-by-side is the intended workflow.
//
// IDs:
//   Synthetic IDs prefixed `prod_preview_` / `price_preview_` so they
//   can never be confused with real Stripe IDs (which are random
//   alphanumeric suffixes). The shop checkout endpoint refuses to
//   create a Stripe Session when Stripe isn't configured anyway, so
//   these IDs never reach Stripe.

import type { ShopProductView } from "./products-meta";

interface PreviewSeed {
  sku: string;
  name: string;
  description: string;
  category: ShopProductView["category"];
  tagline: string;
  replacementHint: string;
  unitAmountCents: number;
  bundleContents?: string[];
}

const SEED: PreviewSeed[] = [
  // ── Masks ────────────────────────────────────────────────────────
  {
    sku: "mask-nasal-pillows-medium",
    name: "Nasal Pillows Mask — Medium",
    description:
      "Lightweight nasal pillows mask for active sleepers. Includes frame, cushion (medium pillows), and headgear. Compatible with all major CPAP machines.",
    category: "mask",
    tagline: "Most popular for side sleepers",
    replacementHint: "Replace mask every ~3 months",
    unitAmountCents: 11900,
  },
  {
    sku: "mask-nasal-fitpack",
    name: "Nasal Mask — Fit Pack (S/M/L)",
    description:
      "Traditional nasal mask with a fit pack of three cushion sizes (small, medium, large) so you can dial in the seal at home. Includes frame, three cushions, and headgear.",
    category: "mask",
    tagline: "Best value: three cushion sizes included",
    replacementHint: "Replace mask every ~3 months",
    unitAmountCents: 12900,
  },
  {
    sku: "mask-fullface-medium",
    name: "Full Face Mask — Medium",
    description:
      "Full-face CPAP mask for mouth-breathers and high-pressure users. Includes frame, medium cushion, and headgear. Compatible with all major CPAP machines.",
    category: "mask",
    tagline: "For mouth-breathers and higher pressures",
    replacementHint: "Replace mask every ~3 months",
    unitAmountCents: 15900,
  },

  // ── Cushions (replacement only) ──────────────────────────────────
  {
    sku: "cushion-nasal-medium",
    name: "Replacement Nasal Cushion — Medium",
    description:
      "Single replacement nasal cushion. Compatible with most ResMed and Philips Respironics nasal frames.",
    category: "cushion",
    tagline: "Single cushion replacement",
    replacementHint: "Replace every 2 weeks – 1 month",
    unitAmountCents: 3500,
  },
  {
    sku: "cushion-nasal-pillows-pair",
    name: "Replacement Nasal Pillows — Pair (Medium)",
    description:
      "Pair of replacement nasal pillows. Direct fit on most pillow-style nasal frames.",
    category: "cushion",
    tagline: "Restore the original seal",
    replacementHint: "Replace every 2 weeks – 1 month",
    unitAmountCents: 2900,
  },
  {
    sku: "cushion-fullface-medium",
    name: "Replacement Full Face Cushion — Medium",
    description:
      "Single replacement cushion for full-face masks. Compatible with most ResMed and Philips Respironics full-face frames.",
    category: "cushion",
    tagline: "Single cushion replacement",
    replacementHint: "Replace every 2 weeks – 1 month",
    unitAmountCents: 4500,
  },

  // ── Tubing ───────────────────────────────────────────────────────
  {
    sku: "tubing-standard-6ft",
    name: "Standard CPAP Tubing — 6ft",
    description:
      "Universal 22mm CPAP tubing, six feet. Fits all standard CPAP and BiPAP machines.",
    category: "tubing",
    tagline: "Universal fit, six-foot length",
    replacementHint: "Replace every 3 months",
    unitAmountCents: 2900,
  },
  {
    sku: "tubing-heated-6ft",
    name: "Heated CPAP Tubing — 6ft",
    description:
      "Climate-controlled heated tubing, six feet. Compatible with ResMed AirSense 10 and AirSense 11 ClimateLine systems.",
    category: "tubing",
    tagline: "Reduces rainout in cold rooms",
    replacementHint: "Replace every 3 months",
    unitAmountCents: 4900,
  },

  // ── Filters ──────────────────────────────────────────────────────
  {
    sku: "filter-disposable-6pack",
    name: "Disposable Filters — 6 Pack",
    description:
      "Six disposable hypoallergenic filters. Universal fit for ResMed AirSense and Philips DreamStation machines.",
    category: "filter",
    tagline: "Six months of disposable filtration",
    replacementHint: "Replace every 2 weeks",
    unitAmountCents: 1500,
  },
  {
    sku: "filter-reusable-2pack",
    name: "Reusable Foam Filters — 2 Pack",
    description:
      "Two washable foam pre-filters. Rinse weekly, replace every 6 months.",
    category: "filter",
    tagline: "Wash weekly, replace twice a year",
    replacementHint: "Replace every 6 months",
    unitAmountCents: 1200,
  },

  // ── Headgear & straps ────────────────────────────────────────────
  {
    sku: "headgear-universal",
    name: "Replacement Headgear",
    description:
      "Universal replacement headgear with adjustable straps. Compatible with most nasal and full-face mask frames.",
    category: "headgear",
    tagline: "Restore tension, lose the red marks",
    replacementHint: "Replace every 6 months",
    unitAmountCents: 3900,
  },
  {
    sku: "chinstrap-adjustable",
    name: "Adjustable Chinstrap",
    description:
      "Soft adjustable chinstrap to keep your jaw closed during therapy. Pairs with nasal masks for mouth-breathers.",
    category: "headgear",
    tagline: "Keep your mouth closed at night",
    replacementHint: "Replace every 6 months",
    unitAmountCents: 2400,
  },

  // ── Humidifier chambers ──────────────────────────────────────────
  {
    sku: "chamber-airsense-10",
    name: "Humidifier Water Chamber — AirSense 10/11",
    description:
      "Replacement water chamber for ResMed AirSense 10 and AirSense 11 humidifiers.",
    category: "chamber",
    tagline: "Mineral-free fresh chamber",
    replacementHint: "Replace every 6 months",
    unitAmountCents: 5500,
  },

  // ── Accessories ──────────────────────────────────────────────────
  {
    sku: "wipes-mask-62",
    name: "Mask & Tubing Wipes — 62 ct.",
    description:
      "Unscented daily-use wipes safe for silicone cushions, frames, and tubing. 62 wipes per canister.",
    category: "accessory",
    tagline: "Daily cleaning, no harsh residue",
    replacementHint: "Use daily on cushion + frame",
    unitAmountCents: 1900,
  },

  // ── Bundles ──────────────────────────────────────────────────────
  {
    sku: "bundle-quarterly-refresh",
    name: "Quarterly Refresh Bundle",
    description:
      "Everything you should replace every three months in one box: nasal cushion, six-foot tubing, six-pack of filters, and a canister of cleaning wipes.",
    category: "bundle",
    tagline: "Save vs. buying separately",
    replacementHint: "Set-and-forget every 3 months",
    unitAmountCents: 8900,
    bundleContents: [
      "1× Replacement nasal cushion (medium)",
      "1× Standard tubing — 6ft",
      "1× Disposable filters — 6 pack",
      "1× Mask & tubing wipes (62 ct.)",
    ],
  },
  {
    sku: "bundle-headgear-refresh",
    name: "Headgear Refresh Bundle",
    description:
      "Twice-yearly headgear pack. Replacement headgear plus adjustable chinstrap for mouth-breathers.",
    category: "bundle",
    tagline: "Twice-a-year fit refresh",
    replacementHint: "Set-and-forget every 6 months",
    unitAmountCents: 5500,
    bundleContents: ["1× Replacement headgear", "1× Adjustable chinstrap"],
  },
  {
    sku: "bundle-travel-kit",
    name: "Travel Kit Bundle",
    description:
      "Spare tubing, a fresh disposable filter pack, and cleaning wipes — packed for the suitcase, not the nightstand.",
    category: "bundle",
    tagline: "Spare set for the road",
    replacementHint: "Keep in your suitcase",
    unitAmountCents: 5900,
    bundleContents: [
      "1× Standard tubing — 6ft",
      "1× Disposable filters — 6 pack",
      "1× Mask & tubing wipes (62 ct.)",
    ],
  },
  {
    sku: "bundle-annual-reset",
    name: "Annual Reset Bundle",
    description:
      "Once-a-year deep refresh: a brand-new mask, fresh headgear, new humidifier chamber, and a year of disposable filters.",
    category: "bundle",
    tagline: "Once-a-year deep refresh",
    replacementHint: "Set-and-forget every 12 months",
    unitAmountCents: 27900,
    bundleContents: [
      "1× Nasal mask (fit pack)",
      "1× Replacement headgear",
      "1× Humidifier water chamber",
      "2× Disposable filters — 6 pack (full year)",
    ],
  },
];

/**
 * Return the preview catalog as `ShopProductView[]` — exactly the same
 * shape the products endpoint normally derives from Stripe. Callers
 * should NOT cache this; it's already a constant in memory and a fresh
 * `.map(...)` is a few microseconds.
 */
export function getPreviewCatalog(): ShopProductView[] {
  return SEED.map((s) => ({
    id: `prod_preview_${s.sku}`,
    name: s.name,
    description: s.description,
    category: s.category,
    tagline: s.tagline,
    isBundle: s.category === "bundle" || (s.bundleContents?.length ?? 0) > 0,
    bundleContents: s.bundleContents ?? [],
    replacementHint: s.replacementHint,
    imageUrl: null,
    price: {
      id: `price_preview_${s.sku}`,
      unitAmount: s.unitAmountCents,
      currency: "usd",
    },
  }));
}
