// Route tests for routes/shop/my-subscriptions.ts.
//
// Coverage matrix (T-C5 endpoints + a smoke test for the
// pre-existing GET / cancel paths so we'd notice if they regress):
//
//   POST /pause
//     - 401 unsigned
//     - 400 missing_subscription_id (empty path segment)
//     - 404 not_found / wrong owner
//     - 409 subscription_canceled
//     - 503 stripe_unavailable when config missing
//     - 502 stripe_update_failed when SDK throws
//     - 200 happy path: stripe.subscriptions.update called with the
//       documented `pause_collection: { behavior: 'void' }` payload
//
//   POST /resume
//     - 200 happy path: stripe.subscriptions.update called with the
//       empty-string clear payload
//     - 409 subscription_canceled (shared guard, single test is
//       enough — the rest of the auth/ownership matrix is already
//       exercised by /pause via the same helper)
//
//   POST /cadence
//     - 401 unsigned
//     - 400 invalid body (missing priceId)
//     - 404 not_found
//     - 409 subscription_canceled
//     - 409 multi_item_subscription
//     - 200 unchanged: true when the new priceId equals the current
//     - 400 invalid_price when prices.retrieve throws
//     - 400 price_not_recurring when type is one_time
//     - 400 price_product_mismatch when product differs
//     - 502 stripe_fetch_failed when subscriptions.retrieve throws
//     - 200 happy path: subscriptions.update called with
//       items: [{ id: 'si_xxx', price: NEW }], proration_behavior: 'none'
//
//   GET / — smoke: 401 unsigned, 200 with rows
//   POST /cancel — smoke: 200 happy path still wires through
//
// Mocking strategy mirrors my-orders.test.ts: drizzle is replaced
// with a fluent stub backed by `selectQueue` / `updateQueue`; Stripe
// is mocked at the lib/stripe/config layer; requireSignedIn is mocked
// via test-helpers/auth-mocks. We DON'T import a real Stripe SDK; the
// mock hands back plain objects shaped like the SDK responses we read.

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

