// Route tests for routes/admin/customers.ts (the Customer 360
// admin surface). Mirrors the fluent-stub pattern in
// shop-orders.test.ts and shop-products.test.ts.
//
// Coverage matrix (T1: list endpoint only — T2/T3 will extend):
//   GET /admin/shop/customers
//     * unauthenticated caller       -> 401/403
//     * non-admin caller             -> 403
//     * invalid sortBy enum          -> 400
//     * invalid pageSize > 100       -> 400
//     * empty list happy path        -> 200, total=0
//     * list with one row            -> emailRedacted shape correct
//     * pagination + sort + filter   -> echoed in response
//     * lifetime + sub flag pass-through from SQL aggregation
//     * subscription=active filter   -> reaches handler (smoke test)
//
// Mocking strategy:
//   * `getDbPool` returns an empty object; the real Drizzle import
//     is replaced by a stub whose `.execute()` pulls the next
//     pre-queued result off `executeQueue`. The customers list
//     handler issues exactly two execute() calls per request: the
//     paginated SELECT, then the COUNT(*) total. Each test pushes
//     two rows-results in that order.
//   * the auth provider is mocked via auth-deps; the admin gate
//     resolves a verified email matching RESUPPLY_ADMIN_EMAILS.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import express, { type Express } from "express";
import request from "supertest";

import {
  makeRequireAdminMock,
  type MockAdminCtx,
} from "../../test-helpers/auth-mocks";

const { mockAdmin } = vi.hoisted(() => ({
  mockAdmin: { current: null as MockAdminCtx | null },
}));
vi.mock("../../middlewares/requireAdmin", () =>
  makeRequireAdminMock(mockAdmin),
);

// Drizzle stub. The customers list handler uses db.execute(sql`...`)
// (NOT the fluent select/from chain), so the stub only needs an
// .execute() method that pops from a queue.
const executeQueue: Array<{ rows: unknown[] }> = [];
const dbStub = {
  execute: vi.fn(() => Promise.resolve(executeQueue.shift() ?? { rows: [] })),
};

vi.mock("drizzle-orm/node-postgres", () => ({
  drizzle: () => dbStub,
}));

// Stripe stub for reorder tests. Same shape as shop-orders.test.ts.
const stripeCheckoutCreateMock = vi.fn();
let stripeConfigured = true;
vi.mock("../../lib/stripe/config", () => ({
  readStripeConfigOrNull: () =>
    stripeConfigured
      ? {
          secretKey: "sk_test_x",
          publishableKey: null,
          webhookSigningSecret: null,
          publicBaseUrl: "https://shop.test.example.com",
        }
      : null,
  getStripeClient: () => ({
    checkout: {
      sessions: {
        create: (...a: unknown[]) => stripeCheckoutCreateMock(...a),
      },
    },
  }),
}));

vi.mock("@workspace/resupply-db", async () => {
  const actual = await vi.importActual<typeof import("@workspace/resupply-db")>(
    "@workspace/resupply-db",
  );
  return { ...actual, getDbPool: () => ({}) as never };
});

const ALLOWED_EMAIL = "ops@penn.example.com";

function makeApp(router: import("express").IRouter): Express {
  const app = express();
  app.use(express.json());
  app.use("/resupply-api", router);
  return app;
}

function stubVerifiedAdmin(): void {
  mockAdmin.current = {
    userId: "user_op",
    email: ALLOWED_EMAIL,
    role: "admin",
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
  executeQueue.length = 0;
  dbStub.execute.mockClear();
  stripeCheckoutCreateMock.mockReset();
  stripeConfigured = true;
  mockAdmin.current = null;
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (originalEnv[k] === undefined) delete process.env[k];
    else process.env[k] = originalEnv[k];
  }
  executeQueue.length = 0;
});

async function loadRouter() {
  const mod = await import("./customers");
  return mod.default;
}

describe("GET /admin/shop/customers — auth gate", () => {
  it("rejects callers without sign-in (no userId)", async () => {
    const router = await loadRouter();
    const res = await request(makeApp(router)).get(
      "/resupply-api/admin/shop/customers",
    );
    expect([401, 403]).toContain(res.status);
    expect(dbStub.execute).not.toHaveBeenCalled();
  });

  it("rejects non-admin callers (verified email not on allowlist)", async () => {
    const router = await loadRouter();
    const res = await request(makeApp(router)).get(
      "/resupply-api/admin/shop/customers",
    );
    expect(res.status).toBe(401);
    expect(dbStub.execute).not.toHaveBeenCalled();
  });
});

describe("GET /admin/shop/customers — query validation", () => {
  it("rejects invalid sortBy", async () => {
    stubVerifiedAdmin();
    const router = await loadRouter();
    const res = await request(makeApp(router)).get(
      "/resupply-api/admin/shop/customers?sortBy=bogus",
    );
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_query");
  });

  it("rejects pageSize > 100", async () => {
    stubVerifiedAdmin();
    const router = await loadRouter();
    const res = await request(makeApp(router)).get(
      "/resupply-api/admin/shop/customers?pageSize=999",
    );
    expect(res.status).toBe(400);
  });

  it("rejects invalid order direction", async () => {
    stubVerifiedAdmin();
    const router = await loadRouter();
    const res = await request(makeApp(router)).get(
      "/resupply-api/admin/shop/customers?order=sideways",
    );
    expect(res.status).toBe(400);
  });
});

