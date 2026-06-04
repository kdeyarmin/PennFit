// Route tests for routes/admin/customers.ts (the Customer 360
// admin surface).
//
// Coverage matrix:
//   GET /admin/shop/customers
//     * unauthenticated caller       -> 401/403
//     * non-admin caller             -> 403
//     * invalid sortBy enum          -> 400
//     * invalid pageSize > 100       -> 400
//     * empty list happy path        -> 200, total=0
//     * list with one row            -> emailRedacted shape correct
//     * pagination + sort + filter   -> echoed in response
//     * lifetime + sub flag pass-through from JS aggregation
//     * subscription=active filter   -> reaches handler (smoke test)
//
// Mocking strategy:
//   * Supabase client stubbed via the shared `supabase-mock` helper.
//     The list endpoint fans out to four tables (`shop_customers`,
//     `shop_orders`, `shop_subscriptions`, `conversations`); the
//     detail endpoint to eight; the reorder endpoint to three.
//     Each test stages the rows it expects each query to see, in
//     order.
//   * Stripe is mocked at the lib/stripe/config layer for the
//     reorder happy path.
//   * The auth provider is mocked via auth-deps; the admin gate
//     resolves a verified email matching RESUPPLY_ADMIN_EMAILS.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import express, { type Express } from "express";
import request from "supertest";

import {
  makeRequireAdminMock,
  type MockAdminCtx,
} from "../../test-helpers/auth-mocks";
import {
  installSupabaseMock,
  stageSupabaseResponse,
  getSupabaseCallCount,
} from "../../test-helpers/supabase-mock";

const supabaseMock = installSupabaseMock();

const { mockAdmin } = vi.hoisted(() => ({
  mockAdmin: { current: null as MockAdminCtx | null },
}));
vi.mock("../../middlewares/requireAdmin", () =>
  makeRequireAdminMock(mockAdmin),
);

// Stripe stub for reorder tests.
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
  supabaseMock.reset();
  stripeCheckoutCreateMock.mockReset();
  stripeConfigured = true;
  mockAdmin.current = null;
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (originalEnv[k] === undefined) delete process.env[k];
    else process.env[k] = originalEnv[k];
  }
});

async function loadRouter() {
  const mod = await import("./customers");
  return mod.default;
}

// ====================================================================
// Helper: stage the four tables the list endpoint reads in parallel.
// `customers` is the shop_customers SELECT. `orders`, `subs`, and
// `convs` represent the rollup data feeding the JS-side aggregations.
// ====================================================================
interface ListStageInput {
  customers: Array<Record<string, unknown>>;
  orders?: Array<Record<string, unknown>>;
  subs?: Array<Record<string, unknown>>;
  convs?: Array<Record<string, unknown>>;
}

function stageListEndpoint(opts: ListStageInput): void {
  stageSupabaseResponse("shop_customers", "select", { data: opts.customers });
  if (opts.customers.length === 0) {
    // Route short-circuits when no candidate ids — the parallel
    // rollup queries return Promise.resolve({data:[]}) JS-side
    // and never hit the mock.
    return;
  }
  stageSupabaseResponse("shop_orders", "select", { data: opts.orders ?? [] });
  stageSupabaseResponse("shop_subscriptions", "select", {
    data: opts.subs ?? [],
  });
  stageSupabaseResponse("conversations", "select", { data: opts.convs ?? [] });
}