// Drizzle stub. Two query shapes used by this router:
//   1. SELECT → .from() → .where() → .orderBy()? → .limit() → Promise<rows>
//   2. UPDATE → .set() → .where() → Promise<...>
const selectQueue: unknown[][] = [];
const dbStub = {
  select: vi.fn(() => {
    const result = selectQueue.shift() ?? [];
    const obj: Record<string, unknown> = {
      from: () => obj,
      where: () => obj,
      orderBy: () => obj,
      limit: () => Promise.resolve(result),
    };
    return obj;
  }),
  update: vi.fn(() => {
    const obj: Record<string, unknown> = {
      set: () => obj,
      where: () => Promise.resolve(undefined),
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

const stripeSubscriptionsUpdateMock = vi.fn();
const stripeSubscriptionsRetrieveMock = vi.fn();
const stripePricesRetrieveMock = vi.fn();
const stripePricesListMock = vi.fn();
let stripeConfigured = true;
vi.mock("../../lib/stripe/config", () => ({
  readStripeConfigOrNull: () =>
    stripeConfigured ? { secretKey: "sk_test_x" } : null,
  getStripeClient: () => ({
    subscriptions: {
      update: (...a: unknown[]) => stripeSubscriptionsUpdateMock(...a),
      retrieve: (...a: unknown[]) =>
        stripeSubscriptionsRetrieveMock(...a),
    },
    prices: {
      retrieve: (...a: unknown[]) => stripePricesRetrieveMock(...a),
      list: (...a: unknown[]) => stripePricesListMock(...a),
    },
  }),
}));

import myySubsRouter from "./my-subscriptions";

const VALID_ID = "11111111-2222-3333-4444-555555555555";
const USER_ID = "user_alice";
const STRIPE_SUB_ID = "sub_test_1";
const STRIPE_ITEM_ID = "si_test_1";
const STRIPE_PRODUCT_ID = "prod_test_1";
const CURRENT_PRICE_ID = "price_30day";
const NEW_PRICE_ID = "price_60day";

function makeApp(): Express {
  const app = express();
  // The rate-limit middleware is closure-scoped per `rateLimit()`
  // call, but the router is imported once at the top of this test
  // file. To avoid one test exhausting another's quota we trust
  // X-Forwarded-For and stamp a unique IP per request below.
  app.set("trust proxy", true);
  app.use(express.json());
  app.use("/resupply-api", myySubsRouter);
  return app;
}

// Counter for synthesising unique X-Forwarded-For per request. Each
// test (or each request within a test) gets its own bucket so the
// in-process rate limiter doesn't cross-contaminate.
let ipCounter = 0;
function uniqueIp(): string {
  ipCounter += 1;
  return `10.${(ipCounter >> 16) & 0xff}.${(ipCounter >> 8) & 0xff}.${ipCounter & 0xff}`;
}
function post(app: Express, path: string) {
  return request(app).post(path).set("X-Forwarded-For", uniqueIp());
}
function get(app: Express, path: string) {
  return request(app).get(path).set("X-Forwarded-For", uniqueIp());
}

function stubSignedIn(userId: string): void {
  mockSignedIn.current = userId;
}

function activeSubRow(over: Partial<Record<string, unknown>> = {}): Record<
  string,
  unknown
> {
  return {
    id: VALID_ID,
    stripeSubscriptionId: STRIPE_SUB_ID,
    status: "active",
    cancelAtPeriodEnd: false,
    items: [
      {
        priceId: CURRENT_PRICE_ID,
        productId: STRIPE_PRODUCT_ID,
        quantity: 1,
        name: "Resupply Pack",
        unitAmountCents: 4998,
        currency: "usd",
        intervalLabel: "30 days",
      },
    ],
    ...over,
  };
}

beforeEach(() => {
  selectQueue.length = 0;
  stripeConfigured = true;
  mockSignedIn.current = null;
  dbStub.select.mockClear();
  dbStub.update.mockClear();
  stripeSubscriptionsUpdateMock.mockReset();
  stripeSubscriptionsRetrieveMock.mockReset();
  stripePricesRetrieveMock.mockReset();
  stripePricesListMock.mockReset();
});

afterEach(() => {
  selectQueue.length = 0;
});

// ---------- POST /pause ----------

describe("POST /shop/me/subscriptions/:id/pause", () => {
  it("401 when unsigned", async () => {
    const r = await post(makeApp(), `/resupply-api/me/subscriptions/${VALID_ID}/pause`)
      .send({});
    expect(r.status).toBe(401);
    expect(r.body.error).toBe("sign_in_required");
  });

  it("404 when not owned (no row matches id+customerId)", async () => {
    stubSignedIn(USER_ID);
    selectQueue.push([]); // owner lookup returns nothing
    const r = await post(makeApp(), `/resupply-api/me/subscriptions/${VALID_ID}/pause`)
      .send({});
    expect(r.status).toBe(404);
    expect(r.body.error).toBe("subscription_not_found");
    expect(stripeSubscriptionsUpdateMock).not.toHaveBeenCalled();
  });

  it("409 when subscription is canceled", async () => {
    stubSignedIn(USER_ID);
    selectQueue.push([activeSubRow({ status: "canceled" })]);
    const r = await post(makeApp(), `/resupply-api/me/subscriptions/${VALID_ID}/pause`)
      .send({});
    expect(r.status).toBe(409);
    expect(r.body.error).toBe("subscription_canceled");
    expect(stripeSubscriptionsUpdateMock).not.toHaveBeenCalled();
  });

  it("503 when stripe is not configured", async () => {
    stubSignedIn(USER_ID);
    selectQueue.push([activeSubRow()]);
    stripeConfigured = false;
    const r = await post(makeApp(), `/resupply-api/me/subscriptions/${VALID_ID}/pause`)
      .send({});
    expect(r.status).toBe(503);
    expect(r.body.error).toBe("shop_unavailable");
  });

  it("502 when stripe SDK throws", async () => {
    stubSignedIn(USER_ID);
    selectQueue.push([activeSubRow()]);
    stripeSubscriptionsUpdateMock.mockRejectedValueOnce(
      new Error("network blip"),
    );
    const r = await post(makeApp(), `/resupply-api/me/subscriptions/${VALID_ID}/pause`)
      .send({});
    expect(r.status).toBe(502);
    expect(r.body.error).toBe("stripe_update_failed");
  });

  it("200 happy path sends pause_collection: { behavior: 'void' }", async () => {
    stubSignedIn(USER_ID);
    selectQueue.push([activeSubRow()]);
    stripeSubscriptionsUpdateMock.mockResolvedValueOnce({
      id: STRIPE_SUB_ID,
    });
    const r = await post(makeApp(), `/resupply-api/me/subscriptions/${VALID_ID}/pause`)
      .send({});
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ ok: true });
    expect(stripeSubscriptionsUpdateMock).toHaveBeenCalledTimes(1);
    expect(stripeSubscriptionsUpdateMock).toHaveBeenCalledWith(
      STRIPE_SUB_ID,
      { pause_collection: { behavior: "void" } },
    );
  });
});

// ---------- POST /resume ----------

describe("POST /shop/me/subscriptions/:id/resume", () => {
  it("200 happy path sends pause_collection: '' (clear)", async () => {
    stubSignedIn(USER_ID);
    selectQueue.push([activeSubRow()]);
    stripeSubscriptionsUpdateMock.mockResolvedValueOnce({
      id: STRIPE_SUB_ID,
    });
    const r = await post(makeApp(), `/resupply-api/me/subscriptions/${VALID_ID}/resume`)
      .send({});
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ ok: true });
    expect(stripeSubscriptionsUpdateMock).toHaveBeenCalledWith(
      STRIPE_SUB_ID,
      { pause_collection: "" },
    );
  });

  it("409 when subscription is canceled (shared guard)", async () => {
    stubSignedIn(USER_ID);
    selectQueue.push([activeSubRow({ status: "canceled" })]);
    const r = await post(makeApp(), `/resupply-api/me/subscriptions/${VALID_ID}/resume`)
      .send({});
    expect(r.status).toBe(409);
    expect(r.body.error).toBe("subscription_canceled");
    expect(stripeSubscriptionsUpdateMock).not.toHaveBeenCalled();
  });
});

