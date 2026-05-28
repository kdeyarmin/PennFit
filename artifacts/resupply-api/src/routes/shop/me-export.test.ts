// Route tests for GET /shop/me/export.
//
// Coverage:
//   * 401 without sign-in
//   * Sends Content-Disposition attachment with .json filename
//   * Aggregates seven concurrent reads (customer, orders, items, subs, returns, reviews, carts)
//   * Joins line items onto their order rows by order_id
//   * Sets correct Content-Type
//   * Includes the "phi: separate system" disclaimer in notes

import { describe, it, expect, vi, beforeEach } from "vitest";
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

import exportRouter from "./me-export";

function makeApp(): Express {
  const app = express();
  app.use(express.json());
  app.use(exportRouter);
  return app;
}

function stageAllEmpty(): void {
  stageSupabaseResponse("shop_customers", "select", { data: [] });
  stageSupabaseResponse("shop_orders", "select", { data: [] });
  stageSupabaseResponse("shop_order_items", "select", { data: [] });
  stageSupabaseResponse("shop_subscriptions", "select", { data: [] });
  stageSupabaseResponse("shop_returns", "select", { data: [] });
  stageSupabaseResponse("shop_reviews", "select", { data: [] });
  stageSupabaseResponse("shop_abandoned_carts", "select", { data: [] });
}

beforeEach(() => {
  mockSignedIn.current = null;
  supabaseMock.reset();
});

describe("GET /shop/me/export", () => {
  it("401s without sign-in", async () => {
    const res = await request(makeApp()).get("/shop/me/export");
    expect(res.status).toBe(401);
  });

  it("sends a JSON attachment with the right Content-Disposition", async () => {
    mockSignedIn.current = "cust_abcdef12";
    stageAllEmpty();
    const res = await request(makeApp()).get("/shop/me/export");
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toContain("application/json");
    expect(res.headers["content-disposition"]).toContain("attachment");
    expect(res.headers["content-disposition"]).toContain(".json");
    expect(res.headers["content-disposition"]).toContain("abcdef12");
  });

  it("includes the phi disclaimer when the patient has no shop data", async () => {
    mockSignedIn.current = "cust_1";
    stageAllEmpty();
    const res = await request(makeApp()).get("/shop/me/export");
    const body = JSON.parse(res.text);
    expect(body.notes.phi).toContain("separate system");
    expect(body.profile).toBeNull();
    expect(body.orders).toEqual([]);
  });

  it("joins line items onto their parent orders", async () => {
    mockSignedIn.current = "cust_1";
    stageSupabaseResponse("shop_customers", "select", {
      data: [{ customer_id: "cust_1", email_lower: "a@a.test" }],
    });
    stageSupabaseResponse("shop_orders", "select", {
      data: [
        {
          id: "ord_1",
          status: "paid",
          stripe_session_id: "cs_1",
          amount_total_cents: 5000,
        },
        {
          id: "ord_2",
          status: "paid",
          stripe_session_id: "cs_2",
          amount_total_cents: 3000,
        },
      ],
    });
    stageSupabaseResponse("shop_order_items", "select", {
      data: [
        { id: "li_1", order_id: "ord_1", product_id: "prod_a", quantity: 2 },
        { id: "li_2", order_id: "ord_1", product_id: "prod_b", quantity: 1 },
        { id: "li_3", order_id: "ord_2", product_id: "prod_c", quantity: 1 },
      ],
    });
    stageSupabaseResponse("shop_subscriptions", "select", { data: [] });
    stageSupabaseResponse("shop_returns", "select", { data: [] });
    stageSupabaseResponse("shop_reviews", "select", { data: [] });
    stageSupabaseResponse("shop_abandoned_carts", "select", { data: [] });

    const res = await request(makeApp()).get("/shop/me/export");
    expect(res.status).toBe(200);
    const body = JSON.parse(res.text);
    expect(body.orders).toHaveLength(2);
    const ord1 = body.orders.find((o: { id: string }) => o.id === "ord_1");
    expect(ord1.items).toHaveLength(2);
    const ord2 = body.orders.find((o: { id: string }) => o.id === "ord_2");
    expect(ord2.items).toHaveLength(1);
  });
});
