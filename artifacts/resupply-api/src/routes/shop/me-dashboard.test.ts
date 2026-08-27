// Route tests for /shop/me/dashboard.
//
// Coverage:
//   * 401 without sign-in
//   * Empty digest when no orders
//   * Retired Subscribe & Save / abandoned-cart rows never surface
//   * latestOrder + pendingOrders from shop_orders (legacy) and
//     fulfillments when email resolves to one patient chart

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

  it("returns latestOrder + pendingOrders from insurance fulfillments", async () => {
    mockSignedIn.current = USER_ID;
    stageSupabaseResponse("shop_orders", "select", { data: null });
    stageSupabaseResponse("shop_orders", "select", { data: null, count: 0 });
    stageSupabaseResponse("shop_customers", "select", {
      data: {
        customer_id: USER_ID,
        email_lower: "patient@example.com",
      },
    });
    stageSupabaseResponse("patients", "select", {
      data: [{ id: "pat_1" }],
    });
    stageSupabaseResponse("fulfillments", "select", {
      data: {
        id: "ful_1",
        status: "queued",
        created_at: "2024-02-01T12:00:00.000Z",
        shipped_at: null,
        delivered_at: null,
        shipment_metadata: { carrier: "UPS", tracking: "1Z999" },
      },
    });
    stageSupabaseResponse("fulfillments", "select", {
      data: null,
      count: 1,
    });
    stageSupabaseResponse("episodes", "select", { data: [] });

    const res = await request(makeApp()).get("/shop/me/dashboard");
    expect(res.status).toBe(200);
    expect(res.body.latestOrder).toMatchObject({
      id: "ful_1",
      paidAt: "2024-02-01T12:00:00.000Z",
      trackingCarrier: "UPS",
      trackingNumber: "1Z999",
    });
    expect(res.body.pendingOrders).toBe(1);
    expect(res.body.nextShipment).toBeNull();
  });

  it("populates nextShipment + eligibility from in-progress episodes", async () => {
    mockSignedIn.current = USER_ID;
    stageSupabaseResponse("shop_orders", "select", { data: null });
    stageSupabaseResponse("shop_orders", "select", { data: null, count: 0 });
    stageSupabaseResponse("shop_customers", "select", {
      data: {
        customer_id: USER_ID,
        email_lower: "patient@example.com",
      },
    });
    stageSupabaseResponse("patients", "select", {
      data: [{ id: "pat_1" }],
    });
    stageSupabaseResponse("fulfillments", "select", { data: null });
    stageSupabaseResponse("fulfillments", "select", { data: null, count: 0 });
    stageSupabaseResponse("episodes", "select", {
      data: [
        {
          id: "ep_due",
          prescription_id: "rx_1",
          due_at: "2020-01-01T00:00:00.000Z",
        },
      ],
    });
    stageSupabaseResponse("prescriptions", "select", {
      data: [{ id: "rx_1", item_sku: "MASK-NASAL-M" }],
    });

    const res = await request(makeApp()).get("/shop/me/dashboard");
    expect(res.status).toBe(200);
    expect(res.body.nextShipment).toMatchObject({
      subscriptionId: "ep_due",
      date: "2020-01-01T00:00:00.000Z",
      daysUntil: 0,
      firstItemName: "MASK-NASAL-M",
      cancelAtPeriodEnd: false,
    });
    expect(res.body.eligibility.eligibleNow).toEqual([
      { subscriptionId: "ep_due", firstItemName: "MASK-NASAL-M" },
    ]);
    expect(res.body.activeSubscriptions).toBe(0);
  });
});
