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
//
// Image paths:
//   `imageUrl` here is a path RELATIVE to the cpap-fitter web app's
//   base path (e.g. "/products/airfit-p10.webp"). The cpap-fitter UI
//   resolves it against `import.meta.env.BASE_URL`. In production the
//   field is filled with absolute Stripe CDN URLs from the Stripe
//   Product `images` array, so the frontend handles both cases by
//   sniffing for `^https?://`.

import { formatIntervalLabel, type ShopProductView } from "./products-meta";

interface PreviewSeed {
  sku: string;
  name: string;
  description: string;
  category: ShopProductView["category"];
  tagline: string;
  replacementHint: string;
  unitAmountCents: number;
  manufacturer: string;
  modelNumber: string;
  imageUrl: string;
  bundleContents?: string[];
  /**
   * Optional preview-only stock count. `undefined` mirrors the
   * production "not tracked" path (renders without any stock badge).
   * A small number (e.g. 3) lets the dev exercise the "Only N left"
   * UI; `0` exercises the "Out of stock" UI without touching real
   * Stripe data.
   */
  stockCount?: number;
}

/**
 * Default recurring cadence per category for the preview catalog.
 * Categories not in this map (only `mask` today) don't get a
 * synthesized recurring price — masks are infrequent enough that
 * subscribing them invites unwanted boxes more than convenience.
 */
const PREVIEW_RECURRING_CADENCE: Partial<
  Record<
    ShopProductView["category"],
    { interval: "day" | "week" | "month" | "year"; intervalCount: number }
  >
> = {
  cushion: { interval: "month", intervalCount: 1 },
  filter: { interval: "month", intervalCount: 1 },
  tubing: { interval: "month", intervalCount: 3 },
  headgear: { interval: "month", intervalCount: 3 },
  chamber: { interval: "month", intervalCount: 6 },
  accessory: { interval: "month", intervalCount: 1 },
  bundle: { interval: "month", intervalCount: 3 },
};

