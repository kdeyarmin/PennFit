// Route tests for routes/shop/my-orders.ts.
//
// Coverage:
//   * 401 when the caller has no session
//   * 200 with empty list + null cursor for a signed-in user with no orders
//   * 200 with grouped line items per order when both tables have rows
//   * Items belonging to other orders are not bled into this user's
//     response (the line-item join is keyed on the user's order ids,
//     not on the user's id — so we test that grouping really is
//     per-order)
//   * Pagination cursor is emitted only when the page is full (limit+1
//     trick) — proving the contract callers rely on
//
// We don't test the Stripe product-name lookup itself here; that path
// is covered by the integration-style preview-mode behaviour
// (Stripe-not-configured returns the "Product <id>" fallback shape)
// and by the existing stripe/config tests.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import express, { type Express } from "express";
import request from "supertest";

import { makeRequireSignedInMock } from "../../test-helpers/auth-mocks";

const { mockSignedIn } = vi.hoisted(() => ({
  mockSignedIn: { current: null as string | null },
}));
vi.mock("../../middlewares/requireSignedIn", () =>
  makeRequireSignedInMock(mockSignedIn),
);

// Two-stage select: the route does
//   1. SELECT ... FROM shop_orders WHERE ... ORDER BY ... LIMIT n+1
//   2. SELECT ... FROM shop_order_items WHERE order_id IN (...)
// The POST endpoint adds:
//   3. SELECT ... FROM shop_orders WHERE id = ? LIMIT 1
//   4. UPDATE shop_orders ... WHERE ... RETURNING ...
// We push the result for each call into `selectQueue` / `updateQueue`
// in order. A test that doesn't push for a query gets `[]`.
const selectQueue: unknown[][] = [];
const updateQueue: unknown[][] = [];
const dbStub = {
  select: vi.fn(() => {
    const result = selectQueue.shift() ?? [];
    const obj: Record<string, unknown> = {
      from: () => obj,
      where: () => obj,
      orderBy: () => obj,
      limit: () => Promise.resolve(result),
      // The line-item query has no `.limit()`; awaiting the chain
      // straight after `.where()` should resolve to the next queue
      // entry. We model that via a thenable.
      then: (
        resolve: (v: unknown) => unknown,
        reject: (e: unknown) => unknown,
      ) => Promise.resolve(result).then(resolve, reject),
    };
    return obj;
  }),
  update: vi.fn(() => {
    const result = updateQueue.shift() ?? [];
    const obj: Record<string, unknown> = {
      set: () => obj,
      where: () => obj,
      returning: () => Promise.resolve(result),
    };
    return obj;
  }),
};

vi.mock("drizzle-orm/node-postgres", () => ({
  drizzle: () => dbStub,
}));

vi.mock("@workspace/resupply-db", async () => {
  const actual = await vi.importActual<typeof import("@workspace/resupply-db")>(
    "@workspace/resupply-db",
  );
  return { ...actual, getDbPool: () => ({}) as never };
});

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
  selectQueue.length = 0;
  updateQueue.length = 0;
  mockSignedIn.current = null;
  dbStub.select.mockClear();
  dbStub.update.mockClear();
});

afterEach(() => {
  selectQueue.length = 0;
  updateQueue.length = 0;
});

