// Route tests for the admin inventory endpoint in
// routes/admin/shop-products.ts. Mirrors the fluent-stub pattern in
// shop-reviews.test.ts. Coverage:
//   * non-admin → 401/403 (admin gate is real)
//   * 400 on a non-prod_ id (defense-in-depth before hitting Stripe)
//   * 400 on negative / non-integer stock count (zod validation)
//   * 503 in preview mode (no STRIPE_SECRET_KEY)
//   * Successful PATCH writes `metadata.stock_count = "<n>"` and
//     returns the projected product
//   * Sending `stockCount: null` writes the empty-string sentinel that
//     deletes the metadata key

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import express, { type Express } from "express";
import request from "supertest";

import {
  makeRequireAdminMock,
  type MockAdminCtx,
} from "../../test-helpers/auth-mocks";
import { __resetRateLimitsForTests } from "../../middlewares/rate-limit";

const { mockAdmin } = vi.hoisted(() => ({
  mockAdmin: { current: null as MockAdminCtx | null },
}));
vi.mock("../../middlewares/requireAdmin", () =>
  makeRequireAdminMock(mockAdmin),
);

// Stripe SDK stub. The PATCH routes need `retrieve` (catalog-membership
// precheck) + `update` (the actual metadata write). The POST route
// adds `search` (SKU collision guard), `products.create`, and
// `prices.create` (one-time + optional recurring). The price PATCH
// adds `prices.update` (archive replaced prices) and `prices.list`
// (recurring rotation). All flow through projectProduct (mocked
// below) so the handler reaches its happy path without a real
// Stripe fixture.
const stripeRetrieveMock = vi.fn();
const stripeUpdateMock = vi.fn();
const stripeSearchMock = vi.fn();
const stripeProductCreateMock = vi.fn();
const stripePriceCreateMock = vi.fn();
const stripePriceUpdateMock = vi.fn();
const stripePriceListMock = vi.fn();
vi.mock("../../lib/stripe/config", () => ({
  readStripeConfigOrNull: () => readStripeConfig(),
  getStripeClient: () => ({
    products: {
      retrieve: (...a: unknown[]) => stripeRetrieveMock(...a),
      update: (...a: unknown[]) => stripeUpdateMock(...a),
      search: (...a: unknown[]) => stripeSearchMock(...a),
      create: (...a: unknown[]) => stripeProductCreateMock(...a),
    },
    prices: {
      create: (...a: unknown[]) => stripePriceCreateMock(...a),
      update: (...a: unknown[]) => stripePriceUpdateMock(...a),
      list: (...a: unknown[]) => stripePriceListMock(...a),
    },
  }),
}));

let stripeConfigured = true;
function readStripeConfig(): { secretKey: string } | null {
  return stripeConfigured ? { secretKey: "sk_test_x" } : null;
}

// The price PATCH drops the public catalog's in-process cache after
// a successful default_price repoint (and again after a recurring
// rotation) so the storefront stops serving the replaced price id —
// which checkout validation rejects — for the rest of the 60s TTL.
// Mocked so this admin-route test stays hermetic and the calls are
// assertable.
const invalidateCacheMock = vi.fn();
vi.mock("../shop/products", () => ({
  invalidateShopProductsCache: () => invalidateCacheMock(),
}));

// Supabase Storage stub for the image-upload endpoint. Only the
// `storage.from(bucket).upload/getPublicUrl` surface the route touches
// is modeled.
const storageUploadMock = vi.fn();
const storageGetPublicUrlMock = vi.fn();
vi.mock("@workspace/resupply-db", () => ({
  getSupabaseServiceRoleClient: () => ({
    storage: {
      from: () => ({
        upload: (...a: unknown[]) => storageUploadMock(...a),
        getPublicUrl: (...a: unknown[]) => storageGetPublicUrlMock(...a),
      }),
    },
  }),
}));

// projectProduct stub — vi.fn() so individual tests can override
// the result (e.g. return null to simulate a non-catalog product
// that the catalog-membership guard must reject).
const projectProductMock = vi.fn();
vi.mock("../../lib/stripe/products-meta", async () => {
  // Pull in the REAL SHOP_CATEGORIES so the POST route's
  // `z.enum(SHOP_CATEGORIES)` produces a valid schema. Originally
  // we returned an empty array since only PATCH tests existed and
  // the route didn't need it; the POST endpoint added in Phase 3
  // depends on it at module-load time, and an empty enum rejected
  // every category with "Expected , received 'mask'".
  const actual = await vi.importActual<
    typeof import("../../lib/stripe/products-meta")
  >("../../lib/stripe/products-meta");
  return {
    ...actual,
    projectProduct: (raw: {
      id: string;
      name?: string;
      metadata?: Record<string, string>;
    }) => projectProductMock(raw),
  };
});

// Default projection: every product is in the catalog. Tests that
// need to simulate a non-catalog product override this with
// projectProductMock.mockReturnValueOnce(null) BEFORE issuing the
// PATCH (note: handler calls projectProduct twice in the 200 path
// — once for the precheck retrieve, once for the post-update
// payload — so use mockReturnValue to cover both calls or chain
// two mockReturnValueOnce calls).
function defaultProjection(raw: {
  id: string;
  name?: string;
  metadata?: Record<string, string>;
  default_price?: { id?: string; unit_amount?: number };
}): {
  id: string;
  name: string;
  category: string;
  price: { id: string; unitAmount: number; currency: string };
  stockCount: number | null;
  lowStockThreshold: number | null;
} {
  return {
    id: raw.id,
    name: raw.name ?? "Test SKU",
    category: "accessories",
    // Mirror the real ShopProductView field name (unitAmount, not
    // amount) so a future contract drift breaks this test. When the
    // raw fixture carries an expanded default_price (the price-PATCH
    // tests), project it through like the real projectProduct does —
    // the price handler reads `price.id` (to archive the replaced
    // Price) and `price.unitAmount` (no-op short-circuit).
    price: {
      id: raw.default_price?.id ?? "price_old",
      unitAmount: raw.default_price?.unit_amount ?? 1999,
      currency: "usd",
    },
    stockCount: raw.metadata?.stock_count
      ? parseInt(raw.metadata.stock_count, 10)
      : null,
    // Mirror the real projection's null-on-missing semantics. A
    // value of `null` means "use the storefront default" and is the
    // expected output for SKUs that don't carry the metadata key.
    lowStockThreshold: raw.metadata?.low_stock_threshold
      ? parseInt(raw.metadata.low_stock_threshold, 10)
      : null,
  };
}

