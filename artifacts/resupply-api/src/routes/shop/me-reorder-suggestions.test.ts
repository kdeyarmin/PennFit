// Route tests for GET /shop/me/reorder-suggestions.
//
// Coverage:
//   * 401 without sign-in
//   * Empty suggestions when customer has no order items
//   * Returns previewMode flag when STRIPE_SECRET_KEY is unset
//   * Filters out unpaid orders (uses paidOrderIds set)
//
// We don't exercise the Stripe products.retrieve path — that requires
// a live Stripe client. The non-stripe branches cover the auth + DB
// shape contract that's most likely to regress.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import express, { type Express } from "express";
import request from "supertest";

import { makeRequireSignedInMock } from "../../test-helpers/auth-mocks";
import {
  installSupabaseMock,
  stageSupabaseResponse,
} from "../../test-helpers/supabase-mock";

const supabaseMock = installSupabaseMock();

const { mockSignedIn } = vi.hoisted(() => ({
  mockSignedIn: { current: null as string | null },
}));
vi.mock("../../middlewares/requireSignedIn", () =>
  makeRequireSignedInMock(mockSignedIn),
);

import reorderRouter from "./me-reorder-suggestions";

function makeApp(): Express {
  const app = express();
  app.use(express.json());
  app.use(reorderRouter);
  return app;
}

const originalStripeKey = process.env.STRIPE_SECRET_KEY;

beforeEach(() => {
  mockSignedIn.current = null;
  supabaseMock.reset();
  delete process.env.STRIPE_SECRET_KEY;
});

afterEach(() => {
  if (originalStripeKey !== undefined) {
    process.env.STRIPE_SECRET_KEY = originalStripeKey;
  }
});

describe("GET /shop/me/reorder-suggestions", () => {
  it("401s without sign-in", async () => {
    const res = await request(makeApp()).get("/shop/me/reorder-suggestions");
    expect(res.status).toBe(401);
  });

  it("returns empty suggestions when no order items exist", async () => {
    mockSignedIn.current = "cust_1";
    stageSupabaseResponse("shop_order_items", "select", { data: [] });
    const res = await request(makeApp()).get("/shop/me/reorder-suggestions");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ suggestions: [] });
  });

  it("returns previewMode when STRIPE_SECRET_KEY is unset (but items exist)", async () => {
    mockSignedIn.current = "cust_1";
    stageSupabaseResponse("shop_order_items", "select", {
      data: [
        {
          order_id: "ord_1",
          product_id: "prod_1",
          paid_at: new Date().toISOString(),
          quantity: 1,
        },
      ],
    });
    stageSupabaseResponse("shop_orders", "select", {
      data: [{ id: "ord_1", status: "paid" }],
    });
    const res = await request(makeApp()).get("/shop/me/reorder-suggestions");
    expect(res.status).toBe(200);
    expect(res.body.suggestions).toEqual([]);
    expect(res.body.previewMode).toBe(true);
  });

  it("filters out unpaid orders (skips them via paidOrderIds)", async () => {
    mockSignedIn.current = "cust_1";
    stageSupabaseResponse("shop_order_items", "select", {
      data: [
        {
          order_id: "ord_unpaid",
          product_id: "prod_1",
          paid_at: new Date().toISOString(),
          quantity: 1,
        },
      ],
    });
    stageSupabaseResponse("shop_orders", "select", {
      data: [{ id: "ord_unpaid", status: "pending" }],
    });
    const res = await request(makeApp()).get("/shop/me/reorder-suggestions");
    expect(res.status).toBe(200);
    expect(res.body.suggestions).toEqual([]);
  });
});