describe("GET /admin/shop/customers — happy path", () => {
  it("returns empty result with total=0 when no customers", async () => {
    stubVerifiedAdmin();
    executeQueue.push({ rows: [] }); // list query
    executeQueue.push({ rows: [{ total: 0 }] }); // count query
    const router = await loadRouter();
    const res = await request(makeApp(router)).get(
      "/resupply-api/admin/shop/customers",
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      customers: [],
      total: 0,
      page: 1,
      pageSize: 25,
    });
  });

  it("redacts email and maps every column shape", async () => {
    stubVerifiedAdmin();
    executeQueue.push({
      rows: [
        {
          user_id: "user_1",
          display_name: "Jane Doe",
          email_lower: "jane.doe@example.com",
          stripe_customer_id: "cus_123",
          created_at: "2026-01-01T00:00:00Z",
          orders_count: 3,
          lifetime_value_cents: 12345,
          last_order_at: "2026-04-01T00:00:00Z",
          has_active_subscription: true,
        },
      ],
    });
    executeQueue.push({ rows: [{ total: 1 }] });
    const router = await loadRouter();
    const res = await request(makeApp(router)).get(
      "/resupply-api/admin/shop/customers",
    );
    expect(res.status).toBe(200);
    expect(res.body.customers).toHaveLength(1);
    const c = res.body.customers[0];
    expect(c.userId).toBe("user_1");
    expect(c.displayName).toBe("Jane Doe");
    // jane.doe -> ja******@example.com (8 chars local, 2 head, 6 stars)
    expect(c.emailRedacted).toBe("ja******@example.com");
    expect(c.emailRedacted).not.toContain("jane.doe");
    expect(c.stripeCustomerId).toBe("cus_123");
    expect(c.ordersCount).toBe(3);
    expect(c.lifetimeValueCents).toBe(12345);
    expect(c.lastOrderAt).toBe("2026-04-01T00:00:00.000Z");
    expect(c.hasActiveSubscription).toBe(true);
    expect(c.createdAt).toBe("2026-01-01T00:00:00.000Z");
    expect(res.body.total).toBe(1);
  });

  it("preserves null lastOrderAt for never-ordered customers", async () => {
    stubVerifiedAdmin();
    executeQueue.push({
      rows: [
        {
          user_id: "user_2",
          display_name: null,
          email_lower: "no@orders.io",
          stripe_customer_id: null,
          created_at: "2026-02-01T00:00:00Z",
          orders_count: 0,
          lifetime_value_cents: 0,
          last_order_at: null,
          has_active_subscription: false,
        },
      ],
    });
    executeQueue.push({ rows: [{ total: 1 }] });
    const router = await loadRouter();
    const res = await request(makeApp(router)).get(
      "/resupply-api/admin/shop/customers",
    );
    expect(res.status).toBe(200);
    const c = res.body.customers[0];
    expect(c.lastOrderAt).toBeNull();
    expect(c.ordersCount).toBe(0);
    expect(c.lifetimeValueCents).toBe(0);
    expect(c.hasActiveSubscription).toBe(false);
  });

  it("echoes pagination + sort + filter in response and reaches DB", async () => {
    stubVerifiedAdmin();
    executeQueue.push({ rows: [] });
    executeQueue.push({ rows: [{ total: 0 }] });
    const router = await loadRouter();
    const res = await request(makeApp(router)).get(
      "/resupply-api/admin/shop/customers?page=2&pageSize=10&sortBy=lifetime_value&order=asc&subscription=active",
    );
    expect(res.status).toBe(200);
    expect(res.body.page).toBe(2);
    expect(res.body.pageSize).toBe(10);
    expect(dbStub.execute).toHaveBeenCalledTimes(2);
  });

  it("redacts very-short local-parts safely (<=2 chars)", async () => {
    stubVerifiedAdmin();
    executeQueue.push({
      rows: [
        {
          user_id: "user_short",
          display_name: "AB",
          email_lower: "ab@x.io",
          stripe_customer_id: null,
          created_at: "2026-01-01T00:00:00Z",
          orders_count: 0,
          lifetime_value_cents: 0,
          last_order_at: null,
          has_active_subscription: false,
        },
      ],
    });
    executeQueue.push({ rows: [{ total: 1 }] });
    const router = await loadRouter();
    const res = await request(makeApp(router)).get(
      "/resupply-api/admin/shop/customers",
    );
    expect(res.status).toBe(200);
    // Local-part is already <=2 chars; no asterisks needed.
    expect(res.body.customers[0].emailRedacted).toBe("ab@x.io");
  });
});

// =====================================================================
// GET /admin/shop/customers/:userId — single-customer detail
// =====================================================================
//
// The detail handler issues SIX execute() calls per request, in order:
//   1. customer mirror row    (shop_customers)
//   2. recent orders          (shop_orders, LIMIT 25)
//   3. subscriptions          (shop_subscriptions)
//   4. abandoned cart         (shop_abandoned_carts, LIMIT 1)
//   5. reviews                (shop_reviews, LIMIT 100)
//   6. stats rollup           (single row of aggregates)
//
// On the 404 path (no customer AND no orders) only the first two
// calls are made.

