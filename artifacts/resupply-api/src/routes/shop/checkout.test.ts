// Tests for POST /shop/checkout — the public Stripe Hosted Checkout
// session creator. This is the cash-pay "money path": it assembles
// line items, creates a Stripe Session, and mirrors the order into
// shop_orders. It had no test despite being 400+ lines.
//
// Coverage:
//   1. 503 when the storefront.checkout feature flag is off
//   2. 503 when Stripe is not configured
//   3. 400 on an invalid body (empty items / non-price priceId)
//   4. 401 sign_in_required for subscription mode without a session
//   5. Happy path (guest, one-time): payment-mode Session created,
//      { sessionId, url } returned, shop_orders mirrored as `pending`,
//      and — the CLAUDE.md "no order request bodies in logs" invariant —
//      NOTHING is logged on the success path.
//   6. 400 cart_invalid when the catalog guard rejects the cart
//   7. 502 when stripe.checkout.sessions.create throws
//   8. 502 when the created Session has no url
//   9. Subscription happy path (signed-in): mode "subscription",
//      customer attached, subscription_data carries customer_id
//  10. 503 stripe_customer_unavailable when subscription mode can't
//      attach a Stripe customer

import { beforeEach, describe, expect, it, vi } from "vitest";
import express, {
  type Express,
  type NextFunction,
  type Request,
} from "express";
import request from "supertest";

import {
  makeRequireSignedInMock,
  type MockSignedInProfile,
  type MockSignedInRef,
} from "../../test-helpers/auth-mocks";
import {
  installSupabaseMock,
  getSupabaseCallCount,
  getSupabaseWritePayloads,
  stageSupabaseResponse,
} from "../../test-helpers/supabase-mock";

// ── Supabase mock ─────────────────────────────────────────────────────────────
const supabaseMock = installSupabaseMock();

// ── Auth mock (attachSignedIn is the soft variant checkout.ts uses) ───────────
const { mockSignedIn } = vi.hoisted(() => ({
  mockSignedIn: { current: null as string | MockSignedInProfile | null },
}));
vi.mock("../../middlewares/requireSignedIn", () =>
  makeRequireSignedInMock(mockSignedIn as MockSignedInRef),
);

// ── Rate-limit: always pass-through ──────────────────────────────────────────
vi.mock("../../middlewares/rate-limit", () => ({
  rateLimit: () => (_req: unknown, _res: unknown, next: () => void) => next(),
}));

// ── Stripe config + client mocks ──────────────────────────────────────────────
const readStripeConfigOrNullMock = vi.fn();
const getStripeClientMock = vi.fn();
const getOrCreateStripeCustomerMock = vi.fn();

vi.mock("../../lib/stripe/config", () => ({
  readStripeConfigOrNull: () => readStripeConfigOrNullMock(),
  getStripeClient: (...args: unknown[]) => getStripeClientMock(...args),
  SHOP_UNAVAILABLE_BODY: {
    error: "shop_unavailable",
    message: "The shop isn't configured in this environment yet.",
  },
}));

vi.mock("../../lib/stripe/customer", () => ({
  getOrCreateStripeCustomer: (...args: unknown[]) =>
    getOrCreateStripeCustomerMock(...args),
}));

// ── Cart validation mock ──────────────────────────────────────────────────────
const validateCartItemsMock = vi.fn();
vi.mock("../../lib/stripe/validate-cart", () => ({
  validateCartItems: (...args: unknown[]) => validateCartItemsMock(...args),
}));

// ── Inventory reservation mock ────────────────────────────────────────────────
// The route calls reserveCartInventory after validateCart passes. We mock the
// whole helper so tests never hit Stripe/DB for reservations; the default is a
// no-op success (ok:true, no ids), and individual tests override it.
const reserveCartInventoryMock = vi.fn();
const attachSessionToReservationsMock = vi.fn();
const releaseReservationIdsMock = vi.fn();
vi.mock("../../lib/inventory/reservations", () => ({
  reserveCartInventory: (...args: unknown[]) =>
    reserveCartInventoryMock(...args),
  attachSessionToReservations: (...args: unknown[]) =>
    attachSessionToReservationsMock(...args),
  releaseReservationIds: (...args: unknown[]) =>
    releaseReservationIdsMock(...args),
  // The route reads this constant to pin the Stripe Session expires_at to the
  // hold TTL; provide it so the named import resolves under the mock.
  DEFAULT_RESERVATION_TTL_MS: 23 * 60 * 60 * 1000,
}));