// ---------- POST /cadence ----------

describe("POST /shop/me/subscriptions/:id/cadence", () => {
  it("401 when unsigned", async () => {
    const r = await post(makeApp(), `/resupply-api/me/subscriptions/${VALID_ID}/cadence`)
      .send({ priceId: NEW_PRICE_ID });
    expect(r.status).toBe(401);
  });

  it("400 when body is missing priceId", async () => {
    stubSignedIn(USER_ID);
    const r = await post(makeApp(), `/resupply-api/me/subscriptions/${VALID_ID}/cadence`)
      .send({});
    expect(r.status).toBe(400);
    expect(r.body.error).toBe("invalid_body");
  });

  it("404 when not owned", async () => {
    stubSignedIn(USER_ID);
    selectQueue.push([]);
    const r = await post(makeApp(), `/resupply-api/me/subscriptions/${VALID_ID}/cadence`)
      .send({ priceId: NEW_PRICE_ID });
    expect(r.status).toBe(404);
  });

  it("409 when subscription is canceled", async () => {
    stubSignedIn(USER_ID);
    selectQueue.push([activeSubRow({ status: "canceled" })]);
    const r = await post(makeApp(), `/resupply-api/me/subscriptions/${VALID_ID}/cadence`)
      .send({ priceId: NEW_PRICE_ID });
    expect(r.status).toBe(409);
    expect(r.body.error).toBe("subscription_canceled");
  });

  it("409 multi_item_subscription when local snapshot has 2 items", async () => {
    stubSignedIn(USER_ID);
    selectQueue.push([
      activeSubRow({
        items: [
          {
            priceId: CURRENT_PRICE_ID,
            productId: STRIPE_PRODUCT_ID,
            quantity: 1,
            name: null,
            unitAmountCents: null,
            currency: null,
            intervalLabel: null,
          },
          {
            priceId: "price_other",
            productId: "prod_other",
            quantity: 1,
            name: null,
            unitAmountCents: null,
            currency: null,
            intervalLabel: null,
          },
        ],
      }),
    ]);
    const r = await post(makeApp(), `/resupply-api/me/subscriptions/${VALID_ID}/cadence`)
      .send({ priceId: NEW_PRICE_ID });
    expect(r.status).toBe(409);
    expect(r.body.error).toBe("multi_item_subscription");
  });

  it("200 unchanged: true when new priceId equals current", async () => {
    stubSignedIn(USER_ID);
    selectQueue.push([activeSubRow()]);
    const r = await post(makeApp(), `/resupply-api/me/subscriptions/${VALID_ID}/cadence`)
      .send({ priceId: CURRENT_PRICE_ID });
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ ok: true, unchanged: true });
    expect(stripePricesRetrieveMock).not.toHaveBeenCalled();
  });

  it("400 invalid_price when prices.retrieve throws", async () => {
    stubSignedIn(USER_ID);
    selectQueue.push([activeSubRow()]);
    stripePricesRetrieveMock.mockRejectedValueOnce(
      new Error("no such price"),
    );
    const r = await post(makeApp(), `/resupply-api/me/subscriptions/${VALID_ID}/cadence`)
      .send({ priceId: NEW_PRICE_ID });
    expect(r.status).toBe(400);
    expect(r.body.error).toBe("invalid_price");
  });

  it("400 price_not_recurring when type is one_time", async () => {
    stubSignedIn(USER_ID);
    selectQueue.push([activeSubRow()]);
    stripePricesRetrieveMock.mockResolvedValueOnce({
      id: NEW_PRICE_ID,
      type: "one_time",
      recurring: null,
      product: STRIPE_PRODUCT_ID,
    });
    const r = await post(makeApp(), `/resupply-api/me/subscriptions/${VALID_ID}/cadence`)
      .send({ priceId: NEW_PRICE_ID });
    expect(r.status).toBe(400);
    expect(r.body.error).toBe("price_not_recurring");
  });

  it("400 price_product_mismatch when target price is on a different product", async () => {
    stubSignedIn(USER_ID);
    selectQueue.push([activeSubRow()]);
    stripePricesRetrieveMock.mockResolvedValueOnce({
      id: NEW_PRICE_ID,
      type: "recurring",
      recurring: { interval: "day", interval_count: 60 },
      product: "prod_other",
    });
    const r = await post(makeApp(), `/resupply-api/me/subscriptions/${VALID_ID}/cadence`)
      .send({ priceId: NEW_PRICE_ID });
    expect(r.status).toBe(400);
    expect(r.body.error).toBe("price_product_mismatch");
  });

  it("502 when subscriptions.retrieve throws", async () => {
    stubSignedIn(USER_ID);
    selectQueue.push([activeSubRow()]);
    stripePricesRetrieveMock.mockResolvedValueOnce({
      id: NEW_PRICE_ID,
      type: "recurring",
      recurring: { interval: "day", interval_count: 60 },
      product: STRIPE_PRODUCT_ID,
    });
    stripeSubscriptionsRetrieveMock.mockRejectedValueOnce(
      new Error("network blip"),
    );
    const r = await post(makeApp(), `/resupply-api/me/subscriptions/${VALID_ID}/cadence`)
      .send({ priceId: NEW_PRICE_ID });
    expect(r.status).toBe(502);
    expect(r.body.error).toBe("stripe_fetch_failed");
  });

  it("200 happy path swaps the item with proration_behavior: 'none'", async () => {
    stubSignedIn(USER_ID);
    selectQueue.push([activeSubRow()]);
    stripePricesRetrieveMock.mockResolvedValueOnce({
      id: NEW_PRICE_ID,
      type: "recurring",
      recurring: { interval: "day", interval_count: 60 },
      product: STRIPE_PRODUCT_ID,
    });
    stripeSubscriptionsRetrieveMock.mockResolvedValueOnce({
      id: STRIPE_SUB_ID,
      items: { data: [{ id: STRIPE_ITEM_ID, price: { id: CURRENT_PRICE_ID } }] },
    });
    stripeSubscriptionsUpdateMock.mockResolvedValueOnce({
      id: STRIPE_SUB_ID,
    });
    const r = await post(makeApp(), `/resupply-api/me/subscriptions/${VALID_ID}/cadence`)
      .send({ priceId: NEW_PRICE_ID });
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ ok: true });
    expect(stripeSubscriptionsUpdateMock).toHaveBeenCalledWith(
      STRIPE_SUB_ID,
      {
        items: [{ id: STRIPE_ITEM_ID, price: NEW_PRICE_ID }],
        proration_behavior: "none",
      },
    );
  });
});