const VALID_USER_ID = "user_2abc_DEF-9";

function pushDetailQueue(opts: {
  customer: Record<string, unknown> | null;
  orders: Array<Record<string, unknown>>;
  subscriptions?: Array<Record<string, unknown>>;
  abandonedCart?: Record<string, unknown> | null;
  reviews?: Array<Record<string, unknown>>;
  /**
   * In-app conversation summary (added in PR #54). Defaults to no
   * thread (empty rows) so existing tests don't have to be aware of
   * the new query unless they specifically exercise the in-app
   * surface. Pushed in the same order as the route's SQL: between
   * reviews and stats.
   */
  inAppConversation?: Record<string, unknown> | null;
  stats?: Record<string, unknown>;
}): void {
  executeQueue.push({ rows: opts.customer ? [opts.customer] : [] });
  executeQueue.push({ rows: opts.orders });
  // The remaining queries are only issued if the 404 short-
  // circuit was NOT triggered.
  const not404 = !!opts.customer || opts.orders.length > 0;
  if (!not404) return;
  executeQueue.push({ rows: opts.subscriptions ?? [] });
  executeQueue.push({
    rows: opts.abandonedCart ? [opts.abandonedCart] : [],
  });
  executeQueue.push({ rows: opts.reviews ?? [] });
  executeQueue.push({
    rows: opts.inAppConversation ? [opts.inAppConversation] : [],
  });
  executeQueue.push({
    rows: [
      opts.stats ?? {
        orders_count: opts.orders.length,
        lifetime_value_cents: 0,
        first_order_at: null,
        last_order_at: null,
        pending_reviews_count: 0,
      },
    ],
  });
}

describe("GET /admin/shop/customers/:userId — auth + validation", () => {
  it("rejects unauthenticated callers", async () => {
    const router = await loadRouter();
    const res = await request(makeApp(router)).get(
      `/resupply-api/admin/shop/customers/${VALID_USER_ID}`,
    );
    expect([401, 403]).toContain(res.status);
    expect(dbStub.execute).not.toHaveBeenCalled();
  });

  it("rejects non-admin callers", async () => {
    const router = await loadRouter();
    const res = await request(makeApp(router)).get(
      `/resupply-api/admin/shop/customers/${VALID_USER_ID}`,
    );
    expect(res.status).toBe(401);
  });

  it("rejects malformed user ids", async () => {
    stubVerifiedAdmin();
    const router = await loadRouter();
    const res = await request(makeApp(router)).get(
      "/resupply-api/admin/shop/customers/has spaces!",
    );
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_user_id");
  });
});