// ── Customer profile mock (read only when signed in) ──────────────────────────
const readCustomerProfileMock = vi.fn();
vi.mock("../../lib/customer-profile", () => ({
  readCustomerProfile: (...args: unknown[]) => readCustomerProfileMock(...args),
}));

// ── storefront.checkout feature flag ──────────────────────────────────────────
const featureEnabled = vi.hoisted(() => ({ value: true }));
vi.mock("../../lib/feature-flags", () => ({
  isFeatureEnabled: vi.fn(async () => featureEnabled.value),
}));

import checkoutRouter from "./checkout";

// ── Constants ─────────────────────────────────────────────────────────────────
const CUSTOMER_A = "cust_aaaa0001";
const STRIPE_CUSTOMER_ID = "cus_stripe_test_123";
const SESSION_URL = "https://checkout.stripe.com/c/test_session";
const SESSION_ID = "cs_test_session_abc123";
const PRICE_ID = "price_abc123xyzabc";

const VALID_STRIPE_CONFIG = {
  secretKey: "sk_test_xxx",
  publishableKey: "pk_test_xxx",
  webhookSigningSecret: null,
  publicBaseUrl: "https://shop.example.com",
};

const ONE_ITEM = [{ priceId: PRICE_ID, quantity: 2 }];

let sessionCreateMock: ReturnType<typeof vi.fn>;
// Per-request log spy injected as req.log (checkout.ts logs via the
// pino-http per-request logger, not the module logger).
const reqLog = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };

function makeApp(): Express {
  const app = express();
  app.use(express.json());
  app.use((req: Request, _res, next: NextFunction) => {
    (req as unknown as { log: typeof reqLog }).log = reqLog;
    next();
  });
  app.use(checkoutRouter);
  return app;
}

function stubSignedIn(customerId = CUSTOMER_A): void {
  mockSignedIn.current = {
    customerId,
    email: "alice@example.com",
    displayName: "Alice",
  };
  readCustomerProfileMock.mockResolvedValue({
    email: "alice@example.com",
    displayName: "Alice",
  });
}

function stubStripeConfigured(): void {
  readStripeConfigOrNullMock.mockReturnValue(VALID_STRIPE_CONFIG);
  getOrCreateStripeCustomerMock.mockResolvedValue({
    stripeCustomerId: STRIPE_CUSTOMER_ID,
  });
  sessionCreateMock = vi
    .fn()
    .mockResolvedValue({ id: SESSION_ID, url: SESSION_URL });
  getStripeClientMock.mockReturnValue({
    checkout: { sessions: { create: sessionCreateMock } },
  });
}

function stubCartValid(): void {
  validateCartItemsMock.mockResolvedValue({ ok: true });
}

beforeEach(() => {
  mockSignedIn.current = null;
  featureEnabled.value = true;
  supabaseMock.reset();
  readStripeConfigOrNullMock.mockReset();
  getStripeClientMock.mockReset();
  getOrCreateStripeCustomerMock.mockReset();
  validateCartItemsMock.mockReset();
  readCustomerProfileMock.mockReset();
  reserveCartInventoryMock.mockReset();
  attachSessionToReservationsMock.mockReset();
  releaseReservationIdsMock.mockReset();
  // Default: reservation succeeds with no holds (the common path; tests that
  // exercise the oversell branch override this).
  reserveCartInventoryMock.mockResolvedValue({ ok: true, reservationIds: [] });
  attachSessionToReservationsMock.mockResolvedValue(undefined);
  releaseReservationIdsMock.mockResolvedValue(undefined);
  reqLog.info.mockReset();
  reqLog.warn.mockReset();
  reqLog.error.mockReset();
});

