// Tests for POST /admin/shop/catalog/seed — one-click starter catalog.

import { describe, it, expect, vi, beforeEach } from "vitest";
import express, { type Express } from "express";
import request from "supertest";
import type Stripe from "stripe";

import {
  makeRequireAdminMock,
  type MockAdminCtx,
  MOCK_ORG_ID,
} from "../../test-helpers/auth-mocks";

const { mockAdmin, state } = vi.hoisted(() => ({
  mockAdmin: { current: null as MockAdminCtx | null },
  state: {
    stripeConfigured: true,
    // What stripeAccountRequestOptions resolves to (connected vs platform).
    connectedAccount: null as string | null,
    seedOrg: "seed-org-xyz",
    seedResult: { created: 5, updated: 0, pricesCreated: 5, total: 5 },
    seedThrows: false,
    seedCalledWith: undefined as Stripe.RequestOptions | undefined,
    invalidated: false,
    audits: [] as string[],
  },
}));

vi.mock("../../middlewares/requireAdmin", () =>
  makeRequireAdminMock(mockAdmin),
);

vi.mock("../../middlewares/rate-limit", () => ({
  rateLimit:
    () =>
    (
      _req: import("express").Request,
      _res: import("express").Response,
      next: import("express").NextFunction,
    ) =>
      next(),
}));

vi.mock("@workspace/resupply-db", () => ({
  resolveSeedOrgId: async () => state.seedOrg,
}));

vi.mock("@workspace/resupply-audit", () => ({
  logAudit: async (e: { action: string }) => {
    state.audits.push(e.action);
  },
}));

vi.mock("../../lib/stripe/config", () => ({
  SHOP_UNAVAILABLE_BODY: { error: "shop_unavailable" },
  readStripeConfigOrNull: () =>
    state.stripeConfigured ? { secretKey: "sk_test_x" } : null,
  getStripeClient: () => ({}),
}));

vi.mock("../../lib/stripe/connect", () => ({
  stripeAccountRequestOptions: async () =>
    state.connectedAccount ? { stripeAccount: state.connectedAccount } : {},
}));

vi.mock("../../lib/stripe/starter-catalog", () => ({
  seedStarterCatalog: async (
    _stripe: unknown,
    opts?: { requestOptions?: Stripe.RequestOptions },
  ) => {
    state.seedCalledWith = opts?.requestOptions;
    if (state.seedThrows) throw new Error("stripe boom");
    return state.seedResult;
  },
}));

vi.mock("../shop/products", () => ({
  invalidateShopProductsCache: () => {
    state.invalidated = true;
  },
}));

import catalogSeedRouter from "./catalog-seed";

function makeApp(): Express {
  const app = express();
  app.use(express.json());
  app.use(catalogSeedRouter);
  return app;
}

beforeEach(() => {
  mockAdmin.current = {
    email: "owner@acme",
    userId: "u_owner",
    role: "admin",
    granularRole: "admin",
    orgId: MOCK_ORG_ID,
  } as MockAdminCtx;
  state.stripeConfigured = true;
  state.connectedAccount = null;
  state.seedOrg = "seed-org-xyz"; // different from MOCK_ORG_ID by default
  state.seedResult = { created: 5, updated: 0, pricesCreated: 5, total: 5 };
  state.seedThrows = false;
  state.seedCalledWith = undefined;
  state.invalidated = false;
  state.audits = [];
});

describe("POST /admin/shop/catalog/seed", () => {
  it("401s when unauthenticated", async () => {
    mockAdmin.current = null;
    const res = await request(makeApp()).post("/admin/shop/catalog/seed");
    expect(res.status).toBe(401);
  });

  it("503s when Stripe is not configured", async () => {
    state.stripeConfigured = false;
    const res = await request(makeApp()).post("/admin/shop/catalog/seed");
    expect(res.status).toBe(503);
    expect(res.body.error).toBe("shop_unavailable");
  });

  it("409s connect_stripe_first for a non-seed tenant with no connected account", async () => {
    state.connectedAccount = null; // would target the platform account
    state.seedOrg = "a-different-seed-org"; // tenant is NOT the seed org
    const res = await request(makeApp()).post("/admin/shop/catalog/seed");
    expect(res.status).toBe(409);
    expect(res.body.error).toBe("connect_stripe_first");
    expect(state.seedCalledWith).toBeUndefined(); // never seeded
  });

  it("seeds into the connected account and reports counts", async () => {
    state.connectedAccount = "acct_tenant_1";
    const res = await request(makeApp()).post("/admin/shop/catalog/seed");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      created: 5,
      updated: 0,
      pricesCreated: 5,
      total: 5,
    });
    // Seeded against the tenant's connected account, not the platform.
    expect(state.seedCalledWith).toEqual({ stripeAccount: "acct_tenant_1" });
    expect(state.invalidated).toBe(true);
    expect(state.audits).toContain("shop.catalog.seeded");
  });

  it("allows the seed tenant to seed the platform account", async () => {
    state.connectedAccount = null; // platform account
    state.seedOrg = MOCK_ORG_ID; // tenant IS the seed org
    const res = await request(makeApp()).post("/admin/shop/catalog/seed");
    expect(res.status).toBe(200);
    expect(state.seedCalledWith).toEqual({}); // platform account
    expect(state.invalidated).toBe(true);
  });

  it("502s when the seed itself fails", async () => {
    state.connectedAccount = "acct_tenant_1";
    state.seedThrows = true;
    const res = await request(makeApp()).post("/admin/shop/catalog/seed");
    expect(res.status).toBe(502);
    expect(res.body.error).toBe("catalog_seed_failed");
    expect(state.invalidated).toBe(false);
  });
});