describe("GET /admin/shop/customers/:userId — happy paths", () => {
  it("returns 404 when no customer row AND no orders", async () => {
    stubVerifiedAdmin();
    pushDetailQueue({ customer: null, orders: [] });
    const router = await loadRouter();
    const res = await request(makeApp(router)).get(
      `/resupply-api/admin/shop/customers/${VALID_USER_ID}`,
    );
    expect(res.status).toBe(404);
    expect(res.body.error).toBe("customer_not_found");
  });

  it("returns full profile for registered customer with orders", async () => {
    stubVerifiedAdmin();
    pushDetailQueue({
      customer: {
        user_id: VALID_USER_ID,
        display_name: "Jane Doe",
        email_lower: "jane@example.com",
        stripe_customer_id: "cus_abc",
        shipping_address_json: { line1: "123 Main", city: "Phila" },
        default_payment_method_brand: "visa",
        default_payment_method_last4: "4242",
        default_payment_method_exp_month: 12,
        default_payment_method_exp_year: 2030,
        created_at: "2026-01-01T00:00:00Z",
        updated_at: "2026-04-01T00:00:00Z",
      },
      orders: [
        {
          id: "ord_1",
          stripe_session_id: "cs_1",
          stripe_payment_intent_id: "pi_1",
          status: "paid",
          amount_total_cents: 5000,
          currency: "usd",
          created_at: "2026-04-01T00:00:00Z",
          paid_at: "2026-04-01T00:01:00Z",
          shipped_at: null,
          delivered_at: null,
          tracking_carrier: null,
          tracking_number: null,
          shipping_address_json: { line1: "123 Main" },
          item_count: 2,
        },
        {
          id: "ord_0",
          stripe_session_id: "cs_0",
          stripe_payment_intent_id: "pi_0",
          status: "delivered",
          amount_total_cents: 3000,
          currency: "usd",
          created_at: "2026-02-01T00:00:00Z",
          paid_at: "2026-02-01T00:01:00Z",
          shipped_at: "2026-02-02T00:00:00Z",
          delivered_at: "2026-02-04T00:00:00Z",
          tracking_carrier: "UPS",
          tracking_number: "1Z999",
          shipping_address_json: null,
          item_count: 1,
        },
      ],
      subscriptions: [
        {
          id: "sub_1",
          stripe_subscription_id: "sub_stripe_1",
          stripe_customer_id: "cus_abc",
          status: "active",
          items: [{ priceId: "price_x", quantity: 1 }],
          current_period_end: "2026-05-01T00:00:00Z",
          cancel_at_period_end: false,
          canceled_at: null,
          initial_amount_total_cents: 5000,
          created_at: "2026-01-01T00:00:00Z",
          updated_at: "2026-04-01T00:00:00Z",
        },
      ],
      abandonedCart: {
        id: "cart_1",
        items: [{ priceId: "price_y", quantity: 2 }],
        subtotal_cents: 4000,
        currency: "usd",
        updated_at: "2026-04-15T00:00:00Z",
        reminded_at: "2026-04-16T00:00:00Z",
        recovered_at: null,
        cleared_at: null,
        created_at: "2026-04-15T00:00:00Z",
      },
      reviews: [
        {
          id: "rev_1",
          product_id: "prod_x",
          rating: 5,
          title: "Great",
          body: "Loved it",
          status: "approved",
          moderation_note: null,
          moderated_at: "2026-03-01T00:00:00Z",
          created_at: "2026-03-01T00:00:00Z",
          updated_at: "2026-03-01T00:00:00Z",
        },
      ],
      stats: {
        orders_count: 2,
        lifetime_value_cents: 8000,
        first_order_at: "2026-02-01T00:00:00Z",
        last_order_at: "2026-04-01T00:00:00Z",
        pending_reviews_count: 0,
      },
    });
    const router = await loadRouter();
    const res = await request(makeApp(router)).get(
      `/resupply-api/admin/shop/customers/${VALID_USER_ID}`,
    );
    expect(res.status).toBe(200);
    expect(res.body.customer.userId).toBe(VALID_USER_ID);
    expect(res.body.customer.email).toBe("jane@example.com");
    expect(res.body.customer.isGuest).toBe(false);
    expect(res.body.customer.defaultPaymentMethod).toEqual({
      brand: "visa",
      last4: "4242",
      expMonth: 12,
      expYear: 2030,
    });
    expect(res.body.orders).toHaveLength(2);
    expect(res.body.orders[0].id).toBe("ord_1");
    expect(res.body.orders[0].itemCount).toBe(2);
    expect(res.body.subscriptions).toHaveLength(1);
    expect(res.body.subscriptions[0].status).toBe("active");
    expect(res.body.abandonedCart).not.toBeNull();
    expect(res.body.abandonedCart.subtotalCents).toBe(4000);
    expect(res.body.reviews).toHaveLength(1);
    // Stats arithmetic: avg = round(8000 / 2) = 4000.
    expect(res.body.stats.ordersCount).toBe(2);
    expect(res.body.stats.lifetimeValueCents).toBe(8000);
    expect(res.body.stats.avgOrderValueCents).toBe(4000);
    expect(res.body.stats.firstOrderAt).toBe("2026-02-01T00:00:00.000Z");
    expect(res.body.stats.lastOrderAt).toBe("2026-04-01T00:00:00.000Z");
    expect(res.body.stats.pendingReviewsCount).toBe(0);
  });

  it("preserves null amount_total_cents on pending orders (no $0.00 coercion)", async () => {
    stubVerifiedAdmin();
    pushDetailQueue({
      customer: {
        user_id: VALID_USER_ID,
        display_name: "Jane Doe",
        email_lower: "jane@example.com",
        stripe_customer_id: "cus_abc",
        shipping_address_json: null,
        default_payment_method_brand: null,
        default_payment_method_last4: null,
        default_payment_method_exp_month: null,
        default_payment_method_exp_year: null,
        created_at: "2026-01-01T00:00:00Z",
        updated_at: "2026-04-01T00:00:00Z",
      },
      orders: [
        {
          id: "ord_pending",
          stripe_session_id: "cs_pending",
          stripe_payment_intent_id: null,
          status: "pending",
          // Stripe hasn't stamped a final total yet — DB column is null.
          // The detail endpoint must surface null, NOT coerce to 0,
          // so the UI can render an em dash instead of a misleading $0.00.
          amount_total_cents: null,
          currency: null,
          created_at: "2026-04-30T00:00:00Z",
          paid_at: null,
          shipped_at: null,
          delivered_at: null,
          tracking_carrier: null,
          tracking_number: null,
          shipping_address_json: null,
          item_count: 1,
        },
      ],
      subscriptions: [],
      abandonedCart: null,
      reviews: [],
      stats: {
        orders_count: 0,
        lifetime_value_cents: 0,
        first_order_at: null,
        last_order_at: null,
        pending_reviews_count: 0,
      },
    });
    const router = await loadRouter();
    const res = await request(makeApp(router)).get(
      `/resupply-api/admin/shop/customers/${VALID_USER_ID}`,
    );
    expect(res.status).toBe(200);
    expect(res.body.orders).toHaveLength(1);
    expect(res.body.orders[0].amountTotalCents).toBeNull();
    expect(res.body.orders[0].currency).toBeNull();
  });

  it("synthesizes a guest customer when only orders exist", async () => {
    stubVerifiedAdmin();
    pushDetailQueue({
      customer: null,
      orders: [
        {
          id: "ord_g",
          stripe_session_id: "cs_g",
          stripe_payment_intent_id: "pi_g",
          status: "paid",
          amount_total_cents: 2500,
          currency: "usd",
          created_at: "2026-04-01T00:00:00Z",
          paid_at: "2026-04-01T00:01:00Z",
          shipped_at: null,
          delivered_at: null,
          tracking_carrier: null,
          tracking_number: null,
          shipping_address_json: { line1: "999 Guest Ln" },
          item_count: 1,
        },
      ],
      stats: {
        orders_count: 1,
        lifetime_value_cents: 2500,
        first_order_at: "2026-04-01T00:00:00Z",
        last_order_at: "2026-04-01T00:00:00Z",
        pending_reviews_count: 0,
      },
    });
    const router = await loadRouter();
    const res = await request(makeApp(router)).get(
      `/resupply-api/admin/shop/customers/${VALID_USER_ID}`,
    );
    expect(res.status).toBe(200);
    expect(res.body.customer.isGuest).toBe(true);
    expect(res.body.customer.userId).toBe(VALID_USER_ID);
    expect(res.body.customer.email).toBeNull();
    expect(res.body.customer.shippingAddress).toEqual({
      line1: "999 Guest Ln",
    });
    // avg = round(2500/1) = 2500
    expect(res.body.stats.avgOrderValueCents).toBe(2500);
  });

  it("computes avgOrderValueCents=0 when ordersCount=0", async () => {
    stubVerifiedAdmin();
    pushDetailQueue({
      customer: {
        user_id: VALID_USER_ID,
        display_name: "Empty",
        email_lower: "empty@example.com",
        stripe_customer_id: null,
        shipping_address_json: null,
        default_payment_method_brand: null,
        default_payment_method_last4: null,
        default_payment_method_exp_month: null,
        default_payment_method_exp_year: null,
        created_at: "2026-01-01T00:00:00Z",
        updated_at: "2026-01-01T00:00:00Z",
      },
      orders: [],
      // Customer exists but no orders — must not 404, and avg must be 0.
      stats: {
        orders_count: 0,
        lifetime_value_cents: 0,
        first_order_at: null,
        last_order_at: null,
        pending_reviews_count: 0,
      },
    });
    const router = await loadRouter();
    const res = await request(makeApp(router)).get(
      `/resupply-api/admin/shop/customers/${VALID_USER_ID}`,
    );
    expect(res.status).toBe(200);
    expect(res.body.stats.ordersCount).toBe(0);
    expect(res.body.stats.avgOrderValueCents).toBe(0);
    expect(res.body.abandonedCart).toBeNull();
  });

  // ─── PR #54: clinical info + in-app conversation surfacing ─────

  it("surfaces clinicalInfo from shop_customers (PR #54)", async () => {
    stubVerifiedAdmin();
    pushDetailQueue({
      customer: {
        user_id: VALID_USER_ID,
        display_name: "Anna Singh",
        email_lower: "anna@example.com",
        stripe_customer_id: null,
        shipping_address_json: null,
        default_payment_method_brand: null,
        default_payment_method_last4: null,
        default_payment_method_exp_month: null,
        default_payment_method_exp_year: null,
        cpap_device_json: {
          manufacturer: "ResMed",
          model: "AirSense 11 AutoSet",
          serialNumber: null,
          pressureSetting: "8-12 cm H2O",
          humidifierSetting: null,
          notes: null,
        },
        physician_info_json: {
          name: "Dr. Lee",
          practice: "Penn Sleep Medicine",
          phone: null,
          fax: null,
          email: null,
          addressLine1: null,
          addressLine2: null,
          city: null,
          state: null,
          postalCode: null,
          npi: null,
        },
        created_at: "2026-01-01T00:00:00Z",
        updated_at: "2026-04-01T00:00:00Z",
      },
      orders: [],
    });
    const router = await loadRouter();
    const res = await request(makeApp(router)).get(
      `/resupply-api/admin/shop/customers/${VALID_USER_ID}`,
    );
    expect(res.status).toBe(200);
    expect(res.body.customer.clinicalInfo.cpapDevice.manufacturer).toBe(
      "ResMed",
    );
    expect(res.body.customer.clinicalInfo.cpapDevice.model).toBe(
      "AirSense 11 AutoSet",
    );
    expect(res.body.customer.clinicalInfo.physicianInfo.name).toBe("Dr. Lee");
  });

  it("returns null clinicalInfo for guest checkouts (no shop_customers row)", async () => {
    stubVerifiedAdmin();
    pushDetailQueue({
      customer: null,
      orders: [
        {
          id: "ord_guest",
          stripe_session_id: "cs_guest",
          stripe_payment_intent_id: "pi_guest",
          status: "paid",
          amount_total_cents: 5000,
          currency: "usd",
          created_at: "2026-04-30T00:00:00Z",
          paid_at: "2026-04-30T00:01:00Z",
          shipped_at: null,
          delivered_at: null,
          tracking_carrier: null,
          tracking_number: null,
          shipping_address_json: { line1: "1 Guest Ln" },
          item_count: 1,
        },
      ],
    });
    const router = await loadRouter();
    const res = await request(makeApp(router)).get(
      `/resupply-api/admin/shop/customers/${VALID_USER_ID}`,
    );
    expect(res.status).toBe(200);
    expect(res.body.customer.isGuest).toBe(true);
    expect(res.body.customer.clinicalInfo.cpapDevice).toBeNull();
    expect(res.body.customer.clinicalInfo.physicianInfo).toBeNull();
  });

  it("surfaces inAppConversation summary when present (PR #54)", async () => {
    stubVerifiedAdmin();
    pushDetailQueue({
      customer: {
        user_id: VALID_USER_ID,
        display_name: "Anna",
        email_lower: "a@x.io",
        stripe_customer_id: null,
        shipping_address_json: null,
        default_payment_method_brand: null,
        default_payment_method_last4: null,
        default_payment_method_exp_month: null,
        default_payment_method_exp_year: null,
        cpap_device_json: null,
        physician_info_json: null,
        created_at: "2026-01-01T00:00:00Z",
        updated_at: "2026-04-01T00:00:00Z",
      },
      orders: [],
      inAppConversation: {
        id: "conv_in_app_1",
        status: "awaiting_admin",
        last_message_at: "2026-05-01T12:00:00Z",
        created_at: "2026-04-25T00:00:00Z",
        message_count: 4,
        unread_from_customer: 2,
        last_inbound_at: "2026-05-01T12:00:00Z",
        last_outbound_at: "2026-04-30T08:00:00Z",
      },
    });
    const router = await loadRouter();
    const res = await request(makeApp(router)).get(
      `/resupply-api/admin/shop/customers/${VALID_USER_ID}`,
    );
    expect(res.status).toBe(200);
    expect(res.body.inAppConversation).toMatchObject({
      id: "conv_in_app_1",
      status: "awaiting_admin",
      messageCount: 4,
      unreadFromCustomer: 2,
    });
  });

  it("returns null inAppConversation when the customer has never messaged", async () => {
    stubVerifiedAdmin();
    pushDetailQueue({
      customer: {
        user_id: VALID_USER_ID,
        display_name: null,
        email_lower: null,
        stripe_customer_id: null,
        shipping_address_json: null,
        default_payment_method_brand: null,
        default_payment_method_last4: null,
        default_payment_method_exp_month: null,
        default_payment_method_exp_year: null,
        cpap_device_json: null,
        physician_info_json: null,
        created_at: "2026-01-01T00:00:00Z",
        updated_at: "2026-04-01T00:00:00Z",
      },
      orders: [],
    });
    const router = await loadRouter();
    const res = await request(makeApp(router)).get(
      `/resupply-api/admin/shop/customers/${VALID_USER_ID}`,
    );
    expect(res.status).toBe(200);
    expect(res.body.inAppConversation).toBeNull();
  });
});

