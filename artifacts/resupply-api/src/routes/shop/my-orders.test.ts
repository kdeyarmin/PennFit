// Route tests for routes/shop/my-orders.ts.
//
// Coverage:
//   * 401 when the caller has no session
//   * 200 with empty list + null cursor for a signed-in user with no orders
//   * 200 with grouped line items per order when both tables have rows
//   * Items belonging to other orders are not bled into this user's
//     response
//   * Pagination cursor is emitted only when the page is full

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import express, { type Express } from "express";
import request from "supertest";

import { makeRequireSignedInMock } from "../../test-helpers/auth-mocks";
import {
  installSupabaseMock,
  stageSupabaseResponse,
  getSupabaseCallCount,
} from "../../test-helpers/supabase-mock";

const supabaseMock = installSupabaseMock();

const { mockSignedIn } = vi.hoisted(() => ({
  mockSignedIn: { current: null as string | null },
}));
vi.mock("../../middlewares/requireSignedIn", () =>
  makeRequireSignedInMock(mockSignedIn),
);

// Force preview-mode for the Stripe name lookup so the test never
// reaches a real Stripe SDK call. The handler degrades gracefully
// to "Product <id>" in this branch.
vi.mock("../../lib/stripe/config", () => ({
  readStripeConfigOrNull: () => null,
  getStripeClient: () => {
    throw new Error("getStripeClient should not be called when config is null");
  },
}));

import myOrdersRouter from "./my-orders";

function makeApp(): Express {
  const app = express();
  app.use(express.json());
  app.use("/resupply-api", myOrdersRouter);
  return app;
}

function stubSignedIn(userId: string): void {
  mockSignedIn.current = userId;
}

beforeEach(() => {
  mockSignedIn.current = null;
  supabaseMock.reset();
});

afterEach(() => {
  supabaseMock.reset();
});