const SEED: PreviewSeed[] = [
  // ── Masks ────────────────────────────────────────────────────────
  {
    sku: "mask-nasal-pillows-medium",
    name: "ResMed AirFit P10 Nasal Pillows Mask — Medium",
    description:
      "ResMed's flagship nasal pillows mask. The QuietAir vent is 50% quieter than the predecessor, and the dual-strap headgear weighs almost nothing — most patients forget they're wearing it. Includes frame, medium nasal pillows, headgear, and clip system. Compatible with all standard CPAP and BiPAP machines.",
    category: "mask",
    tagline: "Most popular for side sleepers",
    replacementHint: "Replace mask every ~3 months",
    unitAmountCents: 11900,
    manufacturer: "ResMed",
    modelNumber: "62932",
    imageUrl: "/products/airfit-p10.webp",
  },
  {
    sku: "mask-nasal-fitpack",
    name: "ResMed AirFit N20 Nasal Mask — Fit Pack (S/M/L)",
    description:
      "Traditional nasal mask with InfinitySeal silicone cushion that conforms to a wide range of facial profiles. Fit pack includes three cushion sizes (small, medium, large) so you can dial in the seal at home without a re-fit appointment. Includes frame, three cushions, and magnetic-clip headgear.",
    category: "mask",
    tagline: "Best value: three cushion sizes included",
    replacementHint: "Replace mask every ~3 months",
    unitAmountCents: 12900,
    manufacturer: "ResMed",
    modelNumber: "63550",
    imageUrl: "/products/airfit-n20.webp",
  },
  {
    sku: "mask-fullface-medium",
    name: "ResMed AirFit F30i Full Face Mask — Medium",
    description:
      "Top-of-tube full-face mask designed for mouth-breathers, higher pressures, and side sleepers who hate traditional under-the-nose full-face masks. The hose connects at the crown of the head, so you can sleep on your stomach without dislodging the seal. Includes frame, medium cushion, headgear, and tube.",
    category: "mask",
    tagline: "For mouth-breathers and higher pressures",
    replacementHint: "Replace mask every ~3 months",
    unitAmountCents: 15900,
    manufacturer: "ResMed",
    modelNumber: "63862",
    imageUrl: "/products/airfit-f30i.webp",
  },

  // ── Cushions (replacement only) ──────────────────────────────────
  {
    sku: "cushion-nasal-medium",
    name: "ResMed AirFit N20 Replacement Nasal Cushion — Medium",
    description:
      "Genuine ResMed replacement cushion for the AirFit N20 and AirFit N20 for Her nasal frames. The InfinitySeal silicone is the single highest-impact thing to refresh on time — air leaks creep up gradually, but a fresh cushion restores the original seal in seconds.",
    category: "cushion",
    tagline: "Single cushion replacement",
    replacementHint: "Replace every 2 weeks – 1 month",
    unitAmountCents: 3500,
    manufacturer: "ResMed",
    modelNumber: "63551",
    imageUrl: "/products/cushion-n20.webp",
  },
  {
    sku: "cushion-nasal-pillows-pair",
    name: "ResMed AirFit P10 Replacement Nasal Pillows — Medium",
    description:
      "Pair of replacement nasal pillows for the AirFit P10 series. Direct fit on the original P10 frame and on the P10 for Her. Replace every two weeks for highest seal quality.",
    category: "cushion",
    tagline: "Restore the original seal",
    replacementHint: "Replace every 2 weeks – 1 month",
    unitAmountCents: 2900,
    manufacturer: "ResMed",
    modelNumber: "62933",
    imageUrl: "/products/cushion-p10.jpg",
  },
  {
    sku: "cushion-fullface-medium",
    name: "ResMed AirFit F30i Replacement Cushion — Medium",
    description:
      "Genuine ResMed full-face replacement cushion for the AirFit F30i frame. Medium fit covers most adult face profiles. Direct fit, no tools required — pop the old cushion out, pop the new one in.",
    category: "cushion",
    tagline: "Single cushion replacement",
    replacementHint: "Replace every 2 weeks – 1 month",
    unitAmountCents: 4500,
    manufacturer: "ResMed",
    modelNumber: "63864",
    imageUrl: "/products/cushion-f30i.webp",
  },

  // ── Tubing ───────────────────────────────────────────────────────
  {
    sku: "tubing-standard-6ft",
    name: "ResMed SlimLine Standard CPAP Tubing — 6ft",
    description:
      "Genuine ResMed SlimLine 6ft tubing — 40% lighter than the original 22mm hose, with the same airflow. Universal fit for AirSense 10, AirSense 11, AirCurve, and S9 series machines, plus most third-party CPAPs.",
    category: "tubing",
    tagline: "Lightweight, six-foot length",
    replacementHint: "Replace every 3 months",
    unitAmountCents: 2900,
    manufacturer: "ResMed",
    modelNumber: "36995",
    imageUrl: "/products/tubing-slimline.webp",
  },
  {
    sku: "tubing-heated-6ft",
    name: "ResMed ClimateLineAir Heated Tubing — 6ft",
    description:
      "Climate-controlled heated tubing for ResMed AirSense 10 and AirSense 11 ClimateLine systems. Eliminates rainout (water condensation in the hose) on cold mornings and lets the AirSense automatically tune temperature + humidity as ambient conditions change.",
    category: "tubing",
    tagline: "Eliminates rainout in cold rooms",
    replacementHint: "Replace every 3 months",
    unitAmountCents: 4900,
    manufacturer: "ResMed",
    modelNumber: "37296",
    imageUrl: "/products/tubing-climateline.webp",
    // Preview-only: low-stock state, drives the "Only N left" UI in
    // dev / when STRIPE_SECRET_KEY is unset. Production reads
    // Stripe metadata.
    stockCount: 3,
  },

  // ── Filters ──────────────────────────────────────────────────────
  {
    sku: "filter-disposable-6pack",
    name: "ResMed AirSense Hypoallergenic Disposable Filter — 6 Pack",
    description:
      "Six genuine ResMed hypoallergenic disposable filters — six months of filtration at the recommended bi-weekly cadence. Direct fit for AirSense 10, AirSense 11, AirCurve 10, and S9-series machines.",
    category: "filter",
    tagline: "Six months of disposable filtration",
    replacementHint: "Replace every 2 weeks",
    unitAmountCents: 1500,
    manufacturer: "ResMed",
    modelNumber: "36850",
    imageUrl: "/products/filter-disposable.png",
    // Preview-only: zero-stock state, drives the "Out of stock" UI
    // (one-time disabled, subscribe & ship still available).
    stockCount: 0,
  },
  {
    sku: "filter-reusable-2pack",
    name: "ResMed AirSense Reusable Foam Filter — 2 Pack",
    description:
      "Two washable foam pre-filters for the AirSense 10 and AirSense 11. Rinse weekly under warm water, air-dry, replace every six months. A second filter in the rotation lets you swap dry-for-wet without missing a night of therapy.",
    category: "filter",
    tagline: "Wash weekly, replace twice a year",
    replacementHint: "Replace every 6 months",
    unitAmountCents: 1200,
    manufacturer: "ResMed",
    modelNumber: "36830",
    imageUrl: "/products/filter-reusable.webp",
  },

  // ── Headgear & straps ────────────────────────────────────────────
  {
    sku: "headgear-universal",
    name: "ResMed AirFit N20 Replacement Headgear — Standard",
    description:
      "Genuine ResMed replacement headgear with magnetic clips. Direct fit on the AirFit N20 and AirFit N20 for Her. Headgear stretches gradually with daily use — when you find yourself over-tightening to maintain the seal, it's time to replace.",
    category: "headgear",
    tagline: "Restore tension, lose the red marks",
    replacementHint: "Replace every 6 months",
    unitAmountCents: 3900,
    manufacturer: "ResMed",
    modelNumber: "63558",
    imageUrl: "/products/headgear-n20.webp",
  },
  {
    sku: "chinstrap-adjustable",
    name: "Sunset Healthcare Adjustable CPAP Chinstrap",
    description:
      "Soft adjustable neoprene chinstrap. Pairs with nasal masks (and nasal pillow setups) to keep your jaw closed during therapy — the simplest fix for waking up with a dry mouth even on a great seal. Universal sizing, hook-and-loop closure.",
    category: "headgear",
    tagline: "Stops the dry-mouth wake-up",
    replacementHint: "Replace every 6 months",
    unitAmountCents: 2400,
    manufacturer: "Sunset Healthcare",
    modelNumber: "CAP1006",
    imageUrl: "/products/chinstrap.png",
  },

  // ── Humidifier chambers ──────────────────────────────────────────
  {
    sku: "chamber-airsense-10",
    name: "ResMed HumidAir Standard Water Chamber — AirSense 10/11",
    description:
      "Genuine ResMed HumidAir standard water tub. Direct fit for AirSense 10, AirSense 11, and AirCurve 10 machines. Even with distilled water, mineral and biofilm buildup eventually compromises the chamber — replace every six months for the cleanest humidification.",
    category: "chamber",
    tagline: "Mineral-free fresh chamber",
    replacementHint: "Replace every 6 months",
    unitAmountCents: 5500,
    manufacturer: "ResMed",
    modelNumber: "37299",
    imageUrl: "/products/chamber-airsense.webp",
  },

  // ── Accessories ──────────────────────────────────────────────────
  {
    sku: "wipes-mask-62",
    name: "Citrus II CPAP Mask & Tubing Wipes — 62 ct.",
    description:
      "Citrus II unscented daily-use wipes — alcohol-free, latex-free, safe for silicone cushions, frames, and tubing. 62 wipes per canister, ~30 days of nightly use. Wiping down the cushion before bed extends seal life materially.",
    category: "accessory",
    tagline: "Daily cleaning, no harsh residue",
    replacementHint: "Use daily on cushion + frame",
    unitAmountCents: 1900,
    manufacturer: "Beaumont Products",
    modelNumber: "635871164",
    imageUrl: "/products/wipes-citrus.jpg",
  },

  // ── Bundles ──────────────────────────────────────────────────────
  {
    sku: "bundle-quarterly-refresh",
    name: "Quarterly Refresh Bundle",
    description:
      "Everything you should replace every three months in one box: a fresh AirFit N20 nasal cushion, a SlimLine tubing run, six months of disposable filters, and a canister of Citrus II wipes. Bundles save vs. à la carte and ship together — one box, one tracking number.",
    category: "bundle",
    tagline: "Save vs. buying separately",
    replacementHint: "Set-and-forget every 3 months",
    unitAmountCents: 8900,
    manufacturer: "PennPaps Curated Kit",
    modelNumber: "BUNDLE-Q",
    imageUrl: "/products/cushion-n20.webp",
    bundleContents: [
      "1× ResMed AirFit N20 cushion · medium (#63551)",
      "1× ResMed SlimLine tubing — 6ft (#36995)",
      "1× ResMed disposable filters — 6 pack (#36850)",
      "1× Citrus II mask & tubing wipes · 62 ct. (#635871164)",
    ],
  },
  {
    sku: "bundle-headgear-refresh",
    name: "Headgear Refresh Bundle",
    description:
      "Twice-yearly fit reset: a brand-new ResMed AirFit N20 headgear (so you can stop over-tightening) plus a Sunset Healthcare adjustable chinstrap for nasal-mask users dealing with dry mouth.",
    category: "bundle",
    tagline: "Twice-a-year fit refresh",
    replacementHint: "Set-and-forget every 6 months",
    unitAmountCents: 5500,
    manufacturer: "PennPaps Curated Kit",
    modelNumber: "BUNDLE-H",
    imageUrl: "/products/headgear-n20.webp",
    bundleContents: [
      "1× ResMed AirFit N20 replacement headgear (#63558)",
      "1× Sunset Healthcare adjustable chinstrap (#CAP1006)",
    ],
  },
  {
    sku: "bundle-travel-kit",
    name: "Travel Kit Bundle",
    description:
      "Spare set sized for the suitcase, not the nightstand: a SlimLine tubing run, a fresh disposable filter pack, and a canister of Citrus II wipes. Kept zipped in your travel kit, you don't have to dismantle your home setup every trip.",
    category: "bundle",
    tagline: "Spare set for the road",
    replacementHint: "Keep in your suitcase",
    unitAmountCents: 5900,
    manufacturer: "PennPaps Curated Kit",
    modelNumber: "BUNDLE-T",
    imageUrl: "/products/tubing-slimline.webp",
    bundleContents: [
      "1× ResMed SlimLine tubing — 6ft (#36995)",
      "1× ResMed disposable filters — 6 pack (#36850)",
      "1× Citrus II mask & tubing wipes · 62 ct. (#635871164)",
    ],
  },
  {
    sku: "bundle-annual-reset",
    name: "Annual Reset Bundle",
    description:
      "Once-a-year deep refresh — the supplies your insurance would replace on a 12-month cycle, packed in a single box: a brand-new ResMed AirFit N20 fit pack (three cushion sizes), fresh headgear, a clean HumidAir water chamber, and a year of disposable filters.",
    category: "bundle",
    tagline: "Once-a-year deep refresh",
    replacementHint: "Set-and-forget every 12 months",
    unitAmountCents: 27900,
    manufacturer: "PennPaps Curated Kit",
    modelNumber: "BUNDLE-A",
    imageUrl: "/products/airfit-n20.webp",
    bundleContents: [
      "1× ResMed AirFit N20 nasal mask · fit pack S/M/L (#63550)",
      "1× ResMed AirFit N20 replacement headgear (#63558)",
      "1× ResMed HumidAir standard water chamber (#37299)",
      "2× ResMed disposable filters — 6 pack · full year (#36850)",
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
  return SEED.map((s) => {
    const cadence = PREVIEW_RECURRING_CADENCE[s.category];
    return {
      id: `prod_preview_${s.sku}`,
      name: s.name,
      description: s.description,
      category: s.category,
      tagline: s.tagline,
      isBundle: s.category === "bundle" || (s.bundleContents?.length ?? 0) > 0,
      bundleContents: s.bundleContents ?? [],
      replacementHint: s.replacementHint,
      imageUrl: s.imageUrl,
      manufacturer: s.manufacturer,
      modelNumber: s.modelNumber,
      stockCount: s.stockCount ?? null,
      // Preview catalog doesn't model per-SKU thresholds — falling
      // back to `null` means the storefront uses the default of 5,
      // which is the same behavior production SKUs get before an
      // admin customizes the threshold. Lets dev mode exercise the
      // "low stock" path with the default threshold.
      lowStockThreshold: null,
      price: {
        id: `price_preview_${s.sku}`,
        unitAmount: s.unitAmountCents,
        currency: "usd",
      },
      recurringPrice: cadence
        ? {
            id: `price_preview_recurring_${s.sku}`,
            unitAmount: s.unitAmountCents,
            currency: "usd",
            interval: cadence.interval,
            intervalCount: cadence.intervalCount,
            intervalLabel: formatIntervalLabel(
              cadence.interval,
              cadence.intervalCount,
            ),
          }
        : null,
    };
  });
}