import shopProductsAdminRouter from "./shop-products";

const ALLOWED_EMAIL = "ops@penn.example.com";

function makeApp(): Express {
  const app = express();
  app.use(express.json());
  app.use("/resupply-api", shopProductsAdminRouter);
  return app;
}

function stubVerifiedAdmin(): void {
  mockAdmin.current = {
    userId: "user_op",
    email: ALLOWED_EMAIL,
    role: "admin",
  };
}

const ENV_KEYS = [
  "RESUPPLY_ADMIN_EMAILS",
  "NODE_ENV",
  "SUPABASE_STORAGE_BUCKET_PUBLIC",
] as const;
type EnvKey = (typeof ENV_KEYS)[number];
const originalEnv: Partial<Record<EnvKey, string | undefined>> = {};

beforeEach(() => {
  for (const k of ENV_KEYS) originalEnv[k] = process.env[k];
  for (const k of ENV_KEYS) delete process.env[k];

  process.env.NODE_ENV = "test";
  process.env.RESUPPLY_ADMIN_EMAILS = ALLOWED_EMAIL;
  // The catalog-mutation limiter (30/hour per admin) is module-level
  // state shared across this whole file; without a reset the later
  // describe blocks exhaust the budget and 429.
  __resetRateLimitsForTests();
  stripeConfigured = true;
  stripeRetrieveMock.mockReset();
  stripeUpdateMock.mockReset();
  stripeSearchMock.mockReset();
  stripeProductCreateMock.mockReset();
  stripePriceCreateMock.mockReset();
  stripePriceUpdateMock.mockReset();
  stripePriceListMock.mockReset();
  invalidateCacheMock.mockReset();
  // Default: archive succeeds, no recurring prices to rotate. The
  // price-PATCH tests that exercise rotation override prices.list.
  stripePriceUpdateMock.mockResolvedValue({});
  stripePriceListMock.mockResolvedValue({ data: [] });
  storageUploadMock.mockReset();
  storageGetPublicUrlMock.mockReset();
  storageUploadMock.mockResolvedValue({ error: null });
  storageGetPublicUrlMock.mockImplementation((path: unknown) => ({
    data: {
      publicUrl: `https://supabase.example.com/storage/v1/object/public/assets/${String(path)}`,
    },
  }));
  projectProductMock.mockReset();
  // Default: every product projects successfully (i.e. is in the
  // catalog). Tests that need to simulate a non-catalog product
  // override this with mockReturnValueOnce(null).
  projectProductMock.mockImplementation(defaultProjection);
  mockAdmin.current = null;
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (originalEnv[k] === undefined) delete process.env[k];
    else process.env[k] = originalEnv[k];
  }
});