describe("POST /shop/checkout — guards", () => {
  it("returns 503 when the storefront.checkout flag is off", async () => {
    featureEnabled.value = false;
    const res = await request(makeApp())
      .post("/shop/checkout")
      .send({ items: ONE_ITEM });
    expect(res.status).toBe(503);
    expect(res.body.error).toBe("checkout_disabled");
  });

  it("returns 503 when Stripe is not configured", async () => {
    readStripeConfigOrNullMock.mockReturnValue(null);
    const res = await request(makeApp())
      .post("/shop/checkout")
      .send({ items: ONE_ITEM });
    expect(res.status).toBe(503);
    expect(res.body.error).toBe("shop_unavailable");
  });

  it("returns 400 when the items array is empty", async () => {
    stubStripeConfigured();
    const res = await request(makeApp())
      .post("/shop/checkout")
      .send({ items: [] });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_body");
  });

  it("returns 400 when a priceId is not a Stripe price id", async () => {
    stubStripeConfigured();
    const res = await request(makeApp())
      .post("/shop/checkout")
      .send({ items: [{ priceId: "prod_not_a_price", quantity: 1 }] });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_body");
  });

  it("returns 401 sign_in_required for subscription mode without a session", async () => {
    stubStripeConfigured();
    stubCartValid();
    const res = await request(makeApp())
      .post("/shop/checkout")
      .send({
        items: [{ priceId: PRICE_ID, quantity: 1, mode: "subscription" }],
      });
    expect(res.status).toBe(401);
    expect(res.body.error).toBe("sign_in_required");
  });
});

describe("POST /shop/checkout — one-time happy path (guest)", () => {
  it("creates a payment-mode Session, returns { sessionId, url }, mirrors shop_orders, logs nothing", async () => {
    stubStripeConfigured();
    stubCartValid();

    const res = await request(makeApp())
      .post("/shop/checkout")
      .send({ items: ONE_ITEM });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ sessionId: SESSION_ID, url: SESSION_URL });

    // Stripe Session created in payment mode with the cart's line items.
    expect(sessionCreateMock).toHaveBeenCalledTimes(1);
    const [params, opts] = sessionCreateMock.mock.calls[0]!;
    expect(params.mode).toBe("payment");
    expect(params.line_items).toEqual([{ price: PRICE_ID, quantity: 2 }]);
    expect(params.success_url).toContain(
      "https://shop.example.com/shop/checkout-success",
    );
    // A server-derived idempotency key is forwarded.
    expect(typeof opts.idempotencyKey).toBe("string");
    expect(opts.idempotencyKey.length).toBeGreaterThan(0);

    // shop_orders mirrored as a fresh pending row (insert-or-ignore).
    expect(getSupabaseCallCount("shop_orders", "upsert")).toBe(1);
    const [payload] = getSupabaseWritePayloads(
      "shop_orders",
      "upsert",
    ) as Array<{
      stripe_session_id: string;
      status: string;
    }>;
    expect(payload.stripe_session_id).toBe(SESSION_ID);
    expect(payload.status).toBe("pending");

    // CLAUDE.md hard rule: order request bodies are PHI — the success
    // path must not log them. The happy path logs nothing at all.
    expect(reqLog.info).not.toHaveBeenCalled();
    expect(reqLog.warn).not.toHaveBeenCalled();
    expect(reqLog.error).not.toHaveBeenCalled();
  });
});