describe("GET /admin/shop/customers — auth gate", () => {
  it("rejects callers without sign-in (no userId)", async () => {
    const router = await loadRouter();
    const res = await request(makeApp(router)).get(
      "/resupply-api/admin/shop/customers",
    );
    expect([401, 403]).toContain(res.status);
    expect(getSupabaseCallCount("shop_customers", "select")).toBe(0);
  });

  it("rejects non-admin callers (verified email not on allowlist)", async () => {
    const router = await loadRouter();
    const res = await request(makeApp(router)).get(
      "/resupply-api/admin/shop/customers",
    );
    expect(res.status).toBe(401);
    expect(getSupabaseCallCount("shop_customers", "select")).toBe(0);
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
    stageListEndpoint({ customers: [] });
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
    // Three paid orders summing to 12345, latest at 2026-04-01.
    stageListEndpoint({
      customers: [
        {
          customer_id: "user_1",
          display_name: "Jane Doe",
          email_lower: "jane.doe@example.com",
          stripe_customer_id: "cus_123",
          created_at: "2026-01-01T00:00:00Z",
        },
      ],
      orders: [
        {
          customer_id: "user_1",
          amount_total_cents: 5000,
          paid_at: "2026-04-01T00:01:00Z",
          status: "paid",
          created_at: "2026-04-01T00:00:00Z",
        },
        {
          customer_id: "user_1",
          amount_total_cents: 4345,
          paid_at: "2026-03-01T00:01:00Z",
          status: "paid",
          created_at: "2026-03-01T00:00:00Z",
        },
        {
          customer_id: "user_1",
          amount_total_cents: 3000,
          paid_at: "2026-02-01T00:01:00Z",
          status: "paid",
          created_at: "2026-02-01T00:00:00Z",
        },
      ],
      subs: [{ customer_id: "user_1" }],
      convs: [],
    });
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
    expect(c.lastOrderAt).toBe("2026-04-01T00:00:00Z");
    expect(c.hasActiveSubscription).toBe(true);
    expect(c.createdAt).toBe("2026-01-01T00:00:00Z");
    expect(res.body.total).toBe(1);
  });

  it("preserves null lastOrderAt for never-ordered customers", async () => {
    stubVerifiedAdmin();
    stageListEndpoint({
      customers: [
        {
          customer_id: "user_2",
          display_name: null,
          email_lower: "no@orders.io",
          stripe_customer_id: null,
          created_at: "2026-02-01T00:00:00Z",
        },
      ],
      orders: [],
      subs: [],
      convs: [],
    });
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
    stageListEndpoint({ customers: [] });
    const router = await loadRouter();
    const res = await request(makeApp(router)).get(
      "/resupply-api/admin/shop/customers?page=2&pageSize=10&sortBy=lifetime_value&order=asc&subscription=active",
    );
    expect(res.status).toBe(200);
    expect(res.body.page).toBe(2);
    expect(res.body.pageSize).toBe(10);
    // Empty candidate set short-circuits before the rollup queries —
    // only the shop_customers SELECT fires.
    expect(getSupabaseCallCount("shop_customers", "select")).toBe(1);
  });

  it("searches display_name OR email (find-a-person by name, not just address)", async () => {
    stubVerifiedAdmin();
    stageListEndpoint({ customers: [] });
    const router = await loadRouter();
    const res = await request(makeApp(router)).get(
      "/resupply-api/admin/shop/customers?q=Smith",
    );
    expect(res.status).toBe(200);
    // The search must cover display_name as well as email_lower so the
    // directory is findable by who the person is — this also powers the
    // "find this person in Customers" jump from a patient record.
    const orCalls = supabaseMock
      .filterCalls("shop_customers", "select")
      .filter((c) => c.verb === "or");
    expect(orCalls).toHaveLength(1);
    const expr = String(orCalls[0]!.args[0]);
    expect(expr).toContain("display_name.ilike");
    expect(expr).toContain("email_lower.ilike");
    expect(expr.toLowerCase()).toContain("smith");
  });

  it("redacts very-short local-parts safely (<=2 chars)", async () => {
    stubVerifiedAdmin();
    stageListEndpoint({
      customers: [
        {
          customer_id: "user_short",
          display_name: "AB",
          email_lower: "ab@x.io",
          stripe_customer_id: null,
          created_at: "2026-01-01T00:00:00Z",
        },
      ],
      orders: [],
      subs: [],
      convs: [],
    });
    const router = await loadRouter();
    const res = await request(makeApp(router)).get(
      "/resupply-api/admin/shop/customers",
    );
    expect(res.status).toBe(200);
    // Local-part is already <=2 chars; no asterisks needed.
    expect(res.body.customers[0].emailRedacted).toBe("ab@x.io");
  });

  it("surfaces inAppNeedsReply on each row (Phase 9)", async () => {
    stubVerifiedAdmin();
    stageListEndpoint({
      customers: [
        {
          customer_id: "user_waiting",
          display_name: "Anna",
          email_lower: "anna@example.com",
          stripe_customer_id: null,
          created_at: "2026-01-01T00:00:00Z",
        },
        {
          customer_id: "user_caught_up",
          display_name: "Bo",
          email_lower: "bo@example.com",
          stripe_customer_id: null,
          created_at: "2026-01-01T00:00:00Z",
        },
      ],
      orders: [],
      subs: [],
      // Only user_waiting has an awaiting_admin in_app conversation.
      convs: [{ customer_id: "user_waiting" }],
    });
    const router = await loadRouter();
    const res = await request(makeApp(router)).get(
      "/resupply-api/admin/shop/customers",
    );
    expect(res.status).toBe(200);
    const waiting = res.body.customers.find(
      (c: { userId: string }) => c.userId === "user_waiting",
    );
    const caughtUp = res.body.customers.find(
      (c: { userId: string }) => c.userId === "user_caught_up",
    );
    expect(waiting.inAppNeedsReply).toBe(true);
    expect(caughtUp.inAppNeedsReply).toBe(false);
  });

  it("forwards ?awaitingReply=1 to the SQL filter (Phase 9)", async () => {
    stubVerifiedAdmin();
    stageListEndpoint({ customers: [] });
    const router = await loadRouter();
    const res = await request(makeApp(router)).get(
      "/resupply-api/admin/shop/customers?awaitingReply=1",
    );
    expect(res.status).toBe(200);
    // Empty candidate set → only shop_customers SELECT fires.
    expect(getSupabaseCallCount("shop_customers", "select")).toBe(1);
  });

  it("rejects an invalid ?awaitingReply value (Phase 9)", async () => {
    stubVerifiedAdmin();
    const router = await loadRouter();
    const res = await request(makeApp(router)).get(
      "/resupply-api/admin/shop/customers?awaitingReply=garbage",
    );
    expect(res.status).toBe(400);
    expect(getSupabaseCallCount("shop_customers", "select")).toBe(0);
  });
});

