// Tests for the GET /shop/products degradation behaviour added after
// the production 500 surfaced via the SPA's "We couldn't load the
// shop right now" error.
//
// Coverage:
//   * Fresh fetch success → 200 + by-category projection.
//   * Stripe products.list throws on first hit (no cache) → 503 +
//     Retry-After.
//   * Stripe products.list throws AFTER a prior fresh hit primed the
//     cache → serve stale-but-usable (still 200), and DO NOT bump
//     fetchedAt (otherwise repeated failures would keep extending
//     the stale window forever).
//   * Preview-mode (no Stripe config) → 200 + preview catalog,
//     unaffected by the new code paths.

import express, { type Express } from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const stripeProductsList = vi.fn();
const stripePricesList = vi.fn();
const readStripeConfigOrNullMock = vi.fn();
const getStripeClientMock = vi.fn();
const getPreviewCatalogMock = vi.fn();

vi.mock("../../lib/stripe/config", () => ({
  readStripeConfigOrNull: () => readStripeConfigOrNullMock(),
  getStripeClient: (cfg: unknown) => getStripeClientMock(cfg),
}));

vi.mock("../../lib/stripe/preview-catalog", () => ({
  getPreviewCatalog: () => getPreviewCatalogMock(),
}));

// storefront.checkout feature flag. Toggle `featureEnabled.value` per
// test; defaults to on (reset in beforeEach).
const featureEnabled = vi.hoisted(() => ({ value: true }));
vi.mock("../../lib/feature-flags", () => ({
  isFeatureEnabled: vi.fn(async () => featureEnabled.value),
}));

// Stripe Connect (G6): the catalog read routes to the tenant's connected
// account. Default → platform account ({}); per-tenant test overrides it.
const stripeAccountRequestOptionsMock = vi.fn(async (_orgId: unknown) => ({}));
vi.mock("../../lib/stripe/connect", () => ({
  stripeAccountRequestOptions: (orgId: unknown) =>
    stripeAccountRequestOptionsMock(orgId),
}));

// Host → tenant resolution for this public route. Default → null (platform).
const resolveOrgIdByHostMock = vi.fn(
  async (_host: unknown): Promise<string | null> => null,
);
vi.mock("../../lib/tenant-branding", () => ({
  resolveOrgIdByHost: (host: unknown) => resolveOrgIdByHostMock(host),
}));

// In-flight reservation ledger: the route subtracts active holds from the
// advertised stock so a held-out unit doesn't read as in-stock. Default → no
// holds (empty map); per-test overrides stage a per-sku reserved count.
const getActiveReservedBySkuMock = vi.fn(
  async (
    _orgId: unknown,
    _skus: unknown,
    _log?: unknown,
  ): Promise<Map<string, number>> => new Map(),
);
vi.mock("../../lib/inventory/reservations", () => ({
  getActiveReservedBySku: (orgId: unknown, skus: unknown, log?: unknown) =>
    getActiveReservedBySkuMock(orgId, skus, log),
}));

import productsRouter, { invalidateShopProductsCache } from "./products";

function makeApp(): Express {
  const app = express();
  app.use(productsRouter);
  return app;
}

function freshProduct(
  id: string,
  name: string,
  unitAmount: number,
  stockCount?: number,
) {
  // Shape matches Stripe.Product fields that projectProduct() inspects:
  // products-meta.ts:196–215 requires `metadata.category` to be a known
  // ShopCategory and `default_price` to be an active one_time Price. When
  // `stockCount` is provided, set `metadata.stock_count` so the product reads
  // as stock-tracked (otherwise stockCount projects to null = unlimited).
  return {
    id,
    active: true,
    name,
    description: null,
    images: [],
    metadata: {
      category: "mask",
      ...(stockCount != null ? { stock_count: String(stockCount) } : {}),
    },
    default_price: {
      id: `price_${id}`,
      active: true,
      currency: "usd",
      unit_amount: unitAmount,
      type: "one_time",
    },
  };
}

