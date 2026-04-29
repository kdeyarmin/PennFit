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

const getAuthMock = vi.fn();
const getUserMock = vi.fn();
vi.mock("@clerk/express", () => ({
  getAuth: (...a: unknown[]) => getAuthMock(...a),
  clerkClient: {
    users: { getUser: (...a: unknown[]) => getUserMock(...a) },
  },
}));

// Stripe SDK stub — `retrieve` is the catalog-membership precheck;
// `update` is the actual stock_count write. Both go through
// projectProduct (mocked below) so the handler reaches the 200
// branch without us shipping a full Stripe fixture.
const stripeRetrieveMock = vi.fn();
const stripeUpdateMock = vi.fn();
vi.mock("../../lib/stripe/config", () => ({
  readStripeConfigOrNull: () => readStripeConfig(),
  getStripeClient: () => ({
    products: {
      retrieve: (...a: unknown[]) => stripeRetrieveMock(...a),
      update: (...a: unknown[]) => stripeUpdateMock(...a),
    },
  }),
}));

let stripeConfigured = true;
function readStripeConfig(): { secretKey: string } | null {
  return stripeConfigured ? { secretKey: "sk_test_x" } : null;
}

// projectProduct stub — vi.fn() so individual tests can override
// the result (e.g. return null to simulate a non-catalog product
// that the catalog-membership guard must reject).
const projectProductMock = vi.fn();
vi.mock("../../lib/stripe/products-meta", () => ({
  projectProduct: (
    raw: { id: string; name?: string; metadata?: Record<string, string> },
  ) => projectProductMock(raw),
  // Re-export the type as a no-op so the route's type imports
  // continue to resolve.
  SHOP_CATEGORIES: [],
}));

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
}): {
  id: string;
  name: string;
  category: string;
  price: { unitAmount: number; currency: string };
  stockCount: number | null;
} {
  return {
    id: raw.id,
    name: raw.name ?? "Test SKU",
    category: "accessories",
    // Mirror the real ShopProductView field name (unitAmount, not
    // amount) so a future contract drift breaks this test.
    price: { unitAmount: 1999, currency: "usd" },
    stockCount: raw.metadata?.stock_count
      ? parseInt(raw.metadata.stock_count, 10)
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
  getAuthMock.mockReturnValue({ userId: "user_admin" });
  getUserMock.mockResolvedValue({
    primaryEmailAddressId: "eml_1",
    emailAddresses: [
      {
        id: "eml_1",
        emailAddress: ALLOWED_EMAIL,
        verification: { status: "verified" },
      },
    ],
  });
}

const ENV_KEYS = ["RESUPPLY_ADMIN_EMAILS", "NODE_ENV"] as const;
type EnvKey = (typeof ENV_KEYS)[number];
const originalEnv: Partial<Record<EnvKey, string | undefined>> = {};

beforeEach(() => {
  for (const k of ENV_KEYS) originalEnv[k] = process.env[k];
  for (const k of ENV_KEYS) delete process.env[k];
  process.env.NODE_ENV = "test";
  process.env.RESUPPLY_ADMIN_EMAILS = ALLOWED_EMAIL;
  stripeConfigured = true;
  stripeRetrieveMock.mockReset();
  stripeUpdateMock.mockReset();
  projectProductMock.mockReset();
  // Default: every product projects successfully (i.e. is in the
  // catalog). Tests that need to simulate a non-catalog product
  // override this with mockReturnValueOnce(null).
  projectProductMock.mockImplementation(defaultProjection);
  getAuthMock.mockReset();
  getUserMock.mockReset();
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (originalEnv[k] === undefined) delete process.env[k];
    else process.env[k] = originalEnv[k];
  }
});

describe("PATCH /admin/shop/products/:productId/stock", () => {
  it("rejects callers without admin sign-in", async () => {
    getAuthMock.mockReturnValue({ userId: null });
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
    expect((payload as { metadata: Record<string, string> }).metadata.stock_count).toBe("7");
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
    expect((payload as { metadata: Record<string, string> }).metadata.stock_count).toBe("");
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