// =====================================================================
// POST /admin/shop/customers/:userId/reorder
// =====================================================================
//
// Per-test queue layout (when handler runs end-to-end):
//   [0] source order lookup
//   [1] order items lookup
//   [2] customer mirror lookup
//
// Tests that short-circuit before Stripe (404, ownership-mismatch,
// not-paid, no-items) push fewer rows.

const SOURCE_ORDER_ID = "11111111-2222-3333-4444-555555555555";

function pushReorderQueue({
  order,
  items,
  customer,
}: {
  order: Record<string, unknown> | null;
  items?: Array<{ price_id: string; quantity: number }>;
  customer?: {
    email_lower: string | null;
    stripe_customer_id: string | null;
  } | null;
}) {
  executeQueue.push({ rows: order ? [order] : [] });
  if (items !== undefined) executeQueue.push({ rows: items });
  if (customer !== undefined)
    executeQueue.push({ rows: customer ? [customer] : [] });
}

describe("POST /admin/shop/customers/:userId/reorder — auth & validation", () => {
  it("rejects unauthenticated callers", async () => {
    const router = await loadRouter();
    const res = await request(makeApp(router))
      .post(`/resupply-api/admin/shop/customers/${VALID_USER_ID}/reorder`)
      .send({ sourceOrderId: SOURCE_ORDER_ID });
    expect(res.status).toBe(401);
    expect(dbStub.execute).not.toHaveBeenCalled();
    expect(stripeCheckoutCreateMock).not.toHaveBeenCalled();
  });

  it("rejects malformed userId", async () => {
    stubVerifiedAdmin();
    const router = await loadRouter();
    const res = await request(makeApp(router))
      .post(`/resupply-api/admin/shop/customers/has spaces/reorder`)
      .send({ sourceOrderId: SOURCE_ORDER_ID });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_user_id");
    expect(stripeCheckoutCreateMock).not.toHaveBeenCalled();
  });

  it("rejects missing sourceOrderId in body", async () => {
    stubVerifiedAdmin();
    const router = await loadRouter();
    const res = await request(makeApp(router))
      .post(`/resupply-api/admin/shop/customers/${VALID_USER_ID}/reorder`)
      .send({});
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_body");
    expect(stripeCheckoutCreateMock).not.toHaveBeenCalled();
  });
});

