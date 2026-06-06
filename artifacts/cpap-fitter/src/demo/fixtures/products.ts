// Seeded storefront catalog for demo mode. Mirrors the
// `ShopProductView` shape from src/lib/shop-api.ts. Image paths point
// at the real assets in public/products so the demo shop looks like
// the live one. Prices are in cents.

import type { ShopProductView } from "@/lib/shop-api";

type Category = ShopProductView["category"];

function price(unitAmount: number): ShopProductView["price"] {
  return { id: `demo_price_${unitAmount}`, unitAmount, currency: "usd" };
}

function monthly(unitAmount: number): ShopProductView["recurringPrice"] {
  return {
    id: `demo_price_${unitAmount}_sub`,
    unitAmount,
    currency: "usd",
    interval: "month",
    intervalCount: 3,
    intervalLabel: "3 months",
  };
}

export const DEMO_PRODUCTS: ShopProductView[] = [
  {
    id: "demo-prod-n20-cushion",
    name: "AirFit N20 Nasal Cushion",
    description:
      "Genuine ResMed replacement cushion for the AirFit N20. The InfinitySeal silicone adapts to a wide range of face shapes for a reliable, comfortable seal night after night.",
    category: "cushion",
    tagline: "Most popular replacement",
    isBundle: false,
    bundleContents: [],
    replacementHint: "Replace every 30 days",
    imageUrl: "/products/cushion-n20.webp",
    manufacturer: "ResMed",
    modelNumber: "63550",
    price: price(2999),
    recurringPrice: monthly(2999),
    stockCount: null,
    lowStockThreshold: null,
  },
  {
    id: "demo-prod-p10-pillows",
    name: "AirFit P10 Nasal Pillows",
    description:
      "Featherweight nasal pillows for the AirFit P10 — the quiet, barely-there option preferred by active sleepers and travelers.",
    category: "cushion",
    tagline: "Lightest seal",
    isBundle: false,
    bundleContents: [],
    replacementHint: "Replace every 14 days",
    imageUrl: "/products/cushion-p10.jpg",
    manufacturer: "ResMed",
    modelNumber: "62932",
    price: price(2449),
    recurringPrice: monthly(2449),
    stockCount: 2,
    lowStockThreshold: 5,
  },
  {
    id: "demo-prod-f30i-cushion",
    name: "AirFit F30i Full Face Cushion",
    description:
      "Under-the-nose full-face cushion for the AirFit F30i. Covers less of the face while still sealing for higher pressures.",
    category: "cushion",
    tagline: "Minimal contact full face",
    isBundle: false,
    bundleContents: [],
    replacementHint: "Replace every 30 days",
    imageUrl: "/products/cushion-f30i.webp",
    manufacturer: "ResMed",
    modelNumber: "64162",
    price: price(3299),
    recurringPrice: monthly(3299),
    stockCount: null,
    lowStockThreshold: null,
  },
  {
    id: "demo-prod-n20-mask",
    name: "AirFit N20 Complete Mask",
    description:
      "The complete AirFit N20 nasal mask system — frame, cushion, and headgear. A great all-rounder and the most-prescribed nasal mask we carry.",
    category: "mask",
    tagline: "Complete system",
    isBundle: false,
    bundleContents: [],
    replacementHint: "Replace mask every 3 months",
    imageUrl: "/products/airfit-n20.webp",
    manufacturer: "ResMed",
    modelNumber: "63500",
    price: price(13900),
    recurringPrice: null,
    stockCount: null,
    lowStockThreshold: null,
  },
  {
    id: "demo-prod-p10-mask",
    name: "AirFit P10 Complete Mask",
    description:
      "Complete AirFit P10 nasal-pillow system. Whisper-quiet QuietAir vent and a two-strap headgear that stays out of your line of sight.",
    category: "mask",
    tagline: "Quietest option",
    isBundle: false,
    bundleContents: [],
    replacementHint: "Replace mask every 3 months",
    imageUrl: "/products/airfit-p10.webp",
    manufacturer: "ResMed",
    modelNumber: "62900",
    price: price(12900),
    recurringPrice: null,
    stockCount: null,
    lowStockThreshold: null,
  },
  {
    id: "demo-prod-f30i-mask",
    name: "AirFit F30i Complete Mask",
    description:
      "Complete AirFit F30i full-face system with the tube-up-top frame that lets you sleep in any position and read in bed.",
    category: "mask",
    tagline: "Sleep in any position",
    isBundle: false,
    bundleContents: [],
    replacementHint: "Replace mask every 3 months",
    imageUrl: "/products/airfit-f30i.webp",
    manufacturer: "ResMed",
    modelNumber: "64101",
    price: price(16900),
    recurringPrice: null,
    stockCount: null,
    lowStockThreshold: null,
  },
  {
    id: "demo-prod-rh-rio2",
    name: "React Health Rio II Nasal Mask",
    description:
      "The React Health Rio II nasal mask — a comfortable, budget-friendly alternative with a soft silicone cushion and easy-clip headgear.",
    category: "mask",
    tagline: "Best value nasal",
    isBundle: false,
    bundleContents: [],
    replacementHint: "Replace mask every 3 months",
    imageUrl: "/products/react-health-rio2.webp",
    manufacturer: "React Health",
    modelNumber: "RIO2-N",
    price: price(8900),
    recurringPrice: null,
    stockCount: null,
    lowStockThreshold: null,
  },
  {
    id: "demo-prod-rh-numa",
    name: "React Health Numa Full Face Mask",
    description:
      "The React Health Numa full-face mask. A roomy, well-vented cushion built for higher pressures and mouth-breathers.",
    category: "mask",
    tagline: "Great for higher pressures",
    isBundle: false,
    bundleContents: [],
    replacementHint: "Replace mask every 3 months",
    imageUrl: "/products/react-health-numa.webp",
    manufacturer: "React Health",
    modelNumber: "NUMA-FF",
    price: price(9900),
    recurringPrice: null,
    stockCount: null,
    lowStockThreshold: null,
  },
  {
    id: "demo-prod-n20-headgear",
    name: "AirFit N20 Headgear",
    description:
      "Replacement headgear for the AirFit N20. Soft, stretch fabric straps with magnetic clips for one-handed on and off.",
    category: "headgear",
    tagline: "Magnetic clips",
    isBundle: false,
    bundleContents: [],
    replacementHint: "Replace every 6 months",
    imageUrl: "/products/headgear-n20.webp",
    manufacturer: "ResMed",
    modelNumber: "63470",
    price: price(3499),
    recurringPrice: null,
    stockCount: null,
    lowStockThreshold: null,
  },
  {
    id: "demo-prod-climateline",
    name: "ClimateLineAir Heated Tubing",
    description:
      "Heated tubing for AirSense 10 machines. Holds a steady temperature and humidity to prevent rainout on cold nights.",
    category: "tubing",
    tagline: "No more rainout",
    isBundle: false,
    bundleContents: [],
    replacementHint: "Replace every 6 months",
    imageUrl: "/products/tubing-climateline.webp",
    manufacturer: "ResMed",
    modelNumber: "37296",
    price: price(4299),
    recurringPrice: null,
    stockCount: null,
    lowStockThreshold: null,
  },
  {
    id: "demo-prod-slimline",
    name: "SlimLine Standard Tubing",
    description:
      "Lightweight, flexible standard tubing. Lower drag than classic tubing so the mask tugs less when you turn over.",
    category: "tubing",
    tagline: "Lightweight & flexible",
    isBundle: false,
    bundleContents: [],
    replacementHint: "Replace every 6 months",
    imageUrl: "/products/tubing-slimline.webp",
    manufacturer: "ResMed",
    modelNumber: "37298",
    price: price(2299),
    recurringPrice: null,
    stockCount: null,
    lowStockThreshold: null,
  },
  {
    id: "demo-prod-filter-disposable",
    name: "Disposable Filters (6-pack)",
    description:
      "Six disposable hypoallergenic filters for AirSense 10/11 machines. Keeps dust and pollen out of your airflow.",
    category: "filter",
    tagline: "6-month supply",
    isBundle: false,
    bundleContents: [],
    replacementHint: "Replace every 30 days",
    imageUrl: "/products/filter-disposable.png",
    manufacturer: "ResMed",
    modelNumber: "36850",
    price: price(1499),
    recurringPrice: monthly(1499),
    stockCount: null,
    lowStockThreshold: null,
  },
  {
    id: "demo-prod-chamber",
    name: "AirSense Humidifier Water Chamber",
    description:
      "Replacement standard water chamber (humidifier tub) for AirSense 10 machines. Dishwasher-safe and built to resist mineral buildup.",
    category: "chamber",
    tagline: "Dishwasher-safe",
    isBundle: false,
    bundleContents: [],
    replacementHint: "Replace every 6 months",
    imageUrl: "/products/chamber-airsense.webp",
    manufacturer: "ResMed",
    modelNumber: "37299",
    price: price(2799),
    recurringPrice: null,
    stockCount: 0,
    lowStockThreshold: 5,
  },
  {
    id: "demo-prod-wipes",
    name: "CPAP Mask Wipes — Citrus (62-pack)",
    description:
      "Unscented-safe citrus cleaning wipes for masks and cushions. Lint-free and gentle on silicone — a quick daily wipe-down.",
    category: "accessory",
    tagline: "Daily cleaning",
    isBundle: false,
    bundleContents: [],
    replacementHint: "Reorder monthly",
    imageUrl: "/products/wipes-citrus.jpg",
    manufacturer: "PennFit",
    modelNumber: "WIPE-62",
    price: price(1299),
    recurringPrice: monthly(1299),
    stockCount: null,
    lowStockThreshold: null,
  },
  {
    id: "demo-prod-resupply-bundle",
    name: "Complete Resupply Bundle — Nasal",
    description:
      "Everything you need for a fresh 90 days: nasal cushion, headgear, two filters, and tubing — bundled at a convenience price and set to auto-ship.",
    category: "bundle",
    tagline: "Save with auto-ship",
    isBundle: true,
    bundleContents: [
      "AirFit N20 Nasal Cushion",
      "AirFit N20 Headgear",
      "Disposable Filters (2)",
      "SlimLine Tubing",
    ],
    replacementHint: "Ships every 90 days",
    imageUrl: "/products/cushion-n20.webp",
    manufacturer: "ResMed",
    modelNumber: "BUNDLE-N20",
    price: price(8900),
    recurringPrice: monthly(8900),
    stockCount: null,
    lowStockThreshold: null,
  },
];

const CATEGORY_ORDER: Category[] = [
  "mask",
  "cushion",
  "tubing",
  "filter",
  "headgear",
  "chamber",
  "accessory",
  "bundle",
];

export function demoProductsResponse() {
  const byCategory = {} as Record<Category, ShopProductView[]>;
  for (const cat of CATEGORY_ORDER) {
    const items = DEMO_PRODUCTS.filter((p) => p.category === cat);
    if (items.length > 0) byCategory[cat] = items;
  }
  return {
    previewMode: false,
    purchasingEnabled: true,
    categories: CATEGORY_ORDER.filter((c) => byCategory[c]?.length),
    products: DEMO_PRODUCTS,
    byCategory,
  };
}

export function findDemoProduct(id: string): ShopProductView | undefined {
  return DEMO_PRODUCTS.find((p) => p.id === id);
}
