// Route tests for POST /shop/me/orders/:orderId/loss-claim.
//
// Coverage:
//   * 401 without sign-in
//   * 404 when orderId param fails uuid parse
//   * 400 when body is malformed (note > 2000)
//   * 404 when order not found (covers the IDOR case too — ownership
//     is now part of the WHERE clause via customer_id, so a foreign
//     order reads back as no rows)
//   * 409 when order has not yet shipped
//   * 409 when an open claim already exists for the order
//   * 201 happy path inserts open loss-claim and returns the new id

import { describe, it, expect, vi, beforeEach } from "vitest";
import express, { type Express } from "express";
import request from "supertest";

import {
  makeRequireSignedInMock,
  type MockSignedInProfile,
} from "../../test-helpers/auth-mocks";
import {
  getSupabaseFilterCalls,
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

  it("404s when the order is not found (or owned by someone else — the customer_id filter is in the WHERE clause)", async () => {
    mockSignedIn.current = { customerId: "cust_1", email: "a@a.test" };
    stageSupabaseResponse("shop_orders", "select", { data: null });
    const res = await request(makeApp())
      .post(`/shop/me/orders/${ORDER_ID}/loss-claim`)
      .send({});
    expect(res.status).toBe(404);
  });

  it("filters the order lookup by the session's customer_id (IDOR guard)", async () => {
    mockSignedIn.current = { customerId: "cust_1", email: "a@a.test" };
    stageSupabaseResponse("shop_orders", "select", { data: null });
    await request(makeApp())
      .post(`/shop/me/orders/${ORDER_ID}/loss-claim`)
      .send({});
    const idFilters = getSupabaseFilterCalls("shop_orders", "select").filter(
      (f) => f.verb === "eq" && f.args[0] === "customer_id",
    );
    expect(idFilters).toHaveLength(1);
    expect(idFilters[0]?.args[1]).toBe("cust_1");
  });

  it("409s when order has not yet been marked shipped", async () => {
    mockSignedIn.current = { customerId: "cust_1", email: "a@a.test" };
    stageSupabaseResponse("shop_orders", "select", {
      data: {
        id: ORDER_ID,
        customer_id: "cust_1",
        shipped_at: null,
      },
    });
    const res = await request(makeApp())
      .post(`/shop/me/orders/${ORDER_ID}/loss-claim`)
      .send({});
    expect(res.status).toBe(409);
    expect(res.body.error).toBe("not_yet_shipped");
  });

  it("409s when an open claim already exists for the order", async () => {
    mockSignedIn.current = { customerId: "cust_1", email: "a@a.test" };
    stageSupabaseResponse("shop_orders", "select", {
      data: {
        id: ORDER_ID,
        customer_id: "cust_1",
        shipped_at: "2026-01-01T00:00:00.000Z",
      },
    });
    stageSupabaseResponse("shop_order_loss_claims", "select", {
      data: { id: "claim_existing" },
    });
    const res = await request(makeApp())
      .post(`/shop/me/orders/${ORDER_ID}/loss-claim`)
      .send({});
    expect(res.status).toBe(409);
    expect(res.body.error).toBe("claim_already_open");
    expect(res.body.id).toBe("claim_existing");
  });

  it("201s and returns id on happy path", async () => {
    mockSignedIn.current = { customerId: "cust_1", email: "a@a.test" };
    stageSupabaseResponse("shop_orders", "select", {
      data: {
        id: ORDER_ID,
        customer_id: "cust_1",
        shipped_at: "2026-01-01T00:00:00.000Z",
      },
    });
    // No open claim yet.
    stageSupabaseResponse("shop_order_loss_claims", "select", { data: null });
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
