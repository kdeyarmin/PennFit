// Route tests for POST /shop/me/orders/:orderId/loss-claim.
//
// Coverage:
//   * 401 without sign-in
//   * 404 when orderId param fails uuid parse
//   * 400 when body is malformed (note > 2000)
//   * 401 when shopCustomerEmail missing
//   * 404 when order not found
//   * 404 (IDOR guard) when order belongs to a different customer email
//   * 409 when order has not yet shipped
//   * 201 happy path inserts open loss-claim and returns the new id

import { describe, it, expect, vi, beforeEach } from "vitest";
import express, { type Express } from "express";
import request from "supertest";

import {
  makeRequireSignedInMock,
  type MockSignedInProfile,
} from "../../test-helpers/auth-mocks";
import {
  installSupabaseMock,
  stageSupabaseResponse,
} from "../../test-helpers/supabase-mock";

const supabaseMock = installSupabaseMock();

const { mockSignedIn } = vi.hoisted(() => ({
  mockSignedIn: {
    current: null as null | string | MockSignedInProfile,
  },
}));
vi.mock("../../middlewares/requireSignedIn", () =>
  makeRequireSignedInMock(mockSignedIn),
);

import lossClaimRouter from "./me-loss-claim";

const ORDER_ID = "11111111-1111-4111-8111-111111111111";

function makeApp(): Express {
  const app = express();
  app.use(express.json());
  app.use(lossClaimRouter);
  return app;
}

beforeEach(() => {
  mockSignedIn.current = null;
  supabaseMock.reset();
});

describe("POST /shop/me/orders/:orderId/loss-claim", () => {
  it("401s without sign-in", async () => {
    const res = await request(makeApp())
      .post(`/shop/me/orders/${ORDER_ID}/loss-claim`)
      .send({});
    expect(res.status).toBe(401);
  });

  it("404s on malformed orderId", async () => {
    mockSignedIn.current = { customerId: "cust_1", email: "a@a.test" };
    const res = await request(makeApp())
      .post("/shop/me/orders/not-a-uuid/loss-claim")
      .send({});
    expect(res.status).toBe(404);
  });

  it("400s when note is too long", async () => {
    mockSignedIn.current = { customerId: "cust_1", email: "a@a.test" };
    const res = await request(makeApp())
      .post(`/shop/me/orders/${ORDER_ID}/loss-claim`)
      .send({ note: "x".repeat(2001) });
    expect(res.status).toBe(400);
  });

  it("401s when shopCustomerEmail is missing on the session", async () => {
    mockSignedIn.current = { customerId: "cust_1", email: null };
    const res = await request(makeApp())
      .post(`/shop/me/orders/${ORDER_ID}/loss-claim`)
      .send({});
    expect(res.status).toBe(401);
  });

  it("404s when the order is not found", async () => {
    mockSignedIn.current = { customerId: "cust_1", email: "a@a.test" };
    stageSupabaseResponse("shop_orders", "select", { data: null });
    const res = await request(makeApp())
      .post(`/shop/me/orders/${ORDER_ID}/loss-claim`)
      .send({});
    expect(res.status).toBe(404);
  });

  it("404s (IDOR) when the order belongs to a different customer email", async () => {
    mockSignedIn.current = { customerId: "cust_1", email: "alice@a.test" };
    stageSupabaseResponse("shop_orders", "select", {
      data: {
        id: ORDER_ID,
        customer_email: "bob@b.test",
        shipped_at: "2026-01-01T00:00:00.000Z",
      },
    });
    const res = await request(makeApp())
      .post(`/shop/me/orders/${ORDER_ID}/loss-claim`)
      .send({});
    expect(res.status).toBe(404);
  });

  it("409s when order has not yet been marked shipped", async () => {
    mockSignedIn.current = { customerId: "cust_1", email: "a@a.test" };
    stageSupabaseResponse("shop_orders", "select", {
      data: {
        id: ORDER_ID,
        customer_email: "a@a.test",
        shipped_at: null,
      },
    });
    const res = await request(makeApp())
      .post(`/shop/me/orders/${ORDER_ID}/loss-claim`)
      .send({});
    expect(res.status).toBe(409);
    expect(res.body.error).toBe("not_yet_shipped");
  });

  it("201s and returns id on happy path", async () => {
    mockSignedIn.current = { customerId: "cust_1", email: "a@a.test" };
    stageSupabaseResponse("shop_orders", "select", {
      data: {
        id: ORDER_ID,
        customer_email: "A@a.test", // case-insensitive match
        shipped_at: "2026-01-01T00:00:00.000Z",
      },
    });
    stageSupabaseResponse("shop_order_loss_claims", "insert", {
      data: { id: "claim_1" },
    });
    const res = await request(makeApp())
      .post(`/shop/me/orders/${ORDER_ID}/loss-claim`)
      .send({ note: "Tracking shows delivered but I never got it." });
    expect(res.status).toBe(201);
    expect(res.body).toEqual({ id: "claim_1" });
  });
});
