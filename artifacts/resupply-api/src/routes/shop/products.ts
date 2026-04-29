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
  getStripeClient,
  readStripeConfigOrNull,
} from "../../lib/stripe/config";
import { getPreviewCatalog } from "../../lib/stripe/preview-catalog";
import {
  type ShopCategory,
  SHOP_CATEGORIES,
  type ShopProductView,
  projectProduct,
  projectRecurringPrice,
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

  // Preview-mode fallback: when Stripe isn't configured, serve a
  // built-in fixture catalog (mirroring the seed script) so the
  // storefront UX renders end-to-end. The `previewMode: true` flag
  // tells the frontend to show a banner and disable Checkout —
  // /shop/checkout itself still 503s, so no real money path is
  // unintentionally opened. See lib/stripe/preview-catalog.ts.
  let previewMode = false;
  let products: ShopProductView[];

  if (!config) {
    previewMode = true;
    products = getPreviewCatalog();
  } else {
    // Use just the first 8 chars of the secret as the cache key prefix
    // so we invalidate on key rotation without writing a key (or a
    // hash of one) into a long-lived in-process variable.
    const keyPrefix = config.secretKey.slice(0, 8);

    const cached = cacheFresh(keyPrefix);
    if (cached) {
      products = cached;
    } else {
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

      // Subscribe & Save: enumerate active recurring prices in one
      // pass and attach the cheapest match per product. Doing this as
      // a single list call avoids N+1 (one per product) without
      // bloating the products.list expand path. Stripe's prices.list
      // pagination caps at 100; we don't expect to exceed that until
      // the catalog is much larger than today (ten-ish active SKUs).
      try {
        const priceList = await stripe.prices.list({
          active: true,
          type: "recurring",
          limit: 100,
        });
        const cheapestByProduct = new Map<string, ReturnType<typeof projectRecurringPrice>>();
        for (const price of priceList.data) {
          const productId =
            typeof price.product === "string" ? price.product : price.product?.id;
          if (!productId) continue;
          const projected = projectRecurringPrice(price);
          if (!projected) continue;
          const existing = cheapestByProduct.get(productId);
          if (!existing || projected.unitAmount < existing.unitAmount) {
            cheapestByProduct.set(productId, projected);
          }
        }
        for (const product of products) {
          const recurring = cheapestByProduct.get(product.id);
          if (recurring) product.recurringPrice = recurring;
        }
      } catch (err) {
        // Non-fatal — products still render with one-time prices, the
        // subscribe toggle simply won't appear.
        req.log?.warn(
          { err: err instanceof Error ? err.message : String(err) },
          "stripe prices.list failed; subscribe toggle disabled this request",
        );
      }

      cache = { keyPrefix, fetchedAt: Date.now(), products };
    }
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
    previewMode,
    categories: SHOP_CATEGORIES,
    products,
    byCategory,
  });
});

export default router;