beforeEach(() => {
  stripeProductsList.mockReset();
  stripePricesList.mockReset();
  readStripeConfigOrNullMock.mockReset();
  getStripeClientMock.mockReset();
  getPreviewCatalogMock.mockReset();
  featureEnabled.value = true;
  stripeAccountRequestOptionsMock.mockReset();
  stripeAccountRequestOptionsMock.mockResolvedValue({});
  resolveOrgIdByHostMock.mockReset();
  resolveOrgIdByHostMock.mockResolvedValue(null);
  getActiveReservedBySkuMock.mockReset();
  getActiveReservedBySkuMock.mockResolvedValue(new Map());

  getStripeClientMock.mockReturnValue({
    products: { list: stripeProductsList },
    prices: { list: stripePricesList },
  });
  // Default to a non-recurring (Subscribe & Save) catalog so each
  // test can override only what it needs.
  stripePricesList.mockResolvedValue({ data: [] });
});

describe("GET /shop/products — degradation behaviour", () => {
  it("preview-mode (no Stripe config) returns the bundled catalog", async () => {
    readStripeConfigOrNullMock.mockReturnValue(null);
    getPreviewCatalogMock.mockReturnValue([]);
    const res = await request(makeApp()).get("/shop/products");
    expect(res.status).toBe(200);
    expect(res.body.previewMode).toBe(true);
    // No Stripe → purchasing is off regardless of the feature flag.
    expect(res.body.purchasingEnabled).toBe(false);
    expect(Array.isArray(res.body.products)).toBe(true);
  });

  it("503s with Retry-After when Stripe throws and no cache exists", async () => {
    // Distinct prefix so this test starts with no warm cache. The
    // route's cache key is `secretKey.slice(0, 8)`, so prefixes must
    // differ in the first 8 chars to keep tests isolated.
    readStripeConfigOrNullMock.mockReturnValue({
      secretKey: "skAAAAAA_503_path",
      publishableKey: "pk_test_x",
    });
    stripeProductsList.mockRejectedValue(new Error("stripe is down"));

    const res = await request(makeApp()).get("/shop/products");
    expect(res.status).toBe(503);
    expect(res.body).toMatchObject({ error: "shop_unavailable" });
    expect(res.headers["retry-after"]).toBe("30");
  });

  it("serves stale-but-usable cache when Stripe throws after a prior success", async () => {
    readStripeConfigOrNullMock.mockReturnValue({
      secretKey: "skBBBBBB_stale_path",
      publishableKey: "pk_test_x",
    });

    // 1) Prime the in-process cache with a successful fetch.
    stripeProductsList.mockResolvedValueOnce({
      data: [freshProduct("prod_1", "Mask A", 1000)],
    });
    const first = await request(makeApp()).get("/shop/products");
    expect(first.status).toBe(200);
    expect(first.body.products).toHaveLength(1);

    // 2) Force the in-process cache TTL to expire so the next call
    //    does a fresh fetch, which will fail. We advance Date.now()
    //    past the 60s TTL but within the 15-minute stale grace.
    const realNow = Date.now;
    const advanced = realNow() + 120_000; // 2 minutes
    vi.spyOn(Date, "now").mockImplementation(() => advanced);

    stripeProductsList.mockRejectedValueOnce(new Error("transient outage"));

    const second = await request(makeApp()).get("/shop/products");
    expect(second.status).toBe(200);
    expect(second.body.products).toHaveLength(1);
    expect(second.body.products[0].id).toBe("prod_1");

    vi.restoreAllMocks();
  });

  it("does NOT extend the stale window on repeated failures", async () => {
    readStripeConfigOrNullMock.mockReturnValue({
      secretKey: "skCCCCCC_no_extend",
      publishableKey: "pk_test_x",
    });

    stripeProductsList.mockResolvedValueOnce({
      data: [freshProduct("prod_2", "Mask B", 2000)],
    });
    const first = await request(makeApp()).get("/shop/products");
    expect(first.status).toBe(200);

    // Advance past TTL but well within stale grace; first failure
    // serves stale and (crucially) must NOT write the cache.
    const realNow = Date.now;
    const baseline = realNow();
    vi.spyOn(Date, "now").mockImplementation(() => baseline + 120_000);
    stripeProductsList.mockRejectedValueOnce(new Error("outage 1"));
    const second = await request(makeApp()).get("/shop/products");
    expect(second.status).toBe(200);

    // Advance past STALE_GRACE_MS (15 min). If the stale-path
    // accidentally bumped fetchedAt during the prior call, this
    // request would still serve stale instead of 503-ing.
    vi.spyOn(Date, "now").mockImplementation(
      () => baseline + 120_000 + 16 * 60_000,
    );
    stripeProductsList.mockRejectedValueOnce(new Error("outage 2"));
    const third = await request(makeApp()).get("/shop/products");
    expect(third.status).toBe(503);

    vi.restoreAllMocks();
  });

  it("invalidateShopProductsCache forces the next request to re-fetch", async () => {
    readStripeConfigOrNullMock.mockReturnValue({
      secretKey: "skFFFFFF_invalidate",
      publishableKey: "pk_test_x",
    });

    // 1) Prime the cache.
    stripeProductsList.mockResolvedValueOnce({
      data: [freshProduct("prod_3", "Mask C", 1999)],
    });
    const first = await request(makeApp()).get("/shop/products");
    expect(first.status).toBe(200);
    expect(stripeProductsList).toHaveBeenCalledTimes(1);

    // 2) Within the TTL a second GET serves from cache — no new
    //    Stripe round-trip.
    const second = await request(makeApp()).get("/shop/products");
    expect(second.status).toBe(200);
    expect(stripeProductsList).toHaveBeenCalledTimes(1);

    // 3) Invalidate — what the admin price PATCH calls after a
    //    rotation — and the next GET re-fetches, serving the new
    //    price immediately instead of waiting out the TTL.
    invalidateShopProductsCache();
    stripeProductsList.mockResolvedValueOnce({
      data: [freshProduct("prod_3", "Mask C", 2499)],
    });
    const third = await request(makeApp()).get("/shop/products");
    expect(third.status).toBe(200);
    expect(stripeProductsList).toHaveBeenCalledTimes(2);
    expect(third.body.products[0].price.unitAmount).toBe(2499);
  });
});