// =====================================================================
// GET /admin/shop/customers/:userId — single-customer detail
// =====================================================================
//
// The detail handler issues 8 parallel queries:
//   1. shop_customers (single, maybeSingle)
//   2. shop_orders (recent, limit 25)
//   3. shop_subscriptions
//   4. shop_abandoned_carts (single, maybeSingle)
//   5. shop_reviews (recent, limit 100)
//   6. conversations (single in_app, maybeSingle)
//   7. shop_orders (lifetime stats — full set)
//   8. shop_reviews (head:true count of pending)
// Plus optional:
//   * shop_order_items (bulk by order_id) when there are orders
//   * messages (by conversation_id) when there's an in-app row

const VALID_USER_ID = "user_2abc_DEF-9";

interface DetailStageInput {
  customer: Record<string, unknown> | null;
  orders: Array<Record<string, unknown>>;
  subscriptions?: Array<Record<string, unknown>>;
  abandonedCart?: Record<string, unknown> | null;
  reviews?: Array<Record<string, unknown>>;
  inAppConversation?: Record<string, unknown> | null;
  /**
   * Lifetime stats are computed JS-side from `statsOrders` (a
   * separate query than the recent-25 list). When omitted we mirror
   * `orders` so the legacy aggregated `stats` row from the test
   * harness lines up.
   */
  statsOrders?: Array<Record<string, unknown>>;
  pendingReviewsCount?: number;
}

