// GET /shop/products — public catalog endpoint.
//
// Public (no auth): the shop is meant for any visitor who wants to
// pay cash. Stripe is the source of truth for product + price data;
// we fetch the live list every request and cache it in-process for
// 60s. The cache eliminates the per-request Stripe round-trip on a
// hot product page without tying us to a webhook-driven sync.
//
// Cache scoping:
//   The cache key includes the Stripe secret prefix so that swapping
//   keys (e.g. test → live) invalidates the cache automatically and
//   we never leak a test-mode catalog into a live-mode response.

import { Router, type IRouter } from "express";

import {
  SHOP_UNAVAILABLE_BODY,
  getStripeClient,
  readStripeConfigOrNull,
} from "../../lib/stripe/config";
import {
  type ShopCategory,
  SHOP_CATEGORIES,
  type ShopProductView,
  projectProduct,
} from "../../lib/stripe/products-meta";

interface CacheEntry {
  keyPrefix: string;
  fetchedAt: number;
  products: ShopProductView[];
}

let cache: CacheEntry | null = null;
const CACHE_TTL_MS = 60_000;

function cacheFresh(keyPrefix: string): ShopProductView[] | null {
  if (!cache) return null;
  if (cache.keyPrefix !== keyPrefix) return null;
  if (Date.now() - cache.fetchedAt > CACHE_TTL_MS) return null;
  return cache.products;
}

const router: IRouter = Router();

router.get("/shop/products", async (req, res) => {
  const config = readStripeConfigOrNull();
  if (!config) {
    res.status(503).json(SHOP_UNAVAILABLE_BODY);
    return;
  }

  // Use just the first 8 chars of the secret as the cache key prefix
  // so we invalidate on key rotation without writing a key (or a
  // hash of one) into a long-lived in-process variable.
  const keyPrefix = config.secretKey.slice(0, 8);

  let products = cacheFresh(keyPrefix);
  if (!products) {
    const stripe = getStripeClient(config);
    // expand default_price so projectProduct can read price.unit_amount
    // without a second round-trip. Stripe's pagination caps at 100;
    // we don't expect more than 100 active shop products in the
    // foreseeable future, but if we ever do, switch to autoPagingEach.
    const list = await stripe.products.list({
      active: true,
      limit: 100,
      expand: ["data.default_price"],
    });
    products = list.data
      .map(projectProduct)
      .filter((p): p is ShopProductView => p !== null);
    cache = { keyPrefix, fetchedAt: Date.now(), products };
  }

  // Group by category for the frontend's section bar. Bundles are
  // surfaced as their own group AND mixed in with their underlying
  // category-less "bundle" entry so the UI can decide where to show
  // them.
  const byCategory: Record<ShopCategory, ShopProductView[]> = {
    mask: [],
    cushion: [],
    tubing: [],
    filter: [],
    headgear: [],
    chamber: [],
    accessory: [],
    bundle: [],
  };
  for (const p of products) {
    byCategory[p.category].push(p);
  }

  // Stable sort within each category: by price ascending, then name.
  for (const cat of SHOP_CATEGORIES) {
    byCategory[cat].sort((a, b) => {
      if (a.price.unitAmount !== b.price.unitAmount) {
        return a.price.unitAmount - b.price.unitAmount;
      }
      return a.name.localeCompare(b.name);
    });
  }

  res.json({
    categories: SHOP_CATEGORIES,
    products,
    byCategory,
  });
});

export default router;
