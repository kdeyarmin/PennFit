// Route tests for /shop/me/dashboard.
//
// Coverage:
//   * 401 without sign-in
//   * Empty digest when no orders
//   * Retired Subscribe & Save / abandoned-cart rows never surface
//   * latestOrder + pendingOrders still read from shop_orders

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

import meDashboardRouter from "./me-dashboard";

const USER_ID = "user_abc";

function makeApp(): Express {
  const app = express();
  app.use(express.json());
  app.use(meDashboardRouter);
  return app;
}

beforeEach(() => {
  mockSignedIn.current = null;
  supabaseMock.reset();
});

function stageEmptyOrders(): void {
  stageSupabaseResponse("shop_orders", "select", { data: null });
  stageSupabaseResponse("shop_orders", "select", { data: null, count: 0 });
}

describe("GET /shop/me/dashboard", () => {
  it("401s without sign-in", async () => {
    const res = await request(makeApp()).get("/shop/me/dashboard");
    expect(res.status).toBe(401);
  });

  it("returns an empty digest when the customer has nothing", async () => {
    mockSignedIn.current = USER_ID;
    stageEmptyOrders();

    const res = await request(makeApp()).get("/shop/me/dashboard");
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      nextShipment: null,
      eligibility: { eligibleNow: [], soonest: null },
      latestOrder: null,
      activeSubscriptions: 0,
      pendingOrders: 0,
      abandonedCart: null,
    });
  });

  it("never surfaces retired Subscribe & Save or abandoned-cart signals", async () => {
    // The handler must not query shop_subscriptions / shop_abandoned_carts
    // at all — staging those tables would hang if they were still read.
    mockSignedIn.current = USER_ID;
    stageEmptyOrders();

    const res = await request(makeApp()).get("/shop/me/dashboard");
    expect(res.status).toBe(200);
    expect(res.body.nextShipment).toBeNull();
    expect(res.body.eligibility).toEqual({ eligibleNow: [], soonest: null });
    expect(res.body.activeSubscriptions).toBe(0);
    expect(res.body.abandonedCart).toBeNull();
  });

  it("returns latestOrder + pendingOrders from historical shop_orders", async () => {
    mockSignedIn.current = USER_ID;
    stageSupabaseResponse("shop_orders", "select", {
      data: {
        id: "ord_1",
        stripe_session_id: "cs_test",
        status: "paid",
        paid_at: "2024-01-10T12:00:00.000Z",
        shipped_at: null,
        delivered_at: null,
        tracking_carrier: null,
        tracking_number: null,
        created_at: "2024-01-10T12:00:00.000Z",
      },
    });
    stageSupabaseResponse("shop_orders", "select", {
      data: null,
      count: 2,
    });

    const res = await request(makeApp()).get("/shop/me/dashboard");
    expect(res.status).toBe(200);
    expect(res.body.latestOrder).toMatchObject({
      id: "ord_1",
      sessionId: "cs_test",
      paidAt: "2024-01-10T12:00:00.000Z",
    });
    expect(res.body.pendingOrders).toBe(2);
    expect(res.body.nextShipment).toBeNull();
  });
});
