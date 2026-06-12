// Route tests for POST /admin/shop/counter-orders — the CSR Front Desk
// walk-in / counter ordering endpoint.
//
// Coverage:
//   1. 401 with no session
//   2. 403 when the role lacks orders.create
//   3. 503 when the frontdesk.counter_orders flag is off
//   4. 503 when Stripe isn't configured
//   5. 400 cart_invalid when the catalog guard rejects a line
//   6. Cash pickup happy path → shop_orders status 'paid', paid_at set,
//      source 'counter', synthetic counter-<uuid> session id, items
//      inserted, server-computed total, audit emitted (ids/shape only)
//   7. Insurance happy path → status 'pending', no paid_at on the order
//   8. 400 when a shipped order omits the shipping address

import { beforeEach, describe, expect, it, vi } from "vitest";
import express, { type Express } from "express";
import request from "supertest";

import {
  makeRequireAdminMock,
  type MockAdminCtx,
} from "../../test-helpers/auth-mocks";
import {
  installSupabaseMock,
  stageSupabaseResponse,
  getSupabaseWritePayloads,
} from "../../test-helpers/supabase-mock";

const supabaseMock = installSupabaseMock();

const { mockAdmin } = vi.hoisted(() => ({
  mockAdmin: { current: null as MockAdminCtx | null },
}));
vi.mock("../../middlewares/requireAdmin", () =>
  makeRequireAdminMock(mockAdmin),
);

// Bypass idempotency + rate-limit middlewares — not under test here.
vi.mock("../../middlewares/idempotency", () => ({
  withIdempotency: () => (_req: unknown, _res: unknown, next: () => void) =>
    next(),
}));
vi.mock("../../middlewares/admin-rate-limit", () => ({
  adminWriteRateLimiter: (_req: unknown, _res: unknown, next: () => void) =>
    next(),
}));

const logAuditMock = vi.fn().mockResolvedValue(undefined);
vi.mock("@workspace/resupply-audit", () => ({
  logAudit: (...a: unknown[]) => logAuditMock(...a),
}));

// Feature flag — default ON; tests flip the value as needed.
const featureEnabled = vi.hoisted(() => ({ value: true }));
vi.mock("../../lib/feature-flags", () => ({
  isFeatureEnabled: vi.fn(async () => featureEnabled.value),
}));

// Stripe config + client.
const readStripeConfigOrNullMock = vi.fn();
const getStripeClientMock = vi.fn();
vi.mock("../../lib/stripe/config", () => ({
  readStripeConfigOrNull: () => readStripeConfigOrNullMock(),
  getStripeClient: (...args: unknown[]) => getStripeClientMock(...args),
}));

// Cart validation guard.
const validateCartItemsMock = vi.fn();
vi.mock("../../lib/stripe/validate-cart", () => ({
  validateCartItems: (...args: unknown[]) => validateCartItemsMock(...args),
}));

// Pickup location resolver.
const getActivePickupLocationByIdMock = vi.fn();
vi.mock("../../lib/pickup/locations", () => ({
  getActivePickupLocationById: (...args: unknown[]) =>
    getActivePickupLocationByIdMock(...args),
}));

import counterOrdersRouter from "./counter-orders";

const ORDER_ID = "ord_9999";
const PRICE_ID = "price_abc123xyz";
const PRODUCT_ID = "prod_abc123";
const LOCATION_ID = "11111111-1111-4111-8111-111111111111";
const PATIENT_ID = "22222222-2222-4222-8222-222222222222";

function makeApp(): Express {
  const app = express();
  app.use(express.json());
  app.use("/resupply-api", counterOrdersRouter);
  return app;
}

function stubCsr(): void {
  mockAdmin.current = {
    userId: "user_csr",
    email: "csr@penn.example.com",
    role: "agent",
    granularRole: "csr",
  };
}

function stubStripeReady(unitAmount = 4999): void {
  readStripeConfigOrNullMock.mockReturnValue({ secretKey: "sk_test_x" });
  getStripeClientMock.mockReturnValue({
    prices: {
      retrieve: vi.fn(async () => ({
        unit_amount: unitAmount,
        currency: "usd",
        product: PRODUCT_ID,
      })),
    },
  });
  validateCartItemsMock.mockResolvedValue({ ok: true, errors: [] });
}

const PICKUP_CASH_BODY = {
  items: [{ priceId: PRICE_ID, quantity: 2 }],
  paymentMethod: "cash",
  fulfillmentMethod: "pickup",
  pickupLocationId: LOCATION_ID,
};

