// seed-stripe-products — idempotently provisions PennPaps shop catalog
// in the configured Stripe account.
//
// Run with:
//   pnpm --filter @workspace/scripts run seed:shop
//
// What this script writes (per item):
//   - Stripe Product (name, description, metadata, images)
//   - Stripe Price (one-time, USD, in whole-dollar cents)
//   - default_price set on the product so /shop/products picks it up
//
// Idempotency:
//   Each item carries a stable `metadata.shop_sku` string. We
//   stripe.products.search by this sku before creating; if found,
//   we update name/description/metadata on the existing product
//   rather than creating a duplicate. Re-running this script is
//   always safe.
//
// Pricing notes (per user direction, "industry-standard placeholder"):
//   These are typical 2024-2025 retail prices for CPAP supplies in
//   the US cash-pay market. Compare to ResMed MyCPAP, CPAP Supply
//   USA, Easy Breathe etc. They are NOT meant to undercut the
//   insurance flow — that's the point of the dual UX. Prices are
//   stored in cents.
//
// Images:
//   Stripe accepts up to 8 image URLs per Product (publicly fetchable
//   over HTTPS). The `imagePath` field below is a path relative to
//   the cpap-fitter web app. We translate it to an absolute URL via
//   the SHOP_PUBLIC_BASE_URL env var (e.g. "https://app.pennpaps.com")
//   before passing to Stripe. If SHOP_PUBLIC_BASE_URL is unset, we
//   skip the images update — the seed still runs, it just leaves
//   product images alone.

import Stripe from "stripe";

interface SeedProduct {
  sku: string;
  name: string;
  description: string;
  category:
    | "mask"
    | "cushion"
    | "tubing"
    | "filter"
    | "headgear"
    | "chamber"
    | "accessory"
    | "bundle";
  tagline: string;
  replacementHint: string;
  unitAmountCents: number;
  manufacturer: string;
  modelNumber: string;
  /** Path under the cpap-fitter `public/` dir, e.g. "/products/airfit-p10.webp". */
  imagePath: string;
  bundleContents?: string[];
}

const PRODUCTS: SeedProduct[] = [
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
    imagePath: "/products/airfit-p10.webp",
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
    imagePath: "/products/airfit-n20.webp",
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
    imagePath: "/products/airfit-f30i.webp",
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
    imagePath: "/products/cushion-n20.webp",
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
    imagePath: "/products/cushion-p10.jpg",
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
    imagePath: "/products/cushion-f30i.webp",
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
    imagePath: "/products/tubing-slimline.webp",
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
    imagePath: "/products/tubing-climateline.webp",
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
    imagePath: "/products/filter-disposable.png",
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
    imagePath: "/products/filter-reusable.webp",
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
    imagePath: "/products/headgear-n20.webp",
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
    imagePath: "/products/chinstrap.png",
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
    imagePath: "/products/chamber-airsense.webp",
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
    imagePath: "/products/wipes-citrus.jpg",
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
    imagePath: "/products/cushion-n20.webp",
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
    imagePath: "/products/headgear-n20.webp",
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
    imagePath: "/products/tubing-slimline.webp",
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
    imagePath: "/products/airfit-n20.webp",
    bundleContents: [
      "1× ResMed AirFit N20 nasal mask · fit pack S/M/L (#63550)",
      "1× ResMed AirFit N20 replacement headgear (#63558)",
      "1× ResMed HumidAir standard water chamber (#37299)",
      "2× ResMed disposable filters — 6 pack · full year (#36850)",
    ],
  },
];

async function main(): Promise<void> {
  const secret = process.env.STRIPE_SECRET_KEY;
  if (!secret) {
    console.error(
      "STRIPE_SECRET_KEY is not set. Add it via Replit Secrets and re-run.",
    );
    process.exit(1);
  }

  // Optional: where the cpap-fitter web app is publicly reachable, so
  // we can build absolute image URLs Stripe can fetch. If unset, we
  // simply skip the images field on the upsert.
  const publicBase = process.env.SHOP_PUBLIC_BASE_URL?.replace(/\/+$/, "");
  if (!publicBase) {
    console.warn(
      "SHOP_PUBLIC_BASE_URL is not set — product images will NOT be uploaded to Stripe.\n" +
        "Set it (e.g. https://app.pennpaps.com) and re-run to attach product photos.",
    );
  }

  const stripe = new Stripe(secret, { typescript: true });

  console.log(`Seeding ${PRODUCTS.length} products into Stripe…`);

  for (const item of PRODUCTS) {
    const existing = await stripe.products.search({
      query: `metadata['shop_sku']:'${item.sku}' AND active:'true'`,
      limit: 1,
    });

    const metadata: Record<string, string> = {
      shop_sku: item.sku,
      category: item.category,
      tagline: item.tagline,
      replacement_hint: item.replacementHint,
      manufacturer: item.manufacturer,
      model_number: item.modelNumber,
    };
    if (item.bundleContents && item.bundleContents.length > 0) {
      metadata.bundle = "true";
      // Stripe metadata values cap at 500 chars; bundle contents
      // are short, but we json-encode for robust round-tripping.
      metadata.bundle_contents = JSON.stringify(item.bundleContents);
    }

    const updatePayload: Stripe.ProductUpdateParams = {
      name: item.name,
      description: item.description,
      metadata,
    };
    const createPayload: Stripe.ProductCreateParams = {
      name: item.name,
      description: item.description,
      metadata,
    };
    if (publicBase) {
      const imgUrl = `${publicBase}${item.imagePath}`;
      updatePayload.images = [imgUrl];
      createPayload.images = [imgUrl];
    }

    let product: Stripe.Product;
    if (existing.data[0]) {
      product = await stripe.products.update(existing.data[0].id, updatePayload);
      console.log(`  ↻ ${item.sku}  (${product.id}) — updated`);
    } else {
      product = await stripe.products.create(createPayload);
      console.log(`  + ${item.sku}  (${product.id}) — created`);
    }

    // Reuse the default price if its unit_amount + currency haven't
    // changed — re-creating prices on every run would clutter the
    // Stripe dashboard. If the amount changed, create a new price
    // and rotate default_price (the old one stays on past sessions
    // for refund/retrieval, but new sessions use the new price).
    const currentDefaultId =
      typeof product.default_price === "string"
        ? product.default_price
        : product.default_price?.id;

    let needsNewPrice = true;
    if (currentDefaultId) {
      const current = await stripe.prices.retrieve(currentDefaultId);
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
      const price = await stripe.prices.create({
        product: product.id,
        unit_amount: item.unitAmountCents,
        currency: "usd",
      });
      await stripe.products.update(product.id, { default_price: price.id });
      console.log(
        `      price → $${(item.unitAmountCents / 100).toFixed(2)} (${price.id})`,
      );
    } else {
      console.log(
        `      price unchanged at $${(item.unitAmountCents / 100).toFixed(2)}`,
      );
    }
  }

  console.log("\n✓ Seed complete.");
}

main().catch((err) => {
  console.error("Seed failed:", err);
  process.exit(1);
});
