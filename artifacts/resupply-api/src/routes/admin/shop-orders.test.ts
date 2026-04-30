// Route tests for routes/admin/shop-orders.ts. Mirrors the
// fluent-stub pattern in shop-products.test.ts + my-orders.test.ts.
//
// Coverage matrix:
//   POST /tracking   — admin gate, id format, body validation,
//                      not-found, status guard, happy-path UPDATE,
//                      overwrite re-stamps shipped_at.
//   POST /delivered  — admin gate, id, not-found, not-shipped guard,
//                      happy-path UPDATE, idempotent re-fire.
//   PATCH /shipping-address — admin gate, id, body, not-found,
//                              happy-path UPDATE allowed post-ship.
//   POST /refund     — admin gate, id, not-found, status guards,
//                      missing payment_intent, amount cap,
//                      stripe-not-configured (503), stripe-error (502),
//                      happy-path Stripe refunds.create.
//
// Mocking strategy:
//   * `getDbPool` returns an empty object; the real Drizzle import is
//     replaced by a fluent stub that pulls the next pre-queued result
//     off `selectQueue` / `updateQueue`. Each test pushes the rows
//     it expects each query to see, in order.
//   * Stripe is mocked at the lib/stripe/config layer; only refunds
//     are exercised here.
//   * the auth provider is mocked at the @clerk/express layer; the admin gate
//     resolves a verified email matching RESUPPLY_ADMIN_EMAILS.

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