describe("POST /shop/checkout — failure modes", () => {
  it("returns 400 cart_invalid when the catalog guard rejects the cart", async () => {
    stubStripeConfigured();
    validateCartItemsMock.mockResolvedValue({
      ok: false,
      errors: [
        { priceId: PRICE_ID, reason: "out_of_stock", message: "Out of stock" },
      ],
    });

    const res = await request(makeApp())
      .post("/shop/checkout")
      .send({ items: ONE_ITEM });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("cart_invalid");
    expect(sessionCreateMock).not.toHaveBeenCalled();
  });

  it("returns 409 out_of_stock when the reservation guard reports oversold", async () => {
    stubStripeConfigured();
    stubCartValid();
    // validateCart passed (cart-time stock was fine), but a concurrent buyer
    // already reserved the last unit — the reservation RPC refuses.
    reserveCartInventoryMock.mockResolvedValue({
      ok: false,
      oversoldProductId: "prod_xyz",
    });

    const res = await request(makeApp())
      .post("/shop/checkout")
      .send({ items: ONE_ITEM });
    expect(res.status).toBe(409);
    expect(res.body.error).toBe("out_of_stock");
    // No Stripe session is created and no order is mirrored on an oversell.
    expect(sessionCreateMock).not.toHaveBeenCalled();
    expect(getSupabaseCallCount("shop_orders", "upsert")).toBe(0);
  });

  it("releases held reservations when stripe.checkout.sessions.create throws", async () => {
    stubStripeConfigured();
    stubCartValid();
    // The reservation succeeded and produced holds; the session creation then
    // fails, so the holds must be released so the stock doesn't leak.
    reserveCartInventoryMock.mockResolvedValue({
      ok: true,
      reservationIds: ["res_1", "res_2"],
    });
    sessionCreateMock.mockRejectedValue(new Error("stripe down"));

    const res = await request(makeApp())
      .post("/shop/checkout")
      .send({ items: ONE_ITEM });
    expect(res.status).toBe(502);
    expect(res.body.error).toBe("stripe_create_failed");
    // The held reservations were released by id (no session id existed yet).
    expect(releaseReservationIdsMock).toHaveBeenCalledTimes(1);
    const [, ids] = releaseReservationIdsMock.mock.calls[0]!;
    expect(ids).toEqual(["res_1", "res_2"]);
  });

  it("returns 502 when stripe.checkout.sessions.create throws", async () => {
    stubStripeConfigured();
    stubCartValid();
    sessionCreateMock.mockRejectedValue(new Error("stripe down"));

    const res = await request(makeApp())
      .post("/shop/checkout")
      .send({ items: ONE_ITEM });
    expect(res.status).toBe(502);
    expect(res.body.error).toBe("stripe_create_failed");
    // The order was never mirrored because the Session was never created.
    expect(getSupabaseCallCount("shop_orders", "upsert")).toBe(0);
  });

  it("re-mirrors the order WITHOUT cart_hash when the cart_hash index trips (23505)", async () => {
    stubStripeConfigured();
    stubCartValid();
    // A returning customer re-checks-out an IDENTICAL cart: the new Stripe
    // session is valid, but the first shop_orders mirror collides with the
    // partial unique index shop_orders_cart_hash_unique_idx (migration 0062) and
    // PostgREST surfaces Postgres 23505. The route must NOT 500 — and must still
    // persist a row for THIS session (cart_hash null) so the success page can
    // find the order. So: first upsert errors, second (cart_hash-free) succeeds.
    stageSupabaseResponse("shop_orders", "upsert", {
      data: null,
      error: {
        code: "23505",
        message:
          'duplicate key value violates unique constraint "shop_orders_cart_hash_unique_idx"',
      },
    });
    stageSupabaseResponse("shop_orders", "upsert", { data: null, error: null });

    const res = await request(makeApp())
      .post("/shop/checkout")
      .send({ items: ONE_ITEM });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ sessionId: SESSION_ID, url: SESSION_URL });
    // Two upserts: the cart_hash one, then the cart_hash-free retry.
    expect(getSupabaseCallCount("shop_orders", "upsert")).toBe(2);
    const payloads = getSupabaseWritePayloads(
      "shop_orders",
      "upsert",
    ) as Array<{ stripe_session_id: string; cart_hash: string | null }>;
    expect(payloads[0]!.cart_hash).toBeTruthy();
    expect(payloads[1]!.cart_hash).toBeNull();
    expect(payloads[1]!.stripe_session_id).toBe(SESSION_ID);
    // Logged at info (no PHI), not error.
    expect(reqLog.error).not.toHaveBeenCalled();
    expect(reqLog.info).toHaveBeenCalledTimes(1);
  });

  it("returns 500 when the cart_hash-free retry also fails", async () => {
    stubStripeConfigured();
    stubCartValid();
    stageSupabaseResponse("shop_orders", "upsert", {
      data: null,
      error: {
        code: "23505",
        message:
          'duplicate key value violates unique constraint "shop_orders_cart_hash_unique_idx"',
      },
    });
    stageSupabaseResponse("shop_orders", "upsert", {
      data: null,
      error: { code: "08006", message: "connection failure" },
    });

    const res = await request(makeApp())
      .post("/shop/checkout")
      .send({ items: ONE_ITEM });

    expect(res.status).toBe(500);
    expect(res.body.error).toBe("shop_order_persist_failed");
  });

  it("returns 500 on a 23505 that is NOT the cart_hash index (unexpected uniqueness bug)", async () => {
    stubStripeConfigured();
    stubCartValid();
    // A 23505 on some OTHER constraint must NOT be mislabelled a benign
    // cart_hash collision — it still 500s and is not retried.
    stageSupabaseResponse("shop_orders", "upsert", {
      data: null,
      error: {
        code: "23505",
        message:
          'duplicate key value violates unique constraint "shop_orders_pkey"',
      },
    });

    const res = await request(makeApp())
      .post("/shop/checkout")
      .send({ items: ONE_ITEM });

    expect(res.status).toBe(500);
    expect(res.body.error).toBe("shop_order_persist_failed");
    expect(getSupabaseCallCount("shop_orders", "upsert")).toBe(1);
    expect(reqLog.error).toHaveBeenCalledTimes(1);
  });

  it("returns 500 when the shop_orders mirror fails for a non-conflict reason", async () => {
    stubStripeConfigured();
    stubCartValid();
    // Any DB error that is NOT the benign cart_hash unique violation must still
    // surface as a 500.
    stageSupabaseResponse("shop_orders", "upsert", {
      data: null,
      error: { code: "08006", message: "connection failure" },
    });

    const res = await request(makeApp())
      .post("/shop/checkout")
      .send({ items: ONE_ITEM });

    expect(res.status).toBe(500);
    expect(res.body.error).toBe("shop_order_persist_failed");
    expect(reqLog.error).toHaveBeenCalledTimes(1);
  });

  it("returns 502 when the created Session has no url", async () => {
    stubStripeConfigured();
    stubCartValid();
    sessionCreateMock.mockResolvedValue({ id: SESSION_ID, url: null });

    const res = await request(makeApp())
      .post("/shop/checkout")
      .send({ items: ONE_ITEM });
    expect(res.status).toBe(502);
    expect(res.body.error).toBe("stripe_create_failed");
  });
});