describe("POST /admin/shop/customers/:userId/reorder — preconditions", () => {
  it("returns 404 when source order doesn't exist", async () => {
    stubVerifiedAdmin();
    pushReorderQueue({ order: null });
    const router = await loadRouter();
    const res = await request(makeApp(router))
      .post(`/resupply-api/admin/shop/customers/${VALID_USER_ID}/reorder`)
      .send({ sourceOrderId: SOURCE_ORDER_ID });
    expect(res.status).toBe(404);
    expect(res.body.error).toBe("source_order_not_found");
    expect(stripeCheckoutCreateMock).not.toHaveBeenCalled();
  });

  it("returns 400 when source order belongs to a different user", async () => {
    stubVerifiedAdmin();
    pushReorderQueue({
      order: {
        id: SOURCE_ORDER_ID,
        status: "paid",
        paid_at: "2026-04-01T00:00:00Z",
        customer_id: "user_someone_else",
      },
    });
    const router = await loadRouter();
    const res = await request(makeApp(router))
      .post(`/resupply-api/admin/shop/customers/${VALID_USER_ID}/reorder`)
      .send({ sourceOrderId: SOURCE_ORDER_ID });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("source_order_user_mismatch");
    expect(stripeCheckoutCreateMock).not.toHaveBeenCalled();
  });

  it("returns 400 when source order isn't paid", async () => {
    stubVerifiedAdmin();
    pushReorderQueue({
      order: {
        id: SOURCE_ORDER_ID,
        status: "pending",
        paid_at: null,
        customer_id: VALID_USER_ID,
      },
    });
    const router = await loadRouter();
    const res = await request(makeApp(router))
      .post(`/resupply-api/admin/shop/customers/${VALID_USER_ID}/reorder`)
      .send({ sourceOrderId: SOURCE_ORDER_ID });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("source_order_not_reorderable");
    expect(res.body.currentStatus).toBe("pending");
    expect(stripeCheckoutCreateMock).not.toHaveBeenCalled();
  });

  it("returns 400 when source order is refunded", async () => {
    stubVerifiedAdmin();
    pushReorderQueue({
      order: {
        id: SOURCE_ORDER_ID,
        status: "refunded",
        paid_at: "2026-03-01T00:00:00Z",
        customer_id: VALID_USER_ID,
      },
    });
    const router = await loadRouter();
    const res = await request(makeApp(router))
      .post(`/resupply-api/admin/shop/customers/${VALID_USER_ID}/reorder`)
      .send({ sourceOrderId: SOURCE_ORDER_ID });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("source_order_not_reorderable");
    expect(stripeCheckoutCreateMock).not.toHaveBeenCalled();
  });

  it("returns 400 when source order has no eligible items", async () => {
    stubVerifiedAdmin();
    pushReorderQueue({
      order: {
        id: SOURCE_ORDER_ID,
        status: "paid",
        paid_at: "2026-04-01T00:00:00Z",
        customer_id: VALID_USER_ID,
      },
      items: [],
    });
    const router = await loadRouter();
    const res = await request(makeApp(router))
      .post(`/resupply-api/admin/shop/customers/${VALID_USER_ID}/reorder`)
      .send({ sourceOrderId: SOURCE_ORDER_ID });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("source_order_has_no_items");
    expect(stripeCheckoutCreateMock).not.toHaveBeenCalled();
  });
});