// Drizzle stub. Two query shapes are exercised by this router:
//   1. SELECT → .from() → .where() → .limit() → Promise<rows>
//   2. UPDATE → .set() → .where() → .returning() → Promise<rows>
// We push results onto the matching queue in the order the handler
// will consume them. A test that does not push anything for a query
// gets `[]` back, mirroring "no row matched".
const selectQueue: unknown[][] = [];
const updateQueue: unknown[][] = [];
const dbStub = {
  select: vi.fn(() => {
    const result = selectQueue.shift() ?? [];
    const obj: Record<string, unknown> = {
      from: () => obj,
      where: () => obj,
      limit: () => Promise.resolve(result),
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
  const actual =
    await vi.importActual<typeof import("@workspace/resupply-db")>(
      "@workspace/resupply-db",
    );
  return { ...actual, getDbPool: () => ({}) as never };
});

const stripeRefundsCreateMock = vi.fn();
let stripeConfigured = true;
vi.mock("../../lib/stripe/config", () => ({
  readStripeConfigOrNull: () =>
    stripeConfigured ? { secretKey: "sk_test_x" } : null,
  getStripeClient: () => ({
    refunds: {
      create: (...a: unknown[]) => stripeRefundsCreateMock(...a),
    },
  }),
}));

import shopOrdersAdminRouter from "./shop-orders";

const ALLOWED_EMAIL = "ops@penn.example.com";
const VALID_ID = "11111111-2222-3333-4444-555555555555";

function makeApp(): Express {
  const app = express();
  app.use(express.json());
  app.use("/resupply-api", shopOrdersAdminRouter);
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

function paidOrderRow(over: Partial<Record<string, unknown>> = {}): Record<
  string,
  unknown
> {
  return {
    id: VALID_ID,
    stripeSessionId: "cs_test_1",
    stripePaymentIntentId: "pi_test_1",
    status: "paid",
    amountTotalCents: 4998,
    currency: "usd",
    clerkUserId: "user_alice",
    createdAt: new Date("2026-04-20T12:00:00Z"),
    paidAt: new Date("2026-04-20T12:01:00Z"),
    shippingAddress: null,
    trackingCarrier: null,
    trackingNumber: null,
    shippedAt: null,
    deliveredAt: null,
    ...over,
  };
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
  selectQueue.length = 0;
  updateQueue.length = 0;
  dbStub.select.mockClear();
  dbStub.update.mockClear();
  stripeRefundsCreateMock.mockReset();
  getAuthMock.mockReset();
  getUserMock.mockReset();
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (originalEnv[k] === undefined) delete process.env[k];
    else process.env[k] = originalEnv[k];
  }
  selectQueue.length = 0;
  updateQueue.length = 0;
});

// =====================================================================
// POST /admin/shop/orders/:orderId/tracking
// =====================================================================
describe("POST /admin/shop/orders/:orderId/tracking", () => {
  it("rejects callers without admin sign-in", async () => {
    getAuthMock.mockReturnValue({ userId: null });
    const res = await request(makeApp())
      .post(`/resupply-api/admin/shop/orders/${VALID_ID}/tracking`)
      .send({ carrier: "UPS", number: "1Z999AA1" });
    expect([401, 403]).toContain(res.status);
    expect(dbStub.update).not.toHaveBeenCalled();
  });

  it("rejects ids that aren't a UUID", async () => {
    stubVerifiedAdmin();
    const res = await request(makeApp())
      .post("/resupply-api/admin/shop/orders/not-a-uuid/tracking")
      .send({ carrier: "UPS", number: "1Z999AA1" });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_order_id");
    expect(dbStub.select).not.toHaveBeenCalled();
  });

  it("rejects empty carrier or number", async () => {
    stubVerifiedAdmin();
    const res = await request(makeApp())
      .post(`/resupply-api/admin/shop/orders/${VALID_ID}/tracking`)
      .send({ carrier: "  ", number: "1Z999" });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_body");
    expect(dbStub.select).not.toHaveBeenCalled();
  });

  it("returns 404 when no row matches the id", async () => {
    stubVerifiedAdmin();
    selectQueue.push([]);
    const res = await request(makeApp())
      .post(`/resupply-api/admin/shop/orders/${VALID_ID}/tracking`)
      .send({ carrier: "UPS", number: "1Z999AA1" });
    expect(res.status).toBe(404);
    expect(res.body.error).toBe("order_not_found");
    expect(dbStub.update).not.toHaveBeenCalled();
  });

  it("returns 409 when the order isn't paid", async () => {
    stubVerifiedAdmin();
    selectQueue.push([paidOrderRow({ status: "pending" })]);
    const res = await request(makeApp())
      .post(`/resupply-api/admin/shop/orders/${VALID_ID}/tracking`)
      .send({ carrier: "UPS", number: "1Z999AA1" });
    expect(res.status).toBe(409);
    expect(res.body.error).toBe("order_not_paid");
    expect(res.body.currentStatus).toBe("pending");
    expect(dbStub.update).not.toHaveBeenCalled();
  });

  it("writes tracking + shipped_at and returns the projected order", async () => {
    stubVerifiedAdmin();
    const shippedAt = new Date("2026-04-25T09:00:00Z");
    selectQueue.push([paidOrderRow()]);
    updateQueue.push([
      paidOrderRow({
        trackingCarrier: "UPS",
        trackingNumber: "1Z999AA1",
        shippedAt,
      }),
    ]);
    const res = await request(makeApp())
      .post(`/resupply-api/admin/shop/orders/${VALID_ID}/tracking`)
      .send({ carrier: "UPS", number: "1Z999AA1" });
    expect(res.status).toBe(200);
    expect(res.body.order.trackingCarrier).toBe("UPS");
    expect(res.body.order.trackingNumber).toBe("1Z999AA1");
    expect(res.body.order.shippedAt).toBe(shippedAt.toISOString());
    expect(dbStub.update).toHaveBeenCalledTimes(1);
  });

  it("allows overwriting tracking on a re-shipped order", async () => {
    stubVerifiedAdmin();
    const reShippedAt = new Date("2026-04-29T09:00:00Z");
    selectQueue.push([
      paidOrderRow({
        trackingCarrier: "USPS",
        trackingNumber: "9400-old",
        shippedAt: new Date("2026-04-21T09:00:00Z"),
      }),
    ]);
    updateQueue.push([
      paidOrderRow({
        trackingCarrier: "FedEx",
        trackingNumber: "FX-NEW",
        shippedAt: reShippedAt,
      }),
    ]);
    const res = await request(makeApp())
      .post(`/resupply-api/admin/shop/orders/${VALID_ID}/tracking`)
      .send({ carrier: "FedEx", number: "FX-NEW" });
    expect(res.status).toBe(200);
    expect(res.body.order.trackingCarrier).toBe("FedEx");
    expect(res.body.order.shippedAt).toBe(reShippedAt.toISOString());
  });
});

// =====================================================================
// POST /admin/shop/orders/:orderId/delivered
// =====================================================================
describe("POST /admin/shop/orders/:orderId/delivered", () => {
  it("rejects callers without admin sign-in", async () => {
    getAuthMock.mockReturnValue({ userId: null });
    const res = await request(makeApp()).post(
      `/resupply-api/admin/shop/orders/${VALID_ID}/delivered`,
    );
    expect([401, 403]).toContain(res.status);
  });

  it("returns 404 when the order doesn't exist", async () => {
    stubVerifiedAdmin();
    selectQueue.push([]);
    const res = await request(makeApp()).post(
      `/resupply-api/admin/shop/orders/${VALID_ID}/delivered`,
    );
    expect(res.status).toBe(404);
    expect(res.body.error).toBe("order_not_found");
  });

  it("returns 409 when the order hasn't shipped", async () => {
    stubVerifiedAdmin();
    selectQueue.push([paidOrderRow()]);
    const res = await request(makeApp()).post(
      `/resupply-api/admin/shop/orders/${VALID_ID}/delivered`,
    );
    expect(res.status).toBe(409);
    expect(res.body.error).toBe("order_not_shipped");
    expect(dbStub.update).not.toHaveBeenCalled();
  });

  it("stamps delivered_at on a shipped order", async () => {
    stubVerifiedAdmin();
    const shippedAt = new Date("2026-04-25T09:00:00Z");
    const deliveredAt = new Date("2026-04-28T15:00:00Z");
    selectQueue.push([paidOrderRow({ shippedAt })]);
    updateQueue.push([paidOrderRow({ shippedAt, deliveredAt })]);
    const res = await request(makeApp()).post(
      `/resupply-api/admin/shop/orders/${VALID_ID}/delivered`,
    );
    expect(res.status).toBe(200);
    expect(res.body.order.deliveredAt).toBe(deliveredAt.toISOString());
    expect(dbStub.update).toHaveBeenCalledTimes(1);
  });

  it("is idempotent on a re-fire (does not bump delivered_at)", async () => {
    stubVerifiedAdmin();
    const shippedAt = new Date("2026-04-25T09:00:00Z");
    const originalDeliveredAt = new Date("2026-04-28T15:00:00Z");
    selectQueue.push([
      paidOrderRow({ shippedAt, deliveredAt: originalDeliveredAt }),
    ]);
    const res = await request(makeApp()).post(
      `/resupply-api/admin/shop/orders/${VALID_ID}/delivered`,
    );
    expect(res.status).toBe(200);
    expect(res.body.order.deliveredAt).toBe(originalDeliveredAt.toISOString());
    expect(dbStub.update).not.toHaveBeenCalled();
  });
});

// =====================================================================
// PATCH /admin/shop/orders/:orderId/shipping-address
// =====================================================================
describe("PATCH /admin/shop/orders/:orderId/shipping-address", () => {
  const validAddress = {
    line1: "123 Main St",
    line2: "Apt 4",
    city: "Philadelphia",
    state: "pa",
    postalCode: "19104",
    country: "US",
  };

  it("rejects callers without admin sign-in", async () => {
    getAuthMock.mockReturnValue({ userId: null });
    const res = await request(makeApp())
      .patch(`/resupply-api/admin/shop/orders/${VALID_ID}/shipping-address`)
      .send(validAddress);
    expect([401, 403]).toContain(res.status);
  });

  it("rejects bodies missing required fields", async () => {
    stubVerifiedAdmin();
    const res = await request(makeApp())
      .patch(`/resupply-api/admin/shop/orders/${VALID_ID}/shipping-address`)
      .send({ line1: "1 Main", city: "Philly" });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_body");
  });

  it("returns 404 when the order doesn't exist", async () => {
    stubVerifiedAdmin();
    selectQueue.push([]);
    const res = await request(makeApp())
      .patch(`/resupply-api/admin/shop/orders/${VALID_ID}/shipping-address`)
      .send(validAddress);
    expect(res.status).toBe(404);
    expect(res.body.error).toBe("order_not_found");
  });

  it("writes the address (uppercasing state) and returns the projected order", async () => {
    stubVerifiedAdmin();
    selectQueue.push([paidOrderRow()]);
    updateQueue.push([
      paidOrderRow({
        shippingAddress: { ...validAddress, state: "PA", line2: "Apt 4" },
      }),
    ]);
    const res = await request(makeApp())
      .patch(`/resupply-api/admin/shop/orders/${VALID_ID}/shipping-address`)
      .send(validAddress);
    expect(res.status).toBe(200);
    expect(res.body.order.shippingAddress.state).toBe("PA");
    expect(res.body.order.shippingAddress.line1).toBe("123 Main St");
  });

  it("allows the override even after shipment", async () => {
    stubVerifiedAdmin();
    const shippedAt = new Date("2026-04-25T09:00:00Z");
    selectQueue.push([paidOrderRow({ shippedAt })]);
    updateQueue.push([
      paidOrderRow({
        shippedAt,
        shippingAddress: { ...validAddress, state: "PA" },
      }),
    ]);
    const res = await request(makeApp())
      .patch(`/resupply-api/admin/shop/orders/${VALID_ID}/shipping-address`)
      .send(validAddress);
    expect(res.status).toBe(200);
    expect(res.body.order.shippedAt).toBe(shippedAt.toISOString());
  });
});

// =====================================================================
// POST /admin/shop/orders/:orderId/refund
// =====================================================================
describe("POST /admin/shop/orders/:orderId/refund", () => {
  it("rejects callers without admin sign-in", async () => {
    getAuthMock.mockReturnValue({ userId: null });
    const res = await request(makeApp())
      .post(`/resupply-api/admin/shop/orders/${VALID_ID}/refund`)
      .send({});
    expect([401, 403]).toContain(res.status);
  });

  it("returns 404 when the order doesn't exist", async () => {
    stubVerifiedAdmin();
    selectQueue.push([]);
    const res = await request(makeApp())
      .post(`/resupply-api/admin/shop/orders/${VALID_ID}/refund`)
      .send({});
    expect(res.status).toBe(404);
    expect(res.body.error).toBe("order_not_found");
  });

  it("returns 409 when the order is already refunded", async () => {
    stubVerifiedAdmin();
    selectQueue.push([paidOrderRow({ status: "refunded" })]);
    const res = await request(makeApp())
      .post(`/resupply-api/admin/shop/orders/${VALID_ID}/refund`)
      .send({});
    expect(res.status).toBe(409);
    expect(res.body.error).toBe("order_already_refunded");
    expect(stripeRefundsCreateMock).not.toHaveBeenCalled();
  });

  it("returns 409 when the order isn't paid yet", async () => {
    stubVerifiedAdmin();
    selectQueue.push([paidOrderRow({ status: "pending" })]);
    const res = await request(makeApp())
      .post(`/resupply-api/admin/shop/orders/${VALID_ID}/refund`)
      .send({});
    expect(res.status).toBe(409);
    expect(res.body.error).toBe("order_not_paid");
    expect(stripeRefundsCreateMock).not.toHaveBeenCalled();
  });

  it("returns 409 when there's no captured payment_intent", async () => {
    stubVerifiedAdmin();
    selectQueue.push([paidOrderRow({ stripePaymentIntentId: null })]);
    const res = await request(makeApp())
      .post(`/resupply-api/admin/shop/orders/${VALID_ID}/refund`)
      .send({});
    expect(res.status).toBe(409);
    expect(res.body.error).toBe("order_no_payment_intent");
  });

  it("returns 409 when amountCents exceeds the order total", async () => {
    stubVerifiedAdmin();
    selectQueue.push([paidOrderRow({ amountTotalCents: 4998 })]);
    const res = await request(makeApp())
      .post(`/resupply-api/admin/shop/orders/${VALID_ID}/refund`)
      .send({ amountCents: 9999 });
    expect(res.status).toBe(409);
    expect(res.body.error).toBe("refund_exceeds_amount");
    expect(res.body.amountTotalCents).toBe(4998);
    expect(stripeRefundsCreateMock).not.toHaveBeenCalled();
  });

  it("returns 503 when Stripe isn't configured", async () => {
    stubVerifiedAdmin();
    stripeConfigured = false;
    selectQueue.push([paidOrderRow()]);
    const res = await request(makeApp())
      .post(`/resupply-api/admin/shop/orders/${VALID_ID}/refund`)
      .send({});
    expect(res.status).toBe(503);
    expect(res.body.error).toBe("stripe_not_configured");
  });

  it("forwards Stripe errors as 502", async () => {
    stubVerifiedAdmin();
    selectQueue.push([paidOrderRow()]);
    stripeRefundsCreateMock.mockRejectedValue(
      Object.assign(new Error("stripe down"), { statusCode: 502 }),
    );
    const res = await request(makeApp())
      .post(`/resupply-api/admin/shop/orders/${VALID_ID}/refund`)
      .send({});
    expect(res.status).toBe(502);
    expect(res.body.error).toBe("stripe_refund_failed");
  });

  it("issues a full refund when amount is omitted", async () => {
    stubVerifiedAdmin();
    selectQueue.push([paidOrderRow()]);
    stripeRefundsCreateMock.mockResolvedValue({
      id: "re_test_1",
      amount: 4998,
      status: "succeeded",
    });
    const res = await request(makeApp())
      .post(`/resupply-api/admin/shop/orders/${VALID_ID}/refund`)
      .send({});
    expect(res.status).toBe(200);
    expect(res.body.refund.id).toBe("re_test_1");
    expect(res.body.refund.amountCents).toBe(4998);
    // Verify we passed the payment_intent through. amount must be
    // omitted from the SDK call when the body omits it (Stripe
    // interprets missing amount as "full refund").
    const callArgs = stripeRefundsCreateMock.mock.calls[0]?.[0] as {
      payment_intent?: string;
      amount?: number;
      reason?: string;
    };
    expect(callArgs.payment_intent).toBe("pi_test_1");
    expect(callArgs.amount).toBeUndefined();
    expect(callArgs.reason).toBeUndefined();
  });

  it("forwards amount + reason on a partial refund", async () => {
    stubVerifiedAdmin();
    selectQueue.push([paidOrderRow()]);
    stripeRefundsCreateMock.mockResolvedValue({
      id: "re_test_partial",
      amount: 1000,
      status: "succeeded",
    });
    const res = await request(makeApp())
      .post(`/resupply-api/admin/shop/orders/${VALID_ID}/refund`)
      .send({ amountCents: 1000, reason: "requested_by_customer" });
    expect(res.status).toBe(200);
    expect(res.body.refund.amountCents).toBe(1000);
    const callArgs = stripeRefundsCreateMock.mock.calls[0]?.[0] as {
      amount?: number;
      reason?: string;
      metadata?: Record<string, string>;
    };
    expect(callArgs.amount).toBe(1000);
    expect(callArgs.reason).toBe("requested_by_customer");
    // Defense in depth: admin email + order id are recorded on the
    // Stripe Refund metadata so the audit trail survives outside our DB.
    expect(callArgs.metadata?.admin_email).toBe(ALLOWED_EMAIL);
    expect(callArgs.metadata?.shop_order_id).toBe(VALID_ID);
  });
});