describe("POST /shop/checkout — subscription mode (signed-in)", () => {
  it("creates a subscription-mode Session with the customer attached", async () => {
    stubSignedIn();
    stubStripeConfigured();
    stubCartValid();

    const res = await request(makeApp())
      .post("/shop/checkout")
      .send({
        items: [{ priceId: PRICE_ID, quantity: 1, mode: "subscription" }],
      });

    expect(res.status).toBe(200);
    expect(res.body.sessionId).toBe(SESSION_ID);
    const [params] = sessionCreateMock.mock.calls[0]!;
    expect(params.mode).toBe("subscription");
    expect(params.customer).toBe(STRIPE_CUSTOMER_ID);
    expect(params.subscription_data.metadata.customer_id).toBe(CUSTOMER_A);
  });

  it("returns 503 stripe_customer_unavailable when the customer can't be attached", async () => {
    stubSignedIn();
    stubStripeConfigured();
    stubCartValid();
    // Customer attach fails → the route refuses rather than silently
    // anonymising a recurring billing relationship.
    getOrCreateStripeCustomerMock.mockRejectedValue(new Error("stripe 500"));

    const res = await request(makeApp())
      .post("/shop/checkout")
      .send({
        items: [{ priceId: PRICE_ID, quantity: 1, mode: "subscription" }],
      });
    expect(res.status).toBe(503);
    expect(res.body.error).toBe("stripe_customer_unavailable");
    expect(sessionCreateMock).not.toHaveBeenCalled();
  });
});