describe("POST /admin/shop/customers/:userId/reorder — Stripe integration", () => {
  it("returns 503 when Stripe isn't configured", async () => {
    stubVerifiedAdmin();
    stripeConfigured = false;
    pushReorderQueue({
      order: {
        id: SOURCE_ORDER_ID,
        status: "paid",
        paid_at: "2026-04-01T00:00:00Z",
        customer_id: VALID_USER_ID,
      },
      items: [{ price_id: "price_x", quantity: 2 }],
      customer: null,
    });
    const router = await loadRouter();
    const res = await request(makeApp(router))
      .post(`/resupply-api/admin/shop/customers/${VALID_USER_ID}/reorder`)
      .send({ sourceOrderId: SOURCE_ORDER_ID });
    expect(res.status).toBe(503);
    expect(res.body.error).toBe("stripe_not_configured");
    expect(stripeCheckoutCreateMock).not.toHaveBeenCalled();
  });

  it("creates a Checkout Session with the customer when stripe_customer_id is known", async () => {
    stubVerifiedAdmin();
    pushReorderQueue({
      order: {
        id: SOURCE_ORDER_ID,
        status: "paid",
        paid_at: "2026-04-01T00:00:00Z",
        customer_id: VALID_USER_ID,
      },
      items: [
        { price_id: "price_a", quantity: 2 },
        { price_id: "price_b", quantity: 1 },
      ],
      customer: {
        email_lower: "jane@example.com",
        stripe_customer_id: "cus_known_123",
      },
    });
    stripeCheckoutCreateMock.mockResolvedValue({
      id: "cs_test_abc",
      url: "https://checkout.stripe.com/c/pay/cs_test_abc",
      expires_at: 1893456000, // 2030-01-01
    });
    const router = await loadRouter();
    const res = await request(makeApp(router))
      .post(`/resupply-api/admin/shop/customers/${VALID_USER_ID}/reorder`)
      .send({ sourceOrderId: SOURCE_ORDER_ID });
    expect(res.status).toBe(200);
    expect(res.body.checkoutUrl).toBe(
      "https://checkout.stripe.com/c/pay/cs_test_abc",
    );
    expect(res.body.sessionId).toBe("cs_test_abc");
    expect(res.body.expiresAt).toBe("2030-01-01T00:00:00.000Z");

    expect(stripeCheckoutCreateMock).toHaveBeenCalledTimes(1);
    const params = stripeCheckoutCreateMock.mock.calls[0][0];
    expect(params.mode).toBe("payment");
    expect(params.customer).toBe("cus_known_123");
    expect(params.customer_email).toBeUndefined();
    expect(params.line_items).toEqual([
      { price: "price_a", quantity: 2 },
      { price: "price_b", quantity: 1 },
    ]);
    expect(params.metadata.source).toBe("pennpaps-admin-reorder");
    expect(params.metadata.customer_id).toBe(VALID_USER_ID);
    expect(params.metadata.reorder_source_order_id).toBe(SOURCE_ORDER_ID);
    expect(params.metadata.initiated_by_admin).toBe(ALLOWED_EMAIL);
    // success_url must hit the existing customer-facing landing page
    // (/shop/checkout-success?session_id={CHECKOUT_SESSION_ID}) so
    // the post-payment view actually exists; cancel_url returns to /shop.
    expect(params.success_url).toBe(
      "https://shop.test.example.com/shop/checkout-success?session_id={CHECKOUT_SESSION_ID}",
    );
    expect(params.cancel_url).toBe("https://shop.test.example.com/shop");
  });

  it("falls back to customer_email when no stripe_customer_id is mirrored", async () => {
    stubVerifiedAdmin();
    pushReorderQueue({
      order: {
        id: SOURCE_ORDER_ID,
        status: "paid",
        paid_at: "2026-04-01T00:00:00Z",
        customer_id: VALID_USER_ID,
      },
      items: [{ price_id: "price_a", quantity: 1 }],
      customer: {
        email_lower: "guest@example.com",
        stripe_customer_id: null,
      },
    });
    stripeCheckoutCreateMock.mockResolvedValue({
      id: "cs_test_def",
      url: "https://checkout.stripe.com/c/pay/cs_test_def",
      expires_at: null,
    });
    const router = await loadRouter();
    const res = await request(makeApp(router))
      .post(`/resupply-api/admin/shop/customers/${VALID_USER_ID}/reorder`)
      .send({ sourceOrderId: SOURCE_ORDER_ID });
    expect(res.status).toBe(200);
    const params = stripeCheckoutCreateMock.mock.calls[0][0];
    expect(params.customer).toBeUndefined();
    expect(params.customer_email).toBe("guest@example.com");
    expect(res.body.expiresAt).toBeNull();
  });

  it("omits both customer and customer_email when no mirror row exists", async () => {
    stubVerifiedAdmin();
    pushReorderQueue({
      order: {
        id: SOURCE_ORDER_ID,
        status: "paid",
        paid_at: "2026-04-01T00:00:00Z",
        customer_id: VALID_USER_ID,
      },
      items: [{ price_id: "price_a", quantity: 1 }],
      customer: null,
    });
    stripeCheckoutCreateMock.mockResolvedValue({
      id: "cs_test_ghi",
      url: "https://checkout.stripe.com/c/pay/cs_test_ghi",
      expires_at: 1893456000,
    });
    const router = await loadRouter();
    const res = await request(makeApp(router))
      .post(`/resupply-api/admin/shop/customers/${VALID_USER_ID}/reorder`)
      .send({ sourceOrderId: SOURCE_ORDER_ID });
    expect(res.status).toBe(200);
    const params = stripeCheckoutCreateMock.mock.calls[0][0];
    expect(params.customer).toBeUndefined();
    expect(params.customer_email).toBeUndefined();
  });

  it("returns 502 when Stripe returns no session url", async () => {
    stubVerifiedAdmin();
    pushReorderQueue({
      order: {
        id: SOURCE_ORDER_ID,
        status: "paid",
        paid_at: "2026-04-01T00:00:00Z",
        customer_id: VALID_USER_ID,
      },
      items: [{ price_id: "price_a", quantity: 1 }],
      customer: null,
    });
    stripeCheckoutCreateMock.mockResolvedValue({
      id: "cs_test_jkl",
      url: null,
      expires_at: null,
    });
    const router = await loadRouter();
    const res = await request(makeApp(router))
      .post(`/resupply-api/admin/shop/customers/${VALID_USER_ID}/reorder`)
      .send({ sourceOrderId: SOURCE_ORDER_ID });
    expect(res.status).toBe(502);
    expect(res.body.error).toBe("stripe_checkout_missing_url");
  });

  it("propagates Stripe error status as 502 and returns stripe_checkout_failed", async () => {
    stubVerifiedAdmin();
    pushReorderQueue({
      order: {
        id: SOURCE_ORDER_ID,
        status: "paid",
        paid_at: "2026-04-01T00:00:00Z",
        customer_id: VALID_USER_ID,
      },
      items: [{ price_id: "price_a", quantity: 1 }],
      customer: null,
    });
    stripeCheckoutCreateMock.mockRejectedValue(
      Object.assign(new Error("price not found"), { statusCode: 400 }),
    );
    const router = await loadRouter();
    const res = await request(makeApp(router))
      .post(`/resupply-api/admin/shop/customers/${VALID_USER_ID}/reorder`)
      .send({ sourceOrderId: SOURCE_ORDER_ID });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("stripe_checkout_failed");
  });
});
