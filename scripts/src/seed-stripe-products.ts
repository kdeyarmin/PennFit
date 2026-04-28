// seed-stripe-products — idempotently provisions PennPaps shop catalog
// in the configured Stripe account.
//
// Run with:
//   pnpm --filter @workspace/scripts run seed:shop
//
// What this script writes (per item):
//   - Stripe Product (name, description, metadata)
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
  bundleContents?: string[];
}

const PRODUCTS: SeedProduct[] = [
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
    bundleContents: [
      "1× Replacement headgear",
      "1× Adjustable chinstrap",
    ],
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

async function main(): Promise<void> {
  const secret = process.env.STRIPE_SECRET_KEY;
  if (!secret) {
    console.error(
      "STRIPE_SECRET_KEY is not set. Add it via Replit Secrets and re-run.",
    );
    process.exit(1);
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
    };
    if (item.bundleContents && item.bundleContents.length > 0) {
      metadata.bundle = "true";
      // Stripe metadata values cap at 500 chars; bundle contents
      // are short, but we json-encode for robust round-tripping.
      metadata.bundle_contents = JSON.stringify(item.bundleContents);
    }

    let product: Stripe.Product;
    if (existing.data[0]) {
      product = await stripe.products.update(existing.data[0].id, {
        name: item.name,
        description: item.description,
        metadata,
      });
      console.log(`  ↻ ${item.sku}  (${product.id}) — updated`);
    } else {
      product = await stripe.products.create({
        name: item.name,
        description: item.description,
        metadata,
      });
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