describe("GET /shop/me/orders", () => {
  it("returns 401 when the caller has no session", async () => {
    const res = await request(makeApp()).get("/resupply-api/shop/me/orders");
    expect(res.status).toBe(401);
  });

  it("returns an empty list with null cursor for a user with no orders", async () => {
    stubSignedIn("user_alice");
    selectQueue.push([]); // shop_orders query → no rows
    const res = await request(makeApp()).get("/resupply-api/shop/me/orders");
    expect(res.status).toBe(200);
    expect(res.body.orders).toEqual([]);
    expect(res.body.nextCursor).toBeNull();
    // No second select should run when the first returns empty.
    expect(dbStub.select).toHaveBeenCalledTimes(1);
  });

  it("groups line items per order and falls back to 'Product <id>' when Stripe is unavailable", async () => {
    stubSignedIn("user_alice");
    const paidAt1 = new Date("2026-04-20T12:00:00Z");
    const paidAt2 = new Date("2026-04-22T12:00:00Z");
    selectQueue.push([
      {
        id: "ord_1",
        stripeSessionId: "cs_1",
        status: "paid",
        amountTotalCents: 4998,
        currency: "usd",
        createdAt: paidAt1,
        paidAt: paidAt1,
      },
      {
        id: "ord_2",
        stripeSessionId: "cs_2",
        status: "paid",
        amountTotalCents: 1999,
        currency: "usd",
        createdAt: paidAt2,
        paidAt: paidAt2,
      },
    ]);
    selectQueue.push([
      {
        orderId: "ord_1",
        productId: "prod_AirFitP10",
        quantity: 2,
        unitAmountCents: 2499,
        currency: "usd",
      },
      {
        orderId: "ord_2",
        productId: "prod_FilterPack",
        quantity: 1,
        unitAmountCents: 1999,
        currency: "usd",
      },
    ]);

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
      const paidAt = new Date(baseDate.getTime() - i * 60_000);
      return {
        id: `ord_${i + 1}`,
        stripeSessionId: `cs_${i + 1}`,
        status: "paid",
        amountTotalCents: 1000,
        currency: "usd",
        createdAt: paidAt,
        paidAt,
      };
    });
    selectQueue.push(orderRows);
    selectQueue.push([]); // No line items needed for the cursor assertion.

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
    const paidAt = new Date("2026-04-20T12:00:00Z");
    const shippedAt = new Date("2026-04-22T15:00:00Z");
    selectQueue.push([
      {
        id: "ord_unshipped",
        stripeSessionId: "cs_a",
        status: "paid",
        amountTotalCents: 1000,
        currency: "usd",
        createdAt: paidAt,
        paidAt,
        shippingAddress: {
          line1: "1 Penn Plz",
          line2: null,
          city: "Philadelphia",
          state: "PA",
          postalCode: "19104",
          country: "US",
        },
        trackingCarrier: null,
        trackingNumber: null,
        shippedAt: null,
        deliveredAt: null,
      },
      {
        id: "ord_shipped",
        stripeSessionId: "cs_b",
        status: "paid",
        amountTotalCents: 2000,
        currency: "usd",
        createdAt: paidAt,
        paidAt,
        shippingAddress: null,
        trackingCarrier: "UPS",
        trackingNumber: "1Z999XYZ",
        shippedAt,
        deliveredAt: null,
      },
    ]);
    selectQueue.push([]); // line items: none needed for projection asserts
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
    expect(shipped.shippedAt).toBe(shippedAt.toISOString());
    expect(shipped.tracking.carrier).toBe("UPS");
    expect(shipped.tracking.number).toBe("1Z999XYZ");
    // Track URL is computed server-side so the UI doesn't have to
    // know carrier-specific URL templates.
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
    expect(dbStub.update).not.toHaveBeenCalled();
  });

  it("rejects non-UUID order ids", async () => {
    stubSignedIn("user_alice");
    const res = await request(makeApp())
      .post("/resupply-api/shop/me/orders/not-a-uuid/shipping-address")
      .send(validAddress);
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_order_id");
    expect(dbStub.select).not.toHaveBeenCalled();
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
    selectQueue.push([]);
    const res = await request(makeApp())
      .post(`/resupply-api/shop/me/orders/${VALID_ID}/shipping-address`)
      .send(validAddress);
    expect(res.status).toBe(404);
    expect(res.body.error).toBe("order_not_found");
    expect(dbStub.update).not.toHaveBeenCalled();
  });

  it("returns 404 (not 403) when the order belongs to another shopper", async () => {
    stubSignedIn("user_alice");
    selectQueue.push([
      {
        id: VALID_ID,
        customerId: "user_bob",
        status: "paid",
        shippedAt: null,
      },
    ]);
    const res = await request(makeApp())
      .post(`/resupply-api/shop/me/orders/${VALID_ID}/shipping-address`)
      .send(validAddress);
    // Privacy: collapsing "exists but not yours" into 404 prevents
    // a brute-force probe from learning which order ids exist.
    expect(res.status).toBe(404);
    expect(res.body.error).toBe("order_not_found");
    expect(dbStub.update).not.toHaveBeenCalled();
  });

  it("returns 409 when the order isn't paid yet", async () => {
    stubSignedIn("user_alice");
    selectQueue.push([
      {
        id: VALID_ID,
        customerId: "user_alice",
        status: "pending",
        shippedAt: null,
      },
    ]);
    const res = await request(makeApp())
      .post(`/resupply-api/shop/me/orders/${VALID_ID}/shipping-address`)
      .send(validAddress);
    expect(res.status).toBe(409);
    expect(res.body.error).toBe("order_not_paid");
    expect(dbStub.update).not.toHaveBeenCalled();
  });

  it("returns 409 once the parcel has shipped", async () => {
    stubSignedIn("user_alice");
    selectQueue.push([
      {
        id: VALID_ID,
        customerId: "user_alice",
        status: "paid",
        shippedAt: new Date("2026-04-25T09:00:00Z"),
      },
    ]);
    const res = await request(makeApp())
      .post(`/resupply-api/shop/me/orders/${VALID_ID}/shipping-address`)
      .send(validAddress);
    expect(res.status).toBe(409);
    expect(res.body.error).toBe("order_already_shipped");
    expect(dbStub.update).not.toHaveBeenCalled();
  });

  it("writes the address (uppercasing state) and returns the projected order", async () => {
    stubSignedIn("user_alice");
    selectQueue.push([
      {
        id: VALID_ID,
        customerId: "user_alice",
        status: "paid",
        shippedAt: null,
      },
    ]);
    updateQueue.push([
      {
        id: VALID_ID,
        shippingAddress: {
          line1: "456 New Address Ln",
          line2: "Suite 9",
          city: "Philadelphia",
          state: "PA",
          postalCode: "19104",
          country: "US",
        },
        shippedAt: null,
      },
    ]);
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
    selectQueue.push([
      {
        id: VALID_ID,
        customerId: "user_alice",
        status: "paid",
        shippedAt: null,
      },
    ]);
    updateQueue.push([]); // Zero rows updated.
    const res = await request(makeApp())
      .post(`/resupply-api/shop/me/orders/${VALID_ID}/shipping-address`)
      .send(validAddress);
    expect(res.status).toBe(409);
    expect(res.body.error).toBe("order_already_shipped");
  });
});