// ---------- GET /cadence-options ----------

describe("GET /shop/me/subscriptions/:id/cadence-options", () => {
  it("401 when unsigned", async () => {
    const r = await get(
      makeApp(),
      `/resupply-api/me/subscriptions/${VALID_ID}/cadence-options`,
    );
    expect(r.status).toBe(401);
  });

  it("404 when not owned", async () => {
    stubSignedIn(USER_ID);
    selectQueue.push([]);
    const r = await get(
      makeApp(),
      `/resupply-api/me/subscriptions/${VALID_ID}/cadence-options`,
    );
    expect(r.status).toBe(404);
    expect(stripePricesListMock).not.toHaveBeenCalled();
  });

  it("409 multi_item_subscription", async () => {
    stubSignedIn(USER_ID);
    selectQueue.push([
      activeSubRow({
        items: [
          {
            priceId: CURRENT_PRICE_ID,
            productId: STRIPE_PRODUCT_ID,
            quantity: 1,
            name: null,
            unitAmountCents: null,
            currency: null,
            intervalLabel: null,
          },
          {
            priceId: "price_other",
            productId: "prod_other",
            quantity: 1,
            name: null,
            unitAmountCents: null,
            currency: null,
            intervalLabel: null,
          },
        ],
      }),
    ]);
    const r = await get(
      makeApp(),
      `/resupply-api/me/subscriptions/${VALID_ID}/cadence-options`,
    );
    expect(r.status).toBe(409);
  });

  it("200 with sorted options + isCurrent flag on the matching price", async () => {
    stubSignedIn(USER_ID);
    selectQueue.push([activeSubRow()]);
    // Return prices in INTENTIONALLY UNSORTED order; assert the
    // server sorts by interval-in-days ascending (30 → 60 → 90).
    stripePricesListMock.mockResolvedValueOnce({
      data: [
        {
          id: "price_90day",
          recurring: { interval: "day", interval_count: 90 },
          unit_amount: 12999,
          currency: "usd",
        },
        {
          id: CURRENT_PRICE_ID, // 30 days
          recurring: { interval: "day", interval_count: 30 },
          unit_amount: 4998,
          currency: "usd",
        },
        {
          id: "price_60day",
          recurring: { interval: "day", interval_count: 60 },
          unit_amount: 8999,
          currency: "usd",
        },
      ],
    });
    const r = await get(
      makeApp(),
      `/resupply-api/me/subscriptions/${VALID_ID}/cadence-options`,
    );
    expect(r.status).toBe(200);
    expect(r.body.options).toEqual([
      {
        priceId: CURRENT_PRICE_ID,
        intervalLabel: "30 days",
        unitAmountCents: 4998,
        currency: "usd",
        isCurrent: true,
      },
      {
        priceId: "price_60day",
        intervalLabel: "60 days",
        unitAmountCents: 8999,
        currency: "usd",
        isCurrent: false,
      },
      {
        priceId: "price_90day",
        intervalLabel: "90 days",
        unitAmountCents: 12999,
        currency: "usd",
        isCurrent: false,
      },
    ]);
    // Internal `_sortDays` field should NOT leak to the client.
    for (const opt of r.body.options) {
      expect(opt).not.toHaveProperty("_sortDays");
    }
  });

  it("200 with empty options when stripe.prices.list throws (degrades gracefully)", async () => {
    stubSignedIn(USER_ID);
    selectQueue.push([activeSubRow()]);
    stripePricesListMock.mockRejectedValueOnce(new Error("network blip"));
    const r = await get(
      makeApp(),
      `/resupply-api/me/subscriptions/${VALID_ID}/cadence-options`,
    );
    expect(r.status).toBe(200);
    expect(r.body.options).toEqual([]);
  });
});