describe("POST /admin/shop/counter-orders", () => {
  beforeEach(() => {
    mockAdmin.current = null;
    supabaseMock.reset();
    logAuditMock.mockReset().mockResolvedValue(undefined);
    featureEnabled.value = true;
    readStripeConfigOrNullMock.mockReset();
    getStripeClientMock.mockReset();
    validateCartItemsMock.mockReset();
    getActivePickupLocationByIdMock.mockReset();
  });

  it("401 with no session", async () => {
    const res = await request(makeApp())
      .post("/resupply-api/admin/shop/counter-orders")
      .send(PICKUP_CASH_BODY);
    expect(res.status).toBe(401);
  });

  it("403 when the role lacks orders.create", async () => {
    mockAdmin.current = {
      userId: "user_rt",
      email: "rt@penn.example.com",
      role: "agent",
      granularRole: "rt", // clinician — no orders.create
    };
    const res = await request(makeApp())
      .post("/resupply-api/admin/shop/counter-orders")
      .send(PICKUP_CASH_BODY);
    expect(res.status).toBe(403);
    expect(res.body.error).toBe("permission_denied");
  });

  it("503 when the feature flag is off", async () => {
    stubCsr();
    featureEnabled.value = false;
    const res = await request(makeApp())
      .post("/resupply-api/admin/shop/counter-orders")
      .send(PICKUP_CASH_BODY);
    expect(res.status).toBe(503);
    expect(res.body.error).toBe("counter_orders_disabled");
  });

  it("503 when Stripe is not configured", async () => {
    stubCsr();
    readStripeConfigOrNullMock.mockReturnValue(null);
    const res = await request(makeApp())
      .post("/resupply-api/admin/shop/counter-orders")
      .send(PICKUP_CASH_BODY);
    expect(res.status).toBe(503);
    expect(res.body.error).toBe("stripe_not_configured");
  });

  it("400 cart_invalid when the catalog guard rejects a line", async () => {
    stubCsr();
    readStripeConfigOrNullMock.mockReturnValue({ secretKey: "sk_test_x" });
    getStripeClientMock.mockReturnValue({ prices: { retrieve: vi.fn() } });
    getActivePickupLocationByIdMock.mockResolvedValue({ id: LOCATION_ID });
    validateCartItemsMock.mockResolvedValue({
      ok: false,
      errors: [
        { priceId: PRICE_ID, reason: "out_of_stock", message: "no stock" },
      ],
    });
    const res = await request(makeApp())
      .post("/resupply-api/admin/shop/counter-orders")
      .send(PICKUP_CASH_BODY);
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("cart_invalid");
  });

  it("cash pickup happy path: paid order, counter source, synthetic session, server total", async () => {
    stubCsr();
    stubStripeReady(4999);
    getActivePickupLocationByIdMock.mockResolvedValue({ id: LOCATION_ID });
    stageSupabaseResponse("shop_orders", "insert", { data: { id: ORDER_ID } });
    stageSupabaseResponse("shop_order_items", "insert", { data: null });

    const res = await request(makeApp())
      .post("/resupply-api/admin/shop/counter-orders")
      .send(PICKUP_CASH_BODY);

    expect(res.status).toBe(201);
    expect(res.body.order.id).toBe(ORDER_ID);
    expect(res.body.order.status).toBe("paid");
    expect(res.body.order.amountTotalCents).toBe(4999 * 2);

    const [orderPayload] = getSupabaseWritePayloads(
      "shop_orders",
      "insert",
    ) as Array<Record<string, unknown>>;
    expect(orderPayload.status).toBe("paid");
    expect(orderPayload.paid_at).toBeTruthy();
    expect(orderPayload.source).toBe("counter");
    expect(orderPayload.payment_method).toBe("cash");
    expect(orderPayload.counter_csr_email).toBe("csr@penn.example.com");
    expect(orderPayload.amount_total_cents).toBe(4999 * 2);
    expect(String(orderPayload.stripe_session_id)).toMatch(/^counter-/);
    expect(orderPayload.pickup_location_id).toBe(LOCATION_ID);
    // Pickup goods are ready at the counter immediately — stamped on
    // insert so the order can be handed over right away.
    expect(orderPayload.ready_for_pickup_at).toBeTruthy();

    const itemPayloads = getSupabaseWritePayloads(
      "shop_order_items",
      "insert",
    ) as Array<Array<Record<string, unknown>>>;
    // supabase .insert(rows) receives the array as a single arg.
    const rows = itemPayloads[0];
    expect(rows[0].product_id).toBe(PRODUCT_ID);
    expect(rows[0].price_id).toBe(PRICE_ID);
    expect(rows[0].quantity).toBe(2);
    expect(rows[0].paid_at).toBeTruthy();

    // Audit emits ids + commercial shape only, never the cart body.
    expect(logAuditMock).toHaveBeenCalledTimes(1);
    const audit = logAuditMock.mock.calls[0][0] as {
      action: string;
      metadata: Record<string, unknown>;
    };
    expect(audit.action).toBe("shop_order.counter.created");
    expect(audit.metadata.payment_method).toBe("cash");
    expect(audit.metadata).not.toHaveProperty("items");
  });

  it("insurance happy path: pending order, no paid_at", async () => {
    stubCsr();
    stubStripeReady(2500);
    getActivePickupLocationByIdMock.mockResolvedValue({ id: LOCATION_ID });
    stageSupabaseResponse("shop_orders", "insert", { data: { id: ORDER_ID } });
    stageSupabaseResponse("shop_order_items", "insert", { data: null });

    const res = await request(makeApp())
      .post("/resupply-api/admin/shop/counter-orders")
      .send({ ...PICKUP_CASH_BODY, paymentMethod: "insurance" });

    expect(res.status).toBe(201);
    expect(res.body.order.status).toBe("pending");

    const [orderPayload] = getSupabaseWritePayloads(
      "shop_orders",
      "insert",
    ) as Array<Record<string, unknown>>;
    expect(orderPayload.status).toBe("pending");
    // Not paid until the payer adjudicates — but still dispensable: the
    // goods are handed over now (ready_for_pickup_at stamped), the order
    // stays pending until the claim is paid.
    expect(orderPayload.paid_at).toBeUndefined();
    expect(orderPayload.ready_for_pickup_at).toBeTruthy();
    expect(orderPayload.payment_method).toBe("insurance");

    // Line items are recorded (dispensing / COGS) but with paid_at NULL,
    // so revenue/margin analytics (which filter on paid_at) don't count
    // the pending insurance sale as paid revenue until the claim pays.
    const itemRows = (
      getSupabaseWritePayloads("shop_order_items", "insert") as Array<
        Array<Record<string, unknown>>
      >
    )[0];
    expect(itemRows[0].paid_at).toBeNull();
  });

  it("400 when a shipped order omits the shipping address", async () => {
    stubCsr();
    stubStripeReady();
    const res = await request(makeApp())
      .post("/resupply-api/admin/shop/counter-orders")
      .send({
        items: [{ priceId: PRICE_ID, quantity: 1 }],
        paymentMethod: "cash",
        fulfillmentMethod: "ship",
      });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("shipping_address_required");
  });

  it("collapses duplicate price lines into one item row (atomicity)", async () => {
    stubCsr();
    stubStripeReady(1000);
    getActivePickupLocationByIdMock.mockResolvedValue({ id: LOCATION_ID });
    stageSupabaseResponse("shop_orders", "insert", { data: { id: ORDER_ID } });
    stageSupabaseResponse("shop_order_items", "insert", { data: null });

    const res = await request(makeApp())
      .post("/resupply-api/admin/shop/counter-orders")
      .send({
        items: [
          { priceId: PRICE_ID, quantity: 2 },
          { priceId: PRICE_ID, quantity: 1 },
        ],
        paymentMethod: "cash",
        fulfillmentMethod: "pickup",
        pickupLocationId: LOCATION_ID,
      });

    expect(res.status).toBe(201);
    // One line row (summed qty 3), not two — so the (session, product,
    // price) unique index can't be violated.
    const rows = (
      getSupabaseWritePayloads("shop_order_items", "insert") as Array<
        Array<Record<string, unknown>>
      >
    )[0];
    expect(rows).toHaveLength(1);
    expect(rows[0].quantity).toBe(3);
    expect(res.body.order.amountTotalCents).toBe(1000 * 3);
  });

  it("resolves an existing patient's email from patientId for linkage", async () => {
    stubCsr();
    stubStripeReady(2000);
    getActivePickupLocationByIdMock.mockResolvedValue({ id: LOCATION_ID });
    // Patient lookup → email; then order + items insert.
    stageSupabaseResponse("patients", "select", {
      data: { email: "walkin@patient.example.com" },
    });
    stageSupabaseResponse("shop_orders", "insert", { data: { id: ORDER_ID } });
    stageSupabaseResponse("shop_order_items", "insert", { data: null });

    const res = await request(makeApp())
      .post("/resupply-api/admin/shop/counter-orders")
      .send({ ...PICKUP_CASH_BODY, patientId: PATIENT_ID });

    expect(res.status).toBe(201);
    const [orderPayload] = getSupabaseWritePayloads(
      "shop_orders",
      "insert",
    ) as Array<Record<string, unknown>>;
    expect(orderPayload.customer_email).toBe("walkin@patient.example.com");
  });

  it("404s when patientId matches no patient", async () => {
    stubCsr();
    stubStripeReady();
    stageSupabaseResponse("patients", "select", { data: null });

    const res = await request(makeApp())
      .post("/resupply-api/admin/shop/counter-orders")
      .send({ ...PICKUP_CASH_BODY, patientId: PATIENT_ID });

    expect(res.status).toBe(404);
    expect(res.body.error).toBe("patient_not_found");
  });
});
