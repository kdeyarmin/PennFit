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
import { stripeAccountRequestOptions } from "../../lib/stripe/connect";
import { isFeatureEnabled } from "../../lib/feature-flags";
import { requestHost } from "../../lib/request-host";
import { resolveOrgIdByHost } from "../../lib/tenant-branding";
import { getPreviewCatalog } from "../../lib/stripe/preview-catalog";
import { stripeErrLogFields } from "../../lib/stripe/err-log-fields";
import {
  type ShopCategory,
  SHOP_CATEGORIES,
  type ShopProductView,
  projectProduct,
  projectRecurringPrice,
} from "../../lib/stripe/products-meta";

interface CacheEntry {
  fetchedAt: number;
  products: ShopProductView[];
}

// Per-account catalog cache (Stripe Connect direct-charges, G6): keyed by
// `${secretPrefix}:${connectedAccountId ?? "platform"}`. Each connected
// tenant lists products from THEIR own account, so a single global cache
// would leak one tenant's catalog into another's storefront. Bounded so a
// large tenant fan-out can't grow it unbounded.
const cacheByAccount = new Map<string, CacheEntry>();
const MAX_CACHED_ACCOUNTS = 50;
const CACHE_TTL_MS = 60_000;

/**
 * Drop the in-process catalog cache so the next GET /shop/products
 * re-fetches from Stripe. Called by the admin price rotation
 * (routes/admin/shop-products.ts): once a product's default_price is
 * repointed, serving the cached snapshot for the rest of the TTL
 * would actively mislead — the storefront would keep building carts
 * against the replaced price id, which checkout validation
 * (lib/stripe/validate-cart.ts) is already rejecting as
 * `price_not_storefront_approved`. Single-process today, so an
 * in-process drop fully closes that window; if the API ever scales
 * to multiple instances this becomes best-effort on the siblings
 * (bounded by the same 60s TTL that exists now).
 */
export function invalidateShopProductsCache(): void {
  // Clear every tenant's entry. Catalog mutations are per-tenant, but
  // over-invalidation is harmless (just a re-fetch on the next request)
  // and clearing all keeps the 6 admin-mutation callsites argument-free.
  cacheByAccount.clear();
}

// How long we'll keep serving the in-process catalog as "stale" when
// Stripe is briefly unreachable. Beyond this, we'd rather 503 than
// serve a catalog that may no longer reflect prices / availability.
// 15 minutes covers the typical Stripe incident window and the
// in-process worker restart cadence.
const STALE_GRACE_MS = 15 * 60_000;

/**
 * Retrieve cached product views for a per-account cache key when the entry is still within the freshness window.
 *
 * @param cacheKey - `${secretPrefix}:${connectedAccountId ?? "platform"}` scoping the cache to a tenant's account
 * @returns The cached `ShopProductView[]` when available and fresh, `null` otherwise
 */
function cacheFresh(cacheKey: string): ShopProductView[] | null {
  const entry = cacheByAccount.get(cacheKey);
  if (!entry) return null;
  if (Date.now() - entry.fetchedAt > CACHE_TTL_MS) return null;
  return entry.products;
}

/**
 * Retrieve cached product views that are still usable within the stale-grace window for a per-account cache key.
 *
 * @param cacheKey - `${secretPrefix}:${connectedAccountId ?? "platform"}` scoping the cached snapshot to a tenant's account
 * @returns The cached array of `ShopProductView` when a cache exists for `cacheKey` and its age is ≤ `CACHE_TTL_MS + STALE_GRACE_MS`, `null` otherwise
 */
