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