// ---------- Smoke: GET / and POST /cancel still work ----------

describe("GET /shop/me/subscriptions (smoke)", () => {
  it("401 when unsigned", async () => {
    const r = await get(makeApp(), "/resupply-api/me/subscriptions");
    expect(r.status).toBe(401);
  });

  it("200 with rows projected", async () => {
    stubSignedIn(USER_ID);
    selectQueue.push([
      {
        id: VALID_ID,
        stripeSubscriptionId: STRIPE_SUB_ID,
        status: "active",
        items: [],
        currentPeriodEnd: new Date("2026-06-14T00:00:00Z"),
        cancelAtPeriodEnd: false,
        canceledAt: null,
        createdAt: new Date("2026-04-01T00:00:00Z"),
      },
    ]);
    const r = await get(makeApp(), "/resupply-api/me/subscriptions");
    expect(r.status).toBe(200);
    expect(r.body.subscriptions).toHaveLength(1);
    expect(r.body.subscriptions[0].id).toBe(VALID_ID);
    expect(r.body.subscriptions[0].currentPeriodEnd).toBe(
      "2026-06-14T00:00:00.000Z",
    );
  });
});

describe("POST /shop/me/subscriptions/:id/cancel (smoke)", () => {
  it("200 happy path flips cancel_at_period_end on Stripe", async () => {
    stubSignedIn(USER_ID);
    // cancel does its own SELECT (not via findOwnedSubscription)
    selectQueue.push([
      {
        id: VALID_ID,
        stripeSubscriptionId: STRIPE_SUB_ID,
        status: "active",
        cancelAtPeriodEnd: false,
      },
    ]);
    stripeSubscriptionsUpdateMock.mockResolvedValueOnce({
      id: STRIPE_SUB_ID,
    });
    const r = await post(makeApp(), `/resupply-api/me/subscriptions/${VALID_ID}/cancel`)
      .send({});
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ ok: true });
    expect(stripeSubscriptionsUpdateMock).toHaveBeenCalledWith(
      STRIPE_SUB_ID,
      { cancel_at_period_end: true },
    );
  });
});
