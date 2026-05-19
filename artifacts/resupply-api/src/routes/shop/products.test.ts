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

import productsRouter from "./products";

function makeApp(): Express {
  const app = express();
  app.use(productsRouter);
  return app;
}

function freshProduct(id: string, name: string, unitAmount: number) {
  // Shape matches Stripe.Product fields that projectProduct() inspects:
  // products-meta.ts:196–215 requires `metadata.category` to be a known
  // ShopCategory and `default_price` to be an active one_time Price.
  return {
    id,
    active: true,
    name,
    description: null,
    images: [],
    metadata: {
      category: "mask",
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
});