describe("GET /shop/me/orders", () => {
  it("returns 401 when the caller has no session", async () => {
    const res = await request(makeApp()).get("/resupply-api/shop/me/orders");
    expect(res.status).toBe(401);
  });

  it("returns an empty list with null cursor for a user with no orders", async () => {
    stubSignedIn("user_alice");
    stageSupabaseResponse("shop_orders", "select", { data: [] });
    const res = await request(makeApp()).get("/resupply-api/shop/me/orders");
    expect(res.status).toBe(200);
    expect(res.body.orders).toEqual([]);
    expect(res.body.nextCursor).toBeNull();
    // No second SELECT runs when the first returns empty.
    expect(getSupabaseCallCount("shop_order_items", "select")).toBe(0);
  });

  it("groups line items per order and falls back to 'Product <id>' when Stripe is unavailable", async () => {
    stubSignedIn("user_alice");
    const paidAt1Iso = new Date("2026-04-20T12:00:00Z").toISOString();
    const paidAt2Iso = new Date("2026-04-22T12:00:00Z").toISOString();
    stageSupabaseResponse("shop_orders", "select", {
      data: [
        {
          id: "ord_1",
          stripe_session_id: "cs_1",
          status: "paid",
          amount_total_cents: 4998,
          currency: "usd",
          created_at: paidAt1Iso,
          paid_at: paidAt1Iso,
          shipping_address_json: null,
          tracking_carrier: null,
          tracking_number: null,
          shipped_at: null,
          delivered_at: null,
        },
        {
          id: "ord_2",
          stripe_session_id: "cs_2",
          status: "paid",
          amount_total_cents: 1999,
          currency: "usd",
          created_at: paidAt2Iso,
          paid_at: paidAt2Iso,
          shipping_address_json: null,
          tracking_carrier: null,
          tracking_number: null,
          shipped_at: null,
          delivered_at: null,
        },
      ],
    });
    stageSupabaseResponse("shop_order_items", "select", {
      data: [
        {
          order_id: "ord_1",
          product_id: "prod_AirFitP10",
          quantity: 2,
          unit_amount_cents: 2499,
          currency: "usd",
        },
        {
          order_id: "ord_2",
          product_id: "prod_FilterPack",
          quantity: 1,
          unit_amount_cents: 1999,
          currency: "usd",
        },
      ],
    });

    const res = await request(makeApp()).get("/resupply-api/shop/me/orders");
    expect(res.status).toBe(200);
    expect(res.body.orders).toHaveLength(2);

    const ord1 = res.body.orders.find((o: { id: string }) => o.id === "ord_1")!;
    const ord2 = res.body.orders.find((o: { id: string }) => o.id === "ord_2")!;

    expect(ord1.items).toHaveLength(1);
    expect(ord1.items[0].productId).toBe("prod_AirFitP10");
    expect(ord1.items[0].quantity).toBe(2);
    // Stripe-unavailable fallback: name is "Product <first 12 chars of id>".
    expect(ord1.items[0].productName).toMatch(/^Product /);

    expect(ord2.items).toHaveLength(1);
    expect(ord2.items[0].productId).toBe("prod_FilterPack");

    // Single page → no next cursor.
    expect(res.body.nextCursor).toBeNull();
  });

  it("emits a next cursor only when the page is full (limit+1 marker)", async () => {
    stubSignedIn("user_alice");
    // Default limit is 20; push 21 rows to trigger pagination.
    const baseDate = new Date("2026-04-29T00:00:00Z");
    const orderRows = Array.from({ length: 21 }, (_, i) => {
      const paidAtIso = new Date(baseDate.getTime() - i * 60_000).toISOString();
      return {
        id: `ord_${i + 1}`,
        stripe_session_id: `cs_${i + 1}`,
        status: "paid",
        amount_total_cents: 1000,
        currency: "usd",
        created_at: paidAtIso,
        paid_at: paidAtIso,
        shipping_address_json: null,
        tracking_carrier: null,
        tracking_number: null,
        shipped_at: null,
        delivered_at: null,
      };
    });
    stageSupabaseResponse("shop_orders", "select", { data: orderRows });
    stageSupabaseResponse("shop_order_items", "select", { data: [] });

    const res = await request(makeApp()).get("/resupply-api/shop/me/orders");
    expect(res.status).toBe(200);
    // The page is trimmed to `limit` items even though the SELECT pulled
    // limit+1 — the +1 only exists so we know there's more.
    expect(res.body.orders).toHaveLength(20);
    expect(res.body.nextCursor).toBeTruthy();
    expect(typeof res.body.nextCursor).toBe("string");
  });

  it("projects tracking + shipping_address + canEditAddress on each order", async () => {
    stubSignedIn("user_alice");
    const paidAtIso = new Date("2026-04-20T12:00:00Z").toISOString();
    const shippedAtIso = new Date("2026-04-22T15:00:00Z").toISOString();
    stageSupabaseResponse("shop_orders", "select", {
      data: [
        {
          id: "ord_unshipped",
          stripe_session_id: "cs_a",
          status: "paid",
          amount_total_cents: 1000,
          currency: "usd",
          created_at: paidAtIso,
          paid_at: paidAtIso,
          shipping_address_json: {
            line1: "1 Penn Plz",
            line2: null,
            city: "Philadelphia",
            state: "PA",
            postalCode: "19104",
            country: "US",
          },
          tracking_carrier: null,
          tracking_number: null,
          shipped_at: null,
          delivered_at: null,
        },
        {
          id: "ord_shipped",
          stripe_session_id: "cs_b",
          status: "paid",
          amount_total_cents: 2000,
          currency: "usd",
          created_at: paidAtIso,
          paid_at: paidAtIso,
          shipping_address_json: null,
          tracking_carrier: "UPS",
          tracking_number: "1Z999XYZ",
          shipped_at: shippedAtIso,
          delivered_at: null,
        },
      ],
    });
    stageSupabaseResponse("shop_order_items", "select", { data: [] });
    const res = await request(makeApp()).get("/resupply-api/shop/me/orders");
    expect(res.status).toBe(200);

    const unshipped = res.body.orders.find(
      (o: { id: string }) => o.id === "ord_unshipped",
    )!;
    expect(unshipped.canEditAddress).toBe(true);
    expect(unshipped.shippedAt).toBeNull();
    expect(unshipped.tracking).toBeNull();
    expect(unshipped.shippingAddress.city).toBe("Philadelphia");

    const shipped = res.body.orders.find(
      (o: { id: string }) => o.id === "ord_shipped",
    )!;
    expect(shipped.canEditAddress).toBe(false);
    expect(shipped.shippedAt).toBe(shippedAtIso);
    expect(shipped.tracking.carrier).toBe("UPS");
    expect(shipped.tracking.number).toBe("1Z999XYZ");
    expect(shipped.tracking.url).toContain("1Z999XYZ");
    expect(shipped.tracking.url).toContain("ups.com");
  });
});

// =====================================================================
// POST /shop/me/orders/:orderId/shipping-address
// =====================================================================
const VALID_ID = "11111111-2222-3333-4444-555555555555";
const validAddress = {
  line1: "456 New Address Ln",
  line2: "Suite 9",
  city: "Philadelphia",
  state: "pa",
  postalCode: "19104",
  country: "US",
};