describe("GET /shop/products — purchasingEnabled", () => {
  it("is true when Stripe is configured and storefront.checkout is on", async () => {
    readStripeConfigOrNullMock.mockReturnValue({
      secretKey: "skDDDDDD_purchasing_on",
      publishableKey: "pk_test_x",
    });
    featureEnabled.value = true;
    stripeProductsList.mockResolvedValue({
      data: [freshProduct("prod_pe1", "Mask PE", 1000)],
    });

    const res = await request(makeApp()).get("/shop/products");
    expect(res.status).toBe(200);
    expect(res.body.purchasingEnabled).toBe(true);
    expect(res.body.previewMode).toBe(false);
    expect(res.body.products).toHaveLength(1);
  });

  it("is false when the storefront.checkout flag is off, but still returns the catalog for browsing", async () => {
    readStripeConfigOrNullMock.mockReturnValue({
      secretKey: "skEEEEEE_purchasing_off",
      publishableKey: "pk_test_x",
    });
    featureEnabled.value = false;
    stripeProductsList.mockResolvedValue({
      data: [freshProduct("prod_pe2", "Mask PE2", 2000)],
    });

    const res = await request(makeApp()).get("/shop/products");
    expect(res.status).toBe(200);
    // Purchasing is paused...
    expect(res.body.purchasingEnabled).toBe(false);
    // ...but it's NOT preview mode (Stripe IS connected) and the
    // catalog still renders so shoppers can browse.
    expect(res.body.previewMode).toBe(false);
    expect(res.body.products).toHaveLength(1);
  });
});