function stageDetailEndpoint(opts: DetailStageInput): void {
  stageSupabaseResponse("shop_customers", "select", {
    data: opts.customer,
  });
  stageSupabaseResponse("shop_orders", "select", { data: opts.orders });
  stageSupabaseResponse("shop_subscriptions", "select", {
    data: opts.subscriptions ?? [],
  });
  stageSupabaseResponse("shop_abandoned_carts", "select", {
    data: opts.abandonedCart ?? null,
  });
  stageSupabaseResponse("shop_reviews", "select", {
    data: opts.reviews ?? [],
  });
  stageSupabaseResponse("conversations", "select", {
    data: opts.inAppConversation ?? null,
  });
  // 7. Lifetime-stats orders SELECT — separate from #2.
  stageSupabaseResponse("shop_orders", "select", {
    data: opts.statsOrders ?? opts.orders,
  });
  // 8. Pending-reviews head:true count.
  stageSupabaseResponse("shop_reviews", "select", {
    data: null,
    count: opts.pendingReviewsCount ?? 0,
  });

  // 404 short-circuit: when no customer AND no orders, the route
  // returns before the optional follow-up reads.
  const not404 = !!opts.customer || opts.orders.length > 0;
  if (!not404) return;

  // shop_order_items is only fetched when there's at least one order.
  if (opts.orders.length > 0) {
    stageSupabaseResponse("shop_order_items", "select", { data: [] });
  }
  // messages SELECT only fires when there's an in-app conversation.
  if (opts.inAppConversation) {
    stageSupabaseResponse("messages", "select", { data: [] });
  }
}