describe("POST /shop/me/orders/:orderId/shipping-address", () => {
  it("returns 401 when the caller has no session", async () => {
    const res = await request(makeApp())
      .post(`/resupply-api/shop/me/orders/${VALID_ID}/shipping-address`)
      .send(validAddress);
    expect(res.status).toBe(401);
    expect(getSupabaseCallCount("shop_orders", "update")).toBe(0);
  });

  it("rejects non-UUID order ids", async () => {
    stubSignedIn("user_alice");
    const res = await request(makeApp())
      .post("/resupply-api/shop/me/orders/not-a-uuid/shipping-address")
      .send(validAddress);
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_order_id");
    expect(getSupabaseCallCount("shop_orders", "select")).toBe(0);
  });

  it("rejects bodies missing required fields", async () => {
    stubSignedIn("user_alice");
    const res = await request(makeApp())
      .post(`/resupply-api/shop/me/orders/${VALID_ID}/shipping-address`)
      .send({ line1: "1 Main", city: "Philly" });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_body");
  });

  it("returns 404 when no row matches the id", async () => {
    stubSignedIn("user_alice");
    stageSupabaseResponse("shop_orders", "select", { data: null });
    const res = await request(makeApp())
      .post(`/resupply-api/shop/me/orders/${VALID_ID}/shipping-address`)
      .send(validAddress);
    expect(res.status).toBe(404);
    expect(res.body.error).toBe("order_not_found");
    expect(getSupabaseCallCount("shop_orders", "update")).toBe(0);
  });

  it("returns 404 (not 403) when the order belongs to another shopper", async () => {
    stubSignedIn("user_alice");
    stageSupabaseResponse("shop_orders", "select", {
      data: {
        id: VALID_ID,
        customer_id: "user_bob",
        status: "paid",
        shipped_at: null,
      },
    });
    const res = await request(makeApp())
      .post(`/resupply-api/shop/me/orders/${VALID_ID}/shipping-address`)
      .send(validAddress);
    // Privacy: collapsing "exists but not yours" into 404 prevents
    // a brute-force probe from learning which order ids exist.
    expect(res.status).toBe(404);
    expect(res.body.error).toBe("order_not_found");
    expect(getSupabaseCallCount("shop_orders", "update")).toBe(0);
  });

  it("returns 409 when the order isn't paid yet", async () => {
    stubSignedIn("user_alice");
    stageSupabaseResponse("shop_orders", "select", {
      data: {
        id: VALID_ID,
        customer_id: "user_alice",
        status: "pending",
        shipped_at: null,
      },
    });
    const res = await request(makeApp())
      .post(`/resupply-api/shop/me/orders/${VALID_ID}/shipping-address`)
      .send(validAddress);
    expect(res.status).toBe(409);
    expect(res.body.error).toBe("order_not_paid");
    expect(getSupabaseCallCount("shop_orders", "update")).toBe(0);
  });

  it("returns 409 once the parcel has shipped", async () => {
    stubSignedIn("user_alice");
    stageSupabaseResponse("shop_orders", "select", {
      data: {
        id: VALID_ID,
        customer_id: "user_alice",
        status: "paid",
        shipped_at: new Date("2026-04-25T09:00:00Z").toISOString(),
      },
    });
    const res = await request(makeApp())
      .post(`/resupply-api/shop/me/orders/${VALID_ID}/shipping-address`)
      .send(validAddress);
    expect(res.status).toBe(409);
    expect(res.body.error).toBe("order_already_shipped");
    expect(getSupabaseCallCount("shop_orders", "update")).toBe(0);
  });

  it("writes the address (uppercasing state) and returns the projected order", async () => {
    stubSignedIn("user_alice");
    stageSupabaseResponse("shop_orders", "select", {
      data: {
        id: VALID_ID,
        customer_id: "user_alice",
        status: "paid",
        shipped_at: null,
      },
    });
    stageSupabaseResponse("shop_orders", "update", {
      data: {
        id: VALID_ID,
        shipping_address_json: {
          line1: "456 New Address Ln",
          line2: "Suite 9",
          city: "Philadelphia",
          state: "PA",
          postalCode: "19104",
          country: "US",
        },
        shipped_at: null,
      },
    });
    const res = await request(makeApp())
      .post(`/resupply-api/shop/me/orders/${VALID_ID}/shipping-address`)
      .send(validAddress);
    expect(res.status).toBe(200);
    expect(res.body.order.shippingAddress.state).toBe("PA");
    expect(res.body.order.shippingAddress.line1).toBe("456 New Address Ln");
    expect(res.body.order.canEditAddress).toBe(true);
  });

  it("returns 409 on the SELECT-OK / UPDATE-zero-rows race", async () => {
    // Pre-check sees shipped_at IS NULL but the optimistic UPDATE
    // matches zero rows because the admin entered tracking in
    // between. The handler must surface this as 409, not 500.
    stubSignedIn("user_alice");
    stageSupabaseResponse("shop_orders", "select", {
      data: {
        id: VALID_ID,
        customer_id: "user_alice",
        status: "paid",
        shipped_at: null,
      },
    });
    // maybeSingle on zero rows resolves to null.
    stageSupabaseResponse("shop_orders", "update", { data: null });
    const res = await request(makeApp())
      .post(`/resupply-api/shop/me/orders/${VALID_ID}/shipping-address`)
      .send(validAddress);
    expect(res.status).toBe(409);
    expect(res.body.error).toBe("order_already_shipped");
  });
});