function cacheStaleButUsable(cacheKey: string): ShopProductView[] | null {
  const entry = cacheByAccount.get(cacheKey);
  if (!entry) return null;
  if (Date.now() - entry.fetchedAt > CACHE_TTL_MS + STALE_GRACE_MS) return null;
  return entry.products;
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
  // Tenant resolved (host-based) only when Stripe is configured; reused for
  // both the connected-account catalog read and the purchasing gate below.
  let orgId: string | undefined;

  if (!config) {
    previewMode = true;
    products = getPreviewCatalog();
  } else {
    // Resolve the tenant for this public storefront from the request host
    // (no auth middleware populates req.orgId here), then route the catalog
    // read to that tenant's connected Stripe account when set — the SAME
    // account checkout creates the session on. NULL → {} → platform account.
    orgId =
      req.orgId ?? (await resolveOrgIdByHost(requestHost(req))) ?? undefined;
    const accountOptions = await stripeAccountRequestOptions(orgId);
    const accountKey = accountOptions.stripeAccount ?? "platform";

    // Cache key scopes by secret prefix (so a test→live rotation
    // invalidates) AND by connected account (so one tenant's catalog is
    // never served on another tenant's storefront).
    const cacheKey = `${config.secretKey.slice(0, 8)}:${accountKey}`;

    const cached = cacheFresh(cacheKey);
    if (cached) {
      products = cached;
    } else {
      const stripe = getStripeClient(config);
      // expand default_price so projectProduct can read price.unit_amount
      // without a second round-trip. Stripe's pagination caps at 100;
      // we don't expect more than 100 active shop products in the
      // foreseeable future, but if we ever do, switch to autoPagingEach.
      let list: Awaited<ReturnType<typeof stripe.products.list>> | null = null;
      // Hoisted out of the catch so the `else` branch below can reuse
      // the same stale snapshot without re-reading Date.now() — the
      // second call would otherwise have a (theoretical, sub-ms)
      // chance of crossing the TTL+grace boundary mid-request.
      let stale: ShopProductView[] | null = null;
      try {
        list = await stripe.products.list(
          {
            active: true,
            limit: 100,
            expand: ["data.default_price"],
          },
          accountOptions,
        );
      } catch (err) {
        // Stripe hiccup, network blip, rate limit, or invalid key.
        // Previously the throw escaped to the error handler and the
        // SPA surfaced "We couldn't load the shop right now."
        // (artifacts/cpap-fitter/src/lib/shop-api.ts). Two-step
        // degradation now:
        //   1. If we still have an in-process cache from earlier (up
        //      to STALE_GRACE_MS old), serve THAT — better than going
        //      hard-down for the entire 60s TTL window.
        //   2. Otherwise return 503 + Retry-After so the SPA can show
        //      the same retry UX with correct HTTP semantics for
        //      load balancers and uptime monitors.
        stale = cacheStaleButUsable(cacheKey);
        const staleEntry = cacheByAccount.get(cacheKey);
        req.log?.warn(
          {
            event: "shop_products_stripe_list_failed",
            ...stripeErrLogFields(err),
            servedStale: stale !== null,
            staleAgeSeconds:
              staleEntry && stale
                ? Math.round((Date.now() - staleEntry.fetchedAt) / 1000)
                : null,
          },
          "stripe products.list failed",
        );
        if (!stale) {
          res.setHeader("Retry-After", "30");
          res.status(503).json({
            error: "shop_unavailable",
            message:
              "The shop is temporarily unavailable. Please try again in a few minutes.",
          });
          return;
        }
        // Fall through with `list === null` and a non-null `stale`;
        // below we use that snapshot directly and SKIP the cache
        // write so the stale window can't be extended indefinitely
        // by repeated failures.
      }

      if (list) {
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
          const priceList = await stripe.prices.list(
            {
              active: true,
              type: "recurring",
              limit: 100,
            },
            accountOptions,
          );
          const cheapestByProduct = new Map<
            string,
            ReturnType<typeof projectRecurringPrice>
          >();
          for (const price of priceList.data) {
            const productId =
              typeof price.product === "string"
                ? price.product
                : price.product?.id;
            if (!productId) continue;
            const projected = projectRecurringPrice(price);
            if (!projected) continue;
            const existing = cheapestByProduct.get(productId);
            // Deterministic tie-break by price id (lexicographically
            // lowest) so this selection matches validate-cart.ts exactly.
            // The two paths iterate different Stripe lists (global here,
            // product-scoped in validate-cart) whose ordering can differ,
            // so a list-order-dependent tie-break would let the storefront
            // surface one equal-priced recurring price while checkout
            // validation approved another — rejecting a valid subscribe.
            if (
              !existing ||
              projected.unitAmount < existing.unitAmount ||
              (projected.unitAmount === existing.unitAmount &&
                projected.id < existing.id)
            ) {
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
            { ...stripeErrLogFields(err) },
            "stripe prices.list failed; subscribe toggle disabled this request",
          );
        }

        // Only write the cache on a successful fresh fetch. The stale
        // path below intentionally skips this so a sustained outage
        // can't keep refreshing the stale timestamp forever. Prune the
        // oldest entry first if we'd exceed the per-account bound.
        if (cacheByAccount.size >= MAX_CACHED_ACCOUNTS) {
          const oldest = cacheByAccount.keys().next().value;
          if (oldest) cacheByAccount.delete(oldest);
        }
        cacheByAccount.set(cacheKey, { fetchedAt: Date.now(), products });
      } else {
        // Stale path: `stale` was assigned in the catch branch
        // (otherwise we'd have already returned 503). Serve it as-is
        // — recurring prices are already attached from when it was
        // fresh. The non-null assertion is justified by the control
        // flow: we only reach this `else` after the catch ran and
        // didn't return.
        products = stale!;
      }
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

  // Storefront purchasing master switch. A shopper can only complete a
  // purchase when BOTH hold: Stripe is configured (we have a payment
  // processor) AND the `storefront.checkout` feature flag is enabled in
  // the admin Control Center. When either is false we still return the
  // full catalog so the storefront renders for browsing — the SPA just
  // disables the buy/checkout affordances and steers shoppers to the
  // insurance flow. Surfacing it here lets the UI reflect the state
  // up-front instead of discovering it via a 503 after the shopper
  // clicks "Checkout"; /shop/checkout and /shop/me/quick-checkout
  // enforce the same gate server-side. The `config !== null &&`
  // short-circuit skips the flag lookup in preview mode, where
  // purchasing is off regardless of the flag.
  // `orgId` was resolved above (host-based) when Stripe is configured; the
  // tenant's storefront.checkout toggle gates THIS storefront. In preview
  // mode orgId stays undefined and the `config !== null &&` short-circuit
  // skips the flag lookup, so purchasing is off regardless.
  const purchasingEnabled =
    config !== null && (await isFeatureEnabled("storefront.checkout", orgId));

  res.json({
    previewMode,
    purchasingEnabled,
    categories: SHOP_CATEGORIES,
    products,
    byCategory,
  });
});

export default router;