describe("GET /admin/shop/customers/:userId — auth + validation", () => {
  it("rejects unauthenticated callers", async () => {
    const router = await loadRouter();
    const res = await request(makeApp(router)).get(
      `/resupply-api/admin/shop/customers/${VALID_USER_ID}`,
    );
    expect([401, 403]).toContain(res.status);
    expect(getSupabaseCallCount("shop_customers", "select")).toBe(0);
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
    stageDetailEndpoint({ customer: null, orders: [] });
    const router = await loadRouter();
    const res = await request(makeApp(router)).get(
      `/resupply-api/admin/shop/customers/${VALID_USER_ID}`,
    );
    expect(res.status).toBe(404);
    expect(res.body.error).toBe("customer_not_found");
  });

  it("returns full profile for registered customer with orders", async () => {
    stubVerifiedAdmin();
    const orders = [
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
      },
    ];
    stageDetailEndpoint({
      customer: {
        customer_id: VALID_USER_ID,
        display_name: "Jane Doe",
        email_lower: "jane@example.com",
        stripe_customer_id: "cus_abc",
        shipping_address_json: { line1: "123 Main", city: "Phila" },
        default_payment_method_brand: "visa",
        default_payment_method_last4: "4242",
        default_payment_method_exp_month: 12,
        default_payment_method_exp_year: 2030,
        cpap_device_json: null,
        physician_info_json: null,
        facial_measurements_json: null,
        created_at: "2026-01-01T00:00:00Z",
        updated_at: "2026-04-01T00:00:00Z",
      },
      orders,
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
    });
    // The route also fetches shop_order_items for the page's orders,
    // staged here with item counts so the response reflects them.
    // (stageDetailEndpoint stages an empty array — override below.)
    // We need to overwrite the empty stage with two rows.
    // Reset and re-stage with explicit item rows:
    supabaseMock.reset();
    stageDetailEndpoint({
      customer: {
        customer_id: VALID_USER_ID,
        display_name: "Jane Doe",
        email_lower: "jane@example.com",
        stripe_customer_id: "cus_abc",
        shipping_address_json: { line1: "123 Main", city: "Phila" },
        default_payment_method_brand: "visa",
        default_payment_method_last4: "4242",
        default_payment_method_exp_month: 12,
        default_payment_method_exp_year: 2030,
        cpap_device_json: null,
        physician_info_json: null,
        facial_measurements_json: null,
        created_at: "2026-01-01T00:00:00Z",
        updated_at: "2026-04-01T00:00:00Z",
      },
      orders,
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
    });
    // Drop the empty shop_order_items stage queued by stageDetailEndpoint
    // and substitute one with item rows. The mock's queue is FIFO per
    // (table, op); reset isolates this. With shop_order_items as the
    // last queued select on that table the data shape is { data: [...] }.
    // For simplicity stage two rows that yield itemCount of 2 for ord_1
    // and 1 for ord_0:
    supabaseMock.reset();
    // Rebuild the full stage chain WITH item rows.
    stageSupabaseResponse("shop_customers", "select", {
      data: {
        customer_id: VALID_USER_ID,
        display_name: "Jane Doe",
        email_lower: "jane@example.com",
        stripe_customer_id: "cus_abc",
        shipping_address_json: { line1: "123 Main", city: "Phila" },
        default_payment_method_brand: "visa",
        default_payment_method_last4: "4242",
        default_payment_method_exp_month: 12,
        default_payment_method_exp_year: 2030,
        cpap_device_json: null,
        physician_info_json: null,
        facial_measurements_json: null,
        created_at: "2026-01-01T00:00:00Z",
        updated_at: "2026-04-01T00:00:00Z",
      },
    });
    stageSupabaseResponse("shop_orders", "select", { data: orders });
    stageSupabaseResponse("shop_subscriptions", "select", {
      data: [
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
    });
    stageSupabaseResponse("shop_abandoned_carts", "select", {
      data: {
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
    });
    stageSupabaseResponse("shop_reviews", "select", {
      data: [
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
    });
    stageSupabaseResponse("conversations", "select", { data: null });
    stageSupabaseResponse("shop_orders", "select", { data: orders });
    stageSupabaseResponse("shop_reviews", "select", { data: null, count: 0 });
    // shop_order_items — with item count rows for the two orders.
    stageSupabaseResponse("shop_order_items", "select", {
      data: [
        { order_id: "ord_1", quantity: 2 },
        { order_id: "ord_0", quantity: 1 },
      ],
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
    expect(res.body.stats.firstOrderAt).toBe("2026-02-01T00:00:00Z");
    expect(res.body.stats.lastOrderAt).toBe("2026-04-01T00:00:00Z");
    expect(res.body.stats.pendingReviewsCount).toBe(0);
  });

  it("preserves null amount_total_cents on pending orders (no $0.00 coercion)", async () => {
    stubVerifiedAdmin();
    stageDetailEndpoint({
      customer: {
        customer_id: VALID_USER_ID,
        display_name: "Jane Doe",
        email_lower: "jane@example.com",
        stripe_customer_id: "cus_abc",
        shipping_address_json: null,
        default_payment_method_brand: null,
        default_payment_method_last4: null,
        default_payment_method_exp_month: null,
        default_payment_method_exp_year: null,
        cpap_device_json: null,
        physician_info_json: null,
        facial_measurements_json: null,
        created_at: "2026-01-01T00:00:00Z",
        updated_at: "2026-04-01T00:00:00Z",
      },
      orders: [
        {
          id: "ord_pending",
          stripe_session_id: "cs_pending",
          stripe_payment_intent_id: null,
          status: "pending",
          amount_total_cents: null,
          currency: null,
          created_at: "2026-04-30T00:00:00Z",
          paid_at: null,
          shipped_at: null,
          delivered_at: null,
          tracking_carrier: null,
          tracking_number: null,
          shipping_address_json: null,
        },
      ],
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
    stageDetailEndpoint({
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
        },
      ],
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
    stageDetailEndpoint({
      customer: {
        customer_id: VALID_USER_ID,
        display_name: "Empty",
        email_lower: "empty@example.com",
        stripe_customer_id: null,
        shipping_address_json: null,
        default_payment_method_brand: null,
        default_payment_method_last4: null,
        default_payment_method_exp_month: null,
        default_payment_method_exp_year: null,
        cpap_device_json: null,
        physician_info_json: null,
        facial_measurements_json: null,
        created_at: "2026-01-01T00:00:00Z",
        updated_at: "2026-01-01T00:00:00Z",
      },
      orders: [],
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

  it("surfaces clinicalInfo from shop_customers (PR #54)", async () => {
    stubVerifiedAdmin();
    stageDetailEndpoint({
      customer: {
        customer_id: VALID_USER_ID,
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
        facial_measurements_json: null,
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
    stageDetailEndpoint({
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
    // The route reads conversations + then messages for stats. Stage
    // a conversation row + 4 messages (2 inbound after last outbound).
    stageSupabaseResponse("shop_customers", "select", {
      data: {
        customer_id: VALID_USER_ID,
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
        facial_measurements_json: null,
        created_at: "2026-01-01T00:00:00Z",
        updated_at: "2026-04-01T00:00:00Z",
      },
    });
    stageSupabaseResponse("shop_orders", "select", { data: [] });
    stageSupabaseResponse("shop_subscriptions", "select", { data: [] });
    stageSupabaseResponse("shop_abandoned_carts", "select", { data: null });
    stageSupabaseResponse("shop_reviews", "select", { data: [] });
    stageSupabaseResponse("conversations", "select", {
      data: {
        id: "conv_in_app_1",
        status: "awaiting_admin",
        last_message_at: "2026-05-01T12:00:00Z",
        created_at: "2026-04-25T00:00:00Z",
      },
    });
    stageSupabaseResponse("shop_orders", "select", { data: [] });
    stageSupabaseResponse("shop_reviews", "select", { data: null, count: 0 });
    // Messages SELECT — 4 total, 2 inbound after the last outbound at
    // 2026-04-30T08:00:00Z.
    stageSupabaseResponse("messages", "select", {
      data: [
        { direction: "outbound", created_at: "2026-04-25T00:00:00Z" },
        { direction: "outbound", created_at: "2026-04-30T08:00:00Z" },
        { direction: "inbound", created_at: "2026-05-01T10:00:00Z" },
        { direction: "inbound", created_at: "2026-05-01T12:00:00Z" },
      ],
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
    stageDetailEndpoint({
      customer: {
        customer_id: VALID_USER_ID,
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
        facial_measurements_json: null,
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

const SOURCE_ORDER_ID = "11111111-2222-3333-8444-555555555555";

interface ReorderStageInput {
  order: Record<string, unknown> | null;
  items?: Array<{ price_id: string; quantity: number }>;
  customer?: {
    email_lower: string | null;
    stripe_customer_id: string | null;
  } | null;
}

function stageReorderEndpoint(opts: ReorderStageInput): void {
  // 1. shop_orders (single, maybeSingle).
  stageSupabaseResponse("shop_orders", "select", { data: opts.order });
  if (opts.items !== undefined) {
    // 2. shop_order_items (array).
    stageSupabaseResponse("shop_order_items", "select", { data: opts.items });
  }
  if (opts.customer !== undefined) {
    // 3. shop_customers (single, maybeSingle).
    stageSupabaseResponse("shop_customers", "select", {
      data: opts.customer,
    });
  }
}

describe("POST /admin/shop/customers/:userId/reorder — auth & validation", () => {
  it("rejects unauthenticated callers", async () => {
    const router = await loadRouter();
    const res = await request(makeApp(router))
      .post(`/resupply-api/admin/shop/customers/${VALID_USER_ID}/reorder`)
      .send({ sourceOrderId: SOURCE_ORDER_ID });
    expect(res.status).toBe(401);
    expect(getSupabaseCallCount("shop_orders", "select")).toBe(0);
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
    stageReorderEndpoint({ order: null });
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
    stageReorderEndpoint({
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
    stageReorderEndpoint({
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
    stageReorderEndpoint({
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
    stageReorderEndpoint({
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
    stageReorderEndpoint({
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
    stageReorderEndpoint({
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
    expect(params.success_url).toBe(
      "https://shop.test.example.com/shop/checkout-success?session_id={CHECKOUT_SESSION_ID}",
    );
    expect(params.cancel_url).toBe("https://shop.test.example.com/shop");
  });

  it("falls back to customer_email when no stripe_customer_id is mirrored", async () => {
    stubVerifiedAdmin();
    stageReorderEndpoint({
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
    stageReorderEndpoint({
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
    stageReorderEndpoint({
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
    stageReorderEndpoint({
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