describe("GET /shop/products — per-tenant (Connect) catalog", () => {
  it("reads each tenant's catalog from its own connected account", async () => {
    readStripeConfigOrNullMock.mockReturnValue({
      secretKey: "skTENANT_scope",
      publishableKey: "pk_test_x",
    });
    // products.list returns a different catalog per connected account.
    stripeProductsList.mockImplementation(
      async (
        _params: unknown,
        opts: { stripeAccount?: string } | undefined,
      ) => {
        if (opts?.stripeAccount === "acct_A")
          return { data: [freshProduct("prodA", "Mask A", 1000)] };
        if (opts?.stripeAccount === "acct_B")
          return { data: [freshProduct("prodB", "Mask B", 2000)] };
        return { data: [] };
      },
    );
    // Two storefront hosts → two tenants → two connected accounts.
    resolveOrgIdByHostMock.mockResolvedValueOnce("orgA");
    resolveOrgIdByHostMock.mockResolvedValueOnce("orgB");
    stripeAccountRequestOptionsMock.mockImplementation(
      async (orgId: unknown) =>
        orgId === "orgA"
          ? { stripeAccount: "acct_A" }
          : { stripeAccount: "acct_B" },
    );

    const resA = await request(makeApp()).get("/shop/products");
    const resB = await request(makeApp()).get("/shop/products");

    expect(resA.body.products.map((p: { id: string }) => p.id)).toEqual([
      "prodA",
    ]);
    expect(resB.body.products.map((p: { id: string }) => p.id)).toEqual([
      "prodB",
    ]);
    // Each list call carried the tenant's own account header — no cross-leak.
    expect(stripeProductsList).toHaveBeenCalledWith(expect.anything(), {
      stripeAccount: "acct_A",
    });
    expect(stripeProductsList).toHaveBeenCalledWith(expect.anything(), {
      stripeAccount: "acct_B",
    });
  });
});

describe("GET /shop/products — stock net of in-flight reservations", () => {
  it("subtracts active holds from the advertised stockCount", async () => {
    readStripeConfigOrNullMock.mockReturnValue({
      secretKey: "skRESV01_net_stock",
      publishableKey: "pk_test_x",
    });
    // A tenant must resolve for the reservation-adjust branch to run.
    resolveOrgIdByHostMock.mockResolvedValue("orgRESV");
    // Product advertises 10 units in Stripe metadata...
    stripeProductsList.mockResolvedValue({
      data: [freshProduct("prod_resv", "Mask Reserved", 1000, 10)],
    });
    // ...but 4 are held by in-flight checkouts.
    getActiveReservedBySkuMock.mockResolvedValue(new Map([["prod_resv", 4]]));

    const res = await request(makeApp()).get("/shop/products");
    expect(res.status).toBe(200);
    // The ledger was consulted for exactly the catalog's product ids.
    expect(getActiveReservedBySkuMock).toHaveBeenCalledWith(
      "orgRESV",
      ["prod_resv"],
      // req.log is undefined under the bare express() test harness (no pino
      // middleware) — the route forwards it verbatim as the optional logger.
      undefined,
    );
    // Advertised stock is net of the holds: 10 - 4 = 6.
    expect(res.body.products).toHaveLength(1);
    expect(res.body.products[0].id).toBe("prod_resv");
    expect(res.body.products[0].stockCount).toBe(6);
    // The by-category projection is adjusted too.
    expect(res.body.byCategory.mask[0].stockCount).toBe(6);
  });

  it("leaves stockCount unchanged when there are no active holds", async () => {
    readStripeConfigOrNullMock.mockReturnValue({
      secretKey: "skRESV02_raw_stock",
      publishableKey: "pk_test_x",
    });
    resolveOrgIdByHostMock.mockResolvedValue("orgRESV2");
    stripeProductsList.mockResolvedValue({
      data: [freshProduct("prod_raw", "Mask Raw", 1000, 8)],
    });
    // Empty map → no holds → raw stock passes through untouched (fail-open
    // and the no-reservations common case share this branch).
    getActiveReservedBySkuMock.mockResolvedValue(new Map());

    const res = await request(makeApp()).get("/shop/products");
    expect(res.status).toBe(200);
    expect(res.body.products).toHaveLength(1);
    expect(res.body.products[0].id).toBe("prod_raw");
    expect(res.body.products[0].stockCount).toBe(8);
    expect(res.body.byCategory.mask[0].stockCount).toBe(8);
  });
});