describe("PATCH /admin/shop/products/:productId/stock", () => {
  it("rejects callers without admin sign-in", async () => {
    const res = await request(makeApp())
      .patch("/resupply-api/admin/shop/products/prod_x/stock")
      .send({ stockCount: 5 });
    expect([401, 403]).toContain(res.status);
  });

  it("rejects ids that don't start with prod_", async () => {
    stubVerifiedAdmin();
    const res = await request(makeApp())
      .patch("/resupply-api/admin/shop/products/x/stock")
      .send({ stockCount: 5 });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_product_id");
    expect(stripeUpdateMock).not.toHaveBeenCalled();
  });

  it("rejects negative stock counts", async () => {
    stubVerifiedAdmin();
    const res = await request(makeApp())
      .patch("/resupply-api/admin/shop/products/prod_x/stock")
      .send({ stockCount: -3 });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_body");
    expect(stripeUpdateMock).not.toHaveBeenCalled();
  });

  it("rejects non-integer stock counts", async () => {
    stubVerifiedAdmin();
    const res = await request(makeApp())
      .patch("/resupply-api/admin/shop/products/prod_x/stock")
      .send({ stockCount: 2.5 });
    expect(res.status).toBe(400);
    expect(stripeUpdateMock).not.toHaveBeenCalled();
  });

  it("returns 503 in preview mode (no Stripe key)", async () => {
    stubVerifiedAdmin();
    stripeConfigured = false;
    const res = await request(makeApp())
      .patch("/resupply-api/admin/shop/products/prod_x/stock")
      .send({ stockCount: 5 });
    expect(res.status).toBe(503);
    expect(res.body.error).toBe("stripe_not_configured");
    expect(stripeUpdateMock).not.toHaveBeenCalled();
  });

  it("writes metadata.stock_count and returns the projected product", async () => {
    stubVerifiedAdmin();
    // The route now retrieves first (catalog membership precheck)
    // and then updates. Both calls return projectable product
    // shapes via the default projectProduct mock.
    stripeRetrieveMock.mockResolvedValue({
      id: "prod_x",
      name: "Test SKU",
      metadata: {},
    });
    stripeUpdateMock.mockResolvedValue({
      id: "prod_x",
      name: "Test SKU",
      metadata: { stock_count: "7" },
    });
    const res = await request(makeApp())
      .patch("/resupply-api/admin/shop/products/prod_x/stock")
      .send({ stockCount: 7 });
    expect(res.status).toBe(200);
    expect(stripeRetrieveMock).toHaveBeenCalledTimes(1);
    expect(stripeUpdateMock).toHaveBeenCalledTimes(1);
    const [productId, payload] = stripeUpdateMock.mock.calls[0]!;
    expect(productId).toBe("prod_x");
    expect(
      (payload as { metadata: Record<string, string> }).metadata.stock_count,
    ).toBe("7");
    expect(res.body.product.stockCount).toBe(7);
    // Sanity-check the API/frontend contract: ShopProductView
    // exposes prices as `price.unitAmount` (NOT `price.amount`).
    // Locks the dashboard inventory client's expected field shape.
    expect(res.body.product.price.unitAmount).toBe(1999);
  });

  it("clears metadata.stock_count by sending an empty string when stockCount=null", async () => {
    stubVerifiedAdmin();
    stripeRetrieveMock.mockResolvedValue({
      id: "prod_x",
      name: "Test SKU",
      metadata: { stock_count: "5" },
    });
    stripeUpdateMock.mockResolvedValue({
      id: "prod_x",
      name: "Test SKU",
      metadata: {}, // stock_count was deleted
    });
    const res = await request(makeApp())
      .patch("/resupply-api/admin/shop/products/prod_x/stock")
      .send({ stockCount: null });
    expect(res.status).toBe(200);
    const [, payload] = stripeUpdateMock.mock.calls[0]!;
    // The Stripe contract: setting a metadata key to "" deletes it.
    expect(
      (payload as { metadata: Record<string, string> }).metadata.stock_count,
    ).toBe("");
    expect(res.body.product.stockCount).toBeNull();
  });

  it("rejects with 404 when the product is not in the shop catalog", async () => {
    stubVerifiedAdmin();
    // Stripe returns the product, but projectProduct returns null —
    // i.e. the product is missing the shop_category metadata that
    // qualifies it as a catalog SKU. Without the catalog-membership
    // guard the route would happily write stock_count metadata to
    // an arbitrary Stripe product, which is the over-broad-write
    // bug we're guarding against.
    stripeRetrieveMock.mockResolvedValue({
      id: "prod_other",
      name: "Some other product",
      metadata: {},
    });
    projectProductMock.mockReturnValueOnce(null);
    const res = await request(makeApp())
      .patch("/resupply-api/admin/shop/products/prod_other/stock")
      .send({ stockCount: 9 });
    expect(res.status).toBe(404);
    expect(res.body.error).toBe("product_not_in_catalog");
    // Critically: the update was NEVER called.
    expect(stripeUpdateMock).not.toHaveBeenCalled();
  });

  it("rejects with 404 when Stripe says the product does not exist", async () => {
    stubVerifiedAdmin();
    // Stripe SDK surfaces 'No such product' as an error with
    // statusCode 404. The handler should pass that through cleanly
    // rather than wrapping it as a 502.
    const notFound = Object.assign(new Error("No such product"), {
      statusCode: 404,
    });
    stripeRetrieveMock.mockRejectedValue(notFound);
    const res = await request(makeApp())
      .patch("/resupply-api/admin/shop/products/prod_missing/stock")
      .send({ stockCount: 1 });
    expect(res.status).toBe(404);
    expect(res.body.error).toBe("product_not_found");
    expect(stripeUpdateMock).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────────
// PATCH /admin/shop/products/:productId/price — reprice a SKU
// ─────────────────────────────────────────────────────────────────────
//
// Stripe Prices are immutable, so the handler creates a NEW one-time
// Price, repoints default_price, archives the replaced Price, and
// rotates any active recurring (Subscribe & Save) prices to the new
// amount. Coverage:
//   - non-admin                       → 401/403, nothing sent to Stripe
//   - non-prod_ id                    → 400
//   - non-integer / sub-minimum cents → 400 (zod)
//   - preview mode (no Stripe key)    → 503
//   - product not in catalog          → 404, no writes
//   - happy path                      → create → repoint → archive old
//   - same amount                     → idempotent no-op, zero writes
//   - recurring rotation              → new recurring at same cadence,
//                                       old recurring archived
//   - default_price repoint fails     → 502, old price NOT archived
//   - archive failure                 → non-fatal, still 200

describe("PATCH /admin/shop/products/:productId/price", () => {
  function stubExistingProduct(): void {
    stripeRetrieveMock.mockResolvedValue({
      id: "prod_x",
      name: "Test SKU",
      metadata: {},
      default_price: { id: "price_old", unit_amount: 1999 },
    });
  }
  function stubRepointedProduct(unitAmount = 2499): void {
    stripeUpdateMock.mockResolvedValue({
      id: "prod_x",
      name: "Test SKU",
      metadata: {},
      default_price: { id: "price_new", unit_amount: unitAmount },
    });
  }

  it("rejects callers without admin sign-in", async () => {
    const res = await request(makeApp())
      .patch("/resupply-api/admin/shop/products/prod_x/price")
      .send({ unitAmountCents: 2499 });
    expect([401, 403]).toContain(res.status);
    expect(stripePriceCreateMock).not.toHaveBeenCalled();
  });

  it("rejects ids that don't start with prod_", async () => {
    stubVerifiedAdmin();
    const res = await request(makeApp())
      .patch("/resupply-api/admin/shop/products/x/price")
      .send({ unitAmountCents: 2499 });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_product_id");
    expect(stripePriceCreateMock).not.toHaveBeenCalled();
  });

  it("rejects non-integer cent amounts", async () => {
    stubVerifiedAdmin();
    const res = await request(makeApp())
      .patch("/resupply-api/admin/shop/products/prod_x/price")
      .send({ unitAmountCents: 19.99 });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_body");
    expect(stripePriceCreateMock).not.toHaveBeenCalled();
  });

  it("rejects amounts below the Stripe minimum", async () => {
    stubVerifiedAdmin();
    const res = await request(makeApp())
      .patch("/resupply-api/admin/shop/products/prod_x/price")
      .send({ unitAmountCents: 10 });
    expect(res.status).toBe(400);
    expect(stripePriceCreateMock).not.toHaveBeenCalled();
  });

  it("rejects null (price is required, unlike stock/threshold)", async () => {
    stubVerifiedAdmin();
    const res = await request(makeApp())
      .patch("/resupply-api/admin/shop/products/prod_x/price")
      .send({ unitAmountCents: null });
    expect(res.status).toBe(400);
    expect(stripePriceCreateMock).not.toHaveBeenCalled();
  });

  it("returns 503 in preview mode (no Stripe key)", async () => {
    stubVerifiedAdmin();
    stripeConfigured = false;
    const res = await request(makeApp())
      .patch("/resupply-api/admin/shop/products/prod_x/price")
      .send({ unitAmountCents: 2499 });
    expect(res.status).toBe(503);
    expect(res.body.error).toBe("stripe_not_configured");
    expect(stripePriceCreateMock).not.toHaveBeenCalled();
  });

  it("rejects with 404 when the product is not in the shop catalog", async () => {
    stubVerifiedAdmin();
    stripeRetrieveMock.mockResolvedValue({
      id: "prod_other",
      name: "Some other product",
      metadata: {},
    });
    projectProductMock.mockReturnValueOnce(null);
    const res = await request(makeApp())
      .patch("/resupply-api/admin/shop/products/prod_other/price")
      .send({ unitAmountCents: 2499 });
    expect(res.status).toBe(404);
    expect(res.body.error).toBe("product_not_in_catalog");
    expect(stripePriceCreateMock).not.toHaveBeenCalled();
    expect(stripeUpdateMock).not.toHaveBeenCalled();
  });

  it("creates a new price, repoints default_price, archives the old price", async () => {
    stubVerifiedAdmin();
    stubExistingProduct();
    stripePriceCreateMock.mockResolvedValue({ id: "price_new" });
    stubRepointedProduct(2499);
    const res = await request(makeApp())
      .patch("/resupply-api/admin/shop/products/prod_x/price")
      .send({ unitAmountCents: 2499 });
    expect(res.status).toBe(200);
    // New price at the new amount, in the product's existing currency.
    expect(stripePriceCreateMock).toHaveBeenCalledTimes(1);
    expect(stripePriceCreateMock.mock.calls[0]![0]).toEqual({
      product: "prod_x",
      unit_amount: 2499,
      currency: "usd",
    });
    // default_price repointed at the new price.
    const [updateProductId, updatePayload] = stripeUpdateMock.mock.calls[0]!;
    expect(updateProductId).toBe("prod_x");
    expect((updatePayload as { default_price: string }).default_price).toBe(
      "price_new",
    );
    // Replaced price archived AFTER the repoint (Stripe refuses to
    // archive a product's current default_price).
    expect(stripePriceUpdateMock).toHaveBeenCalledWith("price_old", {
      active: false,
    });
    // The public catalog cache was dropped, so the storefront stops
    // serving the replaced price id without waiting out the 60s TTL.
    expect(invalidateCacheMock).toHaveBeenCalledTimes(1);
    // Response carries the re-projected product at the new amount.
    expect(res.body.product.price.unitAmount).toBe(2499);
  });

  it("is an idempotent no-op when the amount is unchanged", async () => {
    stubVerifiedAdmin();
    stubExistingProduct(); // current amount: 1999
    const res = await request(makeApp())
      .patch("/resupply-api/admin/shop/products/prod_x/price")
      .send({ unitAmountCents: 1999 });
    expect(res.status).toBe(200);
    expect(res.body.product.price.unitAmount).toBe(1999);
    // Critically: no Price churn in Stripe, and the catalog cache
    // keeps its (still-correct) snapshot.
    expect(stripePriceCreateMock).not.toHaveBeenCalled();
    expect(stripeUpdateMock).not.toHaveBeenCalled();
    expect(stripePriceUpdateMock).not.toHaveBeenCalled();
    expect(invalidateCacheMock).not.toHaveBeenCalled();
  });

  it("rotates the Subscribe & Save price to the new amount at the same cadence", async () => {
    stubVerifiedAdmin();
    stubExistingProduct();
    stripePriceCreateMock
      .mockResolvedValueOnce({ id: "price_new" })
      .mockResolvedValueOnce({ id: "price_rec_new" });
    stubRepointedProduct(2499);
    stripePriceListMock.mockResolvedValue({
      data: [
        {
          id: "price_rec_old",
          unit_amount: 1999,
          recurring: { interval: "month", interval_count: 3 },
        },
      ],
    });
    const res = await request(makeApp())
      .patch("/resupply-api/admin/shop/products/prod_x/price")
      .send({ unitAmountCents: 2499 });
    expect(res.status).toBe(200);
    // Second create: recurring price at the NEW amount, SAME cadence
    // (v1 policy: subscription price == one-time price).
    expect(stripePriceCreateMock).toHaveBeenCalledTimes(2);
    expect(stripePriceCreateMock.mock.calls[1]![0]).toEqual({
      product: "prod_x",
      unit_amount: 2499,
      currency: "usd",
      recurring: { interval: "month", interval_count: 3 },
    });
    // Both the old default price AND the old recurring price retired.
    expect(stripePriceUpdateMock).toHaveBeenCalledWith("price_old", {
      active: false,
    });
    expect(stripePriceUpdateMock).toHaveBeenCalledWith("price_rec_old", {
      active: false,
    });
    // Cache dropped twice: once when default_price repointed, once
    // after the recurring rotation (a GET between the two could have
    // re-cached the old recurring price).
    expect(invalidateCacheMock).toHaveBeenCalledTimes(2);
  });

  it("returns 502 and does NOT archive the old price when the repoint fails", async () => {
    stubVerifiedAdmin();
    stubExistingProduct();
    stripePriceCreateMock.mockResolvedValue({ id: "price_new" });
    const stripeErr = Object.assign(new Error("Stripe is down"), {
      statusCode: 502,
    });
    stripeUpdateMock.mockRejectedValue(stripeErr);
    const res = await request(makeApp())
      .patch("/resupply-api/admin/shop/products/prod_x/price")
      .send({ unitAmountCents: 2499 });
    expect(res.status).toBe(502);
    expect(res.body.error).toBe("stripe_set_default_price_failed");
    // The old price is still the live default — archiving it would
    // take the SKU off the storefront entirely, and the cached
    // catalog (still the old price) remains correct.
    expect(stripePriceUpdateMock).not.toHaveBeenCalled();
    expect(invalidateCacheMock).not.toHaveBeenCalled();
  });

  it("still returns 200 when archiving the replaced price fails", async () => {
    stubVerifiedAdmin();
    stubExistingProduct();
    stripePriceCreateMock.mockResolvedValue({ id: "price_new" });
    stubRepointedProduct(2499);
    stripePriceUpdateMock.mockRejectedValue(
      Object.assign(new Error("archive failed"), { statusCode: 502 }),
    );
    const res = await request(makeApp())
      .patch("/resupply-api/admin/shop/products/prod_x/price")
      .send({ unitAmountCents: 2499 });
    // The storefront price IS switched (default_price repointed); a
    // leftover active-but-unused price object is hygiene, not an error.
    expect(res.status).toBe(200);
    expect(res.body.product.price.unitAmount).toBe(2499);
  });
});

// ─────────────────────────────────────────────────────────────────────
// POST /admin/shop/products — create a new SKU
// ─────────────────────────────────────────────────────────────────────
//
// Coverage matrix:
//   - non-admin                       → 401/403
//   - bad SKU (uppercase/symbols)     → 400 invalid_body
//   - missing required fields         → 400 invalid_body
//   - bundleContents on non-bundle    → 400 invalid_body
//   - partial recurring (interval only, no count) → 400
//   - preview mode (no Stripe key)    → 503
//   - SKU already exists              → 409 with existing productId
//   - happy path one-time price       → 201, projection returned,
//                                       metadata + price wired correctly
//   - happy path with recurring price → 201, recurring price created
//   - product create fails            → 502 (clean error code)
//   - price create fails AFTER product create → 502 + productId in body
//   - unprojectable result            → 422 + productId

const VALID_BODY = {
  sku: "test-sku-x",
  name: "Test Product X",
  description: "A test product description with enough length.",
  category: "mask",
  unitAmountCents: 1999,
};

describe("POST /admin/shop/products", () => {
  function stubNoCollision(): void {
    // Default search returns no existing product (empty data array)
    stripeSearchMock.mockResolvedValue({ data: [] });
  }
  function stubProductCreate(productId = "prod_new") {
    stripeProductCreateMock.mockResolvedValue({
      id: productId,
      name: "Test Product X",
      metadata: { shop_sku: "test-sku-x", category: "mask" },
    });
  }
  function stubPriceCreate(priceId = "price_new") {
    stripePriceCreateMock.mockResolvedValue({
      id: priceId,
      unit_amount: 1999,
      currency: "usd",
    });
  }
  function stubProductUpdate(productId = "prod_new") {
    stripeUpdateMock.mockResolvedValue({
      id: productId,
      name: "Test Product X",
      metadata: { shop_sku: "test-sku-x", category: "mask" },
      default_price: { id: "price_new", unit_amount: 1999, currency: "usd" },
    });
  }

  it("rejects callers without admin sign-in", async () => {
    const res = await request(makeApp())
      .post("/resupply-api/admin/shop/products")
      .send(VALID_BODY);
    expect([401, 403]).toContain(res.status);
    // Critically: nothing was sent to Stripe.
    expect(stripeProductCreateMock).not.toHaveBeenCalled();
    expect(stripePriceCreateMock).not.toHaveBeenCalled();
  });

  it("rejects bad SKU (uppercase / symbols)", async () => {
    stubVerifiedAdmin();
    const res = await request(makeApp())
      .post("/resupply-api/admin/shop/products")
      .send({ ...VALID_BODY, sku: "Bad SKU!" });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_body");
    expect(stripeSearchMock).not.toHaveBeenCalled();
    expect(stripeProductCreateMock).not.toHaveBeenCalled();
  });

  it("rejects missing required fields", async () => {
    stubVerifiedAdmin();
    const res = await request(makeApp())
      .post("/resupply-api/admin/shop/products")
      .send({ sku: "test-sku-x" }); // missing name/description/etc
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_body");
    expect(stripeProductCreateMock).not.toHaveBeenCalled();
  });

  it("rejects unitAmountCents below Stripe minimum", async () => {
    stubVerifiedAdmin();
    const res = await request(makeApp())
      .post("/resupply-api/admin/shop/products")
      .send({ ...VALID_BODY, unitAmountCents: 10 });
    expect(res.status).toBe(400);
    expect(stripeProductCreateMock).not.toHaveBeenCalled();
  });

  it("rejects bundleContents on a non-bundle category", async () => {
    stubVerifiedAdmin();
    const res = await request(makeApp())
      .post("/resupply-api/admin/shop/products")
      .send({
        ...VALID_BODY,
        bundleContents: ["1× thing"],
      });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_body");
    // Cross-field validation runs BEFORE the Stripe round-trip.
    expect(stripeSearchMock).not.toHaveBeenCalled();
  });

  it("rejects partial recurring (interval present, count missing)", async () => {
    stubVerifiedAdmin();
    const res = await request(makeApp())
      .post("/resupply-api/admin/shop/products")
      .send({
        ...VALID_BODY,
        recurringInterval: "month",
        // recurringIntervalCount missing
      });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_body");
    expect(stripeProductCreateMock).not.toHaveBeenCalled();
  });

  it("returns 503 in preview mode (no Stripe key)", async () => {
    stubVerifiedAdmin();
    stripeConfigured = false;
    const res = await request(makeApp())
      .post("/resupply-api/admin/shop/products")
      .send(VALID_BODY);
    expect(res.status).toBe(503);
    expect(res.body.error).toBe("stripe_not_configured");
    expect(stripeProductCreateMock).not.toHaveBeenCalled();
  });

  it("returns 409 when SKU already exists", async () => {
    stubVerifiedAdmin();
    stripeSearchMock.mockResolvedValue({
      data: [{ id: "prod_existing" }],
    });
    const res = await request(makeApp())
      .post("/resupply-api/admin/shop/products")
      .send(VALID_BODY);
    expect(res.status).toBe(409);
    expect(res.body.error).toBe("sku_already_exists");
    expect(res.body.productId).toBe("prod_existing");
    // Critically: no product or price was created.
    expect(stripeProductCreateMock).not.toHaveBeenCalled();
    expect(stripePriceCreateMock).not.toHaveBeenCalled();
  });

  it("creates a one-time product end-to-end (happy path)", async () => {
    stubVerifiedAdmin();
    stubNoCollision();
    stubProductCreate("prod_new");
    stubPriceCreate("price_new");
    stubProductUpdate("prod_new");
    const res = await request(makeApp())
      .post("/resupply-api/admin/shop/products")
      .send({
        ...VALID_BODY,
        tagline: "test tagline",
        manufacturer: "ResMed",
        modelNumber: "X1",
        stockCount: 12,
        lowStockThreshold: 3,
        imageUrl: "https://example.com/img.webp",
      });
    expect(res.status).toBe(201);
    // Search was called with the SKU collision query.
    expect(stripeSearchMock).toHaveBeenCalledTimes(1);
    // Product created with correct payload.
    expect(stripeProductCreateMock).toHaveBeenCalledTimes(1);
    const createPayload = stripeProductCreateMock.mock.calls[0]![0] as {
      name: string;
      description: string;
      metadata: Record<string, string>;
      images?: string[];
    };
    expect(createPayload.name).toBe("Test Product X");
    expect(createPayload.metadata.shop_sku).toBe("test-sku-x");
    expect(createPayload.metadata.category).toBe("mask");
    expect(createPayload.metadata.tagline).toBe("test tagline");
    expect(createPayload.metadata.manufacturer).toBe("ResMed");
    expect(createPayload.metadata.model_number).toBe("X1");
    expect(createPayload.metadata.stock_count).toBe("12");
    expect(createPayload.metadata.low_stock_threshold).toBe("3");
    expect(createPayload.images).toEqual(["https://example.com/img.webp"]);
    // One-time price created (no `recurring` field).
    expect(stripePriceCreateMock).toHaveBeenCalledTimes(1);
    const pricePayload = stripePriceCreateMock.mock.calls[0]![0] as {
      product: string;
      unit_amount: number;
      currency: string;
      recurring?: unknown;
    };
    expect(pricePayload.product).toBe("prod_new");
    expect(pricePayload.unit_amount).toBe(1999);
    expect(pricePayload.currency).toBe("usd");
    expect(pricePayload.recurring).toBeUndefined();
    // default_price wired up.
    expect(stripeUpdateMock).toHaveBeenCalledTimes(1);
    const [updateProductId, updatePayload] = stripeUpdateMock.mock.calls[0]!;
    expect(updateProductId).toBe("prod_new");
    expect((updatePayload as { default_price: string }).default_price).toBe(
      "price_new",
    );
    // Body returns the projected product.
    expect(res.body.product.id).toBe("prod_new");
  });

  it("creates a recurring price when recurringInterval+Count are set", async () => {
    stubVerifiedAdmin();
    stubNoCollision();
    stubProductCreate("prod_new");
    // First call → one-time price; second call → recurring price.
    stripePriceCreateMock
      .mockResolvedValueOnce({ id: "price_one_time" })
      .mockResolvedValueOnce({ id: "price_recurring" });
    stubProductUpdate("prod_new");
    const res = await request(makeApp())
      .post("/resupply-api/admin/shop/products")
      .send({
        ...VALID_BODY,
        recurringInterval: "month",
        recurringIntervalCount: 3,
      });
    expect(res.status).toBe(201);
    expect(stripePriceCreateMock).toHaveBeenCalledTimes(2);
    // First price: one-time.
    const oneTime = stripePriceCreateMock.mock.calls[0]![0] as {
      recurring?: unknown;
    };
    expect(oneTime.recurring).toBeUndefined();
    // Second price: recurring with the right cadence.
    const recurring = stripePriceCreateMock.mock.calls[1]![0] as {
      recurring: { interval: string; interval_count: number };
    };
    expect(recurring.recurring.interval).toBe("month");
    expect(recurring.recurring.interval_count).toBe(3);
    // default_price points at the ONE-TIME price (recurring stays
    // alongside, addressed via projection).
    const updatePayload = stripeUpdateMock.mock.calls[0]![1] as {
      default_price: string;
    };
    expect(updatePayload.default_price).toBe("price_one_time");
  });

  it("accepts bundleContents on a bundle category", async () => {
    stubVerifiedAdmin();
    stubNoCollision();
    stubProductCreate("prod_bundle");
    stubPriceCreate("price_bundle");
    stubProductUpdate("prod_bundle");
    const res = await request(makeApp())
      .post("/resupply-api/admin/shop/products")
      .send({
        ...VALID_BODY,
        sku: "bundle-test",
        category: "bundle",
        bundleContents: ["1× cushion", "1× tubing"],
      });
    expect(res.status).toBe(201);
    const createPayload = stripeProductCreateMock.mock.calls[0]![0] as {
      metadata: Record<string, string>;
    };
    expect(createPayload.metadata.bundle).toBe("true");
    expect(JSON.parse(createPayload.metadata.bundle_contents)).toEqual([
      "1× cushion",
      "1× tubing",
    ]);
  });

  it("returns 502 when product create fails (price never called)", async () => {
    stubVerifiedAdmin();
    stubNoCollision();
    const stripeErr = Object.assign(new Error("Stripe is down"), {
      statusCode: 502,
    });
    stripeProductCreateMock.mockRejectedValue(stripeErr);
    const res = await request(makeApp())
      .post("/resupply-api/admin/shop/products")
      .send(VALID_BODY);
    expect(res.status).toBe(502);
    expect(res.body.error).toBe("stripe_create_failed");
    // Critically: no price was created either.
    expect(stripePriceCreateMock).not.toHaveBeenCalled();
  });

  it("returns 502 with productId when price create fails after product create", async () => {
    stubVerifiedAdmin();
    stubNoCollision();
    stubProductCreate("prod_orphaned");
    const priceErr = Object.assign(new Error("price failed"), {
      statusCode: 502,
    });
    stripePriceCreateMock.mockRejectedValue(priceErr);
    const res = await request(makeApp())
      .post("/resupply-api/admin/shop/products")
      .send(VALID_BODY);
    expect(res.status).toBe(502);
    expect(res.body.error).toBe("stripe_price_create_failed");
    // The orphaned-product hint lets the operator clean up in the
    // Stripe Dashboard rather than silently leaking the product id.
    expect(res.body.productId).toBe("prod_orphaned");
    // default_price was never set (no second update call).
    expect(stripeUpdateMock).not.toHaveBeenCalled();
  });

  it("returns 422 when the projected product fails the catalog gate", async () => {
    stubVerifiedAdmin();
    stubNoCollision();
    stubProductCreate("prod_unprojectable");
    stubPriceCreate("price_x");
    stubProductUpdate("prod_unprojectable");
    // Force projectProduct to return null (e.g. metadata validation
    // somehow rejects after writes — defensive 422).
    projectProductMock.mockReturnValueOnce(null);
    const res = await request(makeApp())
      .post("/resupply-api/admin/shop/products")
      .send(VALID_BODY);
    expect(res.status).toBe(422);
    expect(res.body.error).toBe("unprojectable_product");
    expect(res.body.productId).toBe("prod_unprojectable");
  });
});

describe("POST /admin/shop/products/image-upload", () => {
  const PNG_BYTES = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    Buffer.alloc(64, 1),
  ]);

  function stubPublicBucket(): void {
    process.env.SUPABASE_STORAGE_BUCKET_PUBLIC = "assets";
  }

  it("rejects callers without admin sign-in", async () => {
    stubPublicBucket();
    const res = await request(makeApp())
      .post("/resupply-api/admin/shop/products/image-upload")
      .set("Content-Type", "image/png")
      .send(PNG_BYTES);
    expect([401, 403]).toContain(res.status);
    expect(storageUploadMock).not.toHaveBeenCalled();
  });

  it("rejects content types outside the allowlist", async () => {
    stubVerifiedAdmin();
    stubPublicBucket();
    const res = await request(makeApp())
      .post("/resupply-api/admin/shop/products/image-upload")
      .set("Content-Type", "image/gif")
      .send(Buffer.from("GIF89a"));
    expect(res.status).toBe(415);
    expect(res.body.error).toBe("unsupported_image_type");
    expect(storageUploadMock).not.toHaveBeenCalled();
  });

  it("rejects bytes that don't match the declared image type", async () => {
    stubVerifiedAdmin();
    stubPublicBucket();
    const res = await request(makeApp())
      .post("/resupply-api/admin/shop/products/image-upload")
      .set("Content-Type", "image/png")
      .send(Buffer.from("<html>not a png</html>"));
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("image_bytes_mismatch");
    expect(storageUploadMock).not.toHaveBeenCalled();
  });

  it("returns 503 when the public bucket env is unset", async () => {
    stubVerifiedAdmin();
    const res = await request(makeApp())
      .post("/resupply-api/admin/shop/products/image-upload")
      .set("Content-Type", "image/png")
      .send(PNG_BYTES);
    expect(res.status).toBe(503);
    expect(res.body.error).toBe("public_storage_not_configured");
    expect(storageUploadMock).not.toHaveBeenCalled();
  });

  it("uploads to the public bucket and returns the public URL", async () => {
    stubVerifiedAdmin();
    stubPublicBucket();
    const res = await request(makeApp())
      .post("/resupply-api/admin/shop/products/image-upload")
      .set("Content-Type", "image/png")
      .send(PNG_BYTES);
    expect(res.status).toBe(201);
    expect(res.body.imageUrl).toMatch(
      /^https:\/\/supabase\.example\.com\/.+shop-products\/[0-9a-f-]+\.png$/,
    );
    expect(storageUploadMock).toHaveBeenCalledTimes(1);
    const [path, bytes, options] = storageUploadMock.mock.calls[0] as [
      string,
      Buffer,
      { contentType: string },
    ];
    expect(path).toMatch(/^shop-products\/[0-9a-f-]+\.png$/);
    expect(Buffer.isBuffer(bytes)).toBe(true);
    expect(options.contentType).toBe("image/png");
  });

  it("returns 502 when the storage upload fails", async () => {
    stubVerifiedAdmin();
    stubPublicBucket();
    storageUploadMock.mockResolvedValueOnce({
      error: { message: "bucket exploded" },
    });
    const res = await request(makeApp())
      .post("/resupply-api/admin/shop/products/image-upload")
      .set("Content-Type", "image/png")
      .send(PNG_BYTES);
    expect(res.status).toBe(502);
    expect(res.body.error).toBe("image_upload_failed");
  });
});

describe("PATCH /admin/shop/products/:productId/details", () => {
  it("rejects callers without admin sign-in", async () => {
    const res = await request(makeApp())
      .patch("/resupply-api/admin/shop/products/prod_x/details")
      .send({ name: "New name" });
    expect([401, 403]).toContain(res.status);
    expect(stripeUpdateMock).not.toHaveBeenCalled();
  });

  it("rejects ids that don't start with prod_", async () => {
    stubVerifiedAdmin();
    const res = await request(makeApp())
      .patch("/resupply-api/admin/shop/products/x/details")
      .send({ name: "New name" });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_product_id");
    expect(stripeUpdateMock).not.toHaveBeenCalled();
  });

  it("rejects an empty patch (no fields to update)", async () => {
    stubVerifiedAdmin();
    const res = await request(makeApp())
      .patch("/resupply-api/admin/shop/products/prod_x/details")
      .send({});
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_body");
    expect(stripeUpdateMock).not.toHaveBeenCalled();
  });

  it("rejects identity fields (sku/category are not editable)", async () => {
    stubVerifiedAdmin();
    const res = await request(makeApp())
      .patch("/resupply-api/admin/shop/products/prod_x/details")
      .send({ sku: "new-sku" });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_body");
    expect(stripeUpdateMock).not.toHaveBeenCalled();
  });

  it("rejects non-https image URLs", async () => {
    stubVerifiedAdmin();
    const res = await request(makeApp())
      .patch("/resupply-api/admin/shop/products/prod_x/details")
      .send({ imageUrl: "http://insecure.example.com/x.png" });
    expect(res.status).toBe(400);
    expect(stripeUpdateMock).not.toHaveBeenCalled();
  });

  it("returns 503 in preview mode (no Stripe key)", async () => {
    stubVerifiedAdmin();
    stripeConfigured = false;
    const res = await request(makeApp())
      .patch("/resupply-api/admin/shop/products/prod_x/details")
      .send({ name: "New name" });
    expect(res.status).toBe(503);
    expect(res.body.error).toBe("stripe_not_configured");
  });

  it("refuses products that are not in the shop catalog", async () => {
    stubVerifiedAdmin();
    stripeRetrieveMock.mockResolvedValue({ id: "prod_x", metadata: {} });
    projectProductMock.mockReturnValueOnce(null);
    const res = await request(makeApp())
      .patch("/resupply-api/admin/shop/products/prod_x/details")
      .send({ name: "New name" });
    expect(res.status).toBe(404);
    expect(res.body.error).toBe("product_not_in_catalog");
    expect(stripeUpdateMock).not.toHaveBeenCalled();
  });

  it("updates name/description and writes metadata, clearing nulls", async () => {
    stubVerifiedAdmin();
    stripeRetrieveMock.mockResolvedValue({
      id: "prod_x",
      name: "Old name",
      metadata: { tagline: "Old tagline", manufacturer: "OldCo" },
    });
    stripeUpdateMock.mockResolvedValue({
      id: "prod_x",
      name: "New name",
      metadata: { tagline: "New tagline" },
    });
    const res = await request(makeApp())
      .patch("/resupply-api/admin/shop/products/prod_x/details")
      .send({
        name: "New name",
        description: "Updated description text.",
        tagline: "New tagline",
        manufacturer: null,
      });
    expect(res.status).toBe(200);
    expect(res.body.product.id).toBe("prod_x");
    expect(stripeUpdateMock).toHaveBeenCalledWith(
      "prod_x",
      expect.objectContaining({
        name: "New name",
        description: "Updated description text.",
        metadata: { tagline: "New tagline", manufacturer: "" },
      }),
    );
    // Untouched fields must not appear in the update payload.
    const payload = stripeUpdateMock.mock.calls[0]![1] as Record<
      string,
      unknown
    >;
    expect(payload).not.toHaveProperty("images");
    expect(invalidateCacheMock).toHaveBeenCalled();
  });

  it("replaces the product photo and clears it on null", async () => {
    stubVerifiedAdmin();
    stripeRetrieveMock.mockResolvedValue({
      id: "prod_x",
      name: "SKU",
      metadata: {},
    });
    stripeUpdateMock.mockResolvedValue({
      id: "prod_x",
      name: "SKU",
      metadata: {},
    });
    const set = await request(makeApp())
      .patch("/resupply-api/admin/shop/products/prod_x/details")
      .send({ imageUrl: "https://cdn.example.com/p.webp" });
    expect(set.status).toBe(200);
    expect(stripeUpdateMock).toHaveBeenLastCalledWith(
      "prod_x",
      expect.objectContaining({ images: ["https://cdn.example.com/p.webp"] }),
    );

    const clear = await request(makeApp())
      .patch("/resupply-api/admin/shop/products/prod_x/details")
      .send({ imageUrl: null });
    expect(clear.status).toBe(200);
    expect(stripeUpdateMock).toHaveBeenLastCalledWith(
      "prod_x",
      expect.objectContaining({ images: [] }),
    );
  });
});
