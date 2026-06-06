// Tests for POST /shop/me/quick-checkout — focused on the idempotency-key
// namespacing fix introduced in this PR.
//
// Security regression: the previous implementation forwarded the client-
// supplied `Idempotency-Key` header verbatim to Stripe. Stripe scopes
// idempotency keys account-wide, so two unrelated patients using the same
// header value would resolve to the same Checkout Session (cross-customer
// cart/PHI leak). The fix hashes customerId + clientKey + basketHash so
// the effective key is unforgeable across customers.
//
// Coverage:
//   1. 401 when requireSignedIn rejects
//   2. 503 when Stripe is not configured
//   3. 400 when body is invalid (no items or reorderSessionId)
//   4. The Stripe sessions.create call receives a SERVER-DERIVED key
//      (not the raw client header)
//   5. Two different customers with the same client-supplied key get
//      DIFFERENT effective idempotency keys
//   6. The same customer with the same basket gets the SAME key (dedup)
//   7. The same customer with a different basket gets a DIFFERENT key
//   8. Subscription mode: isSubscription feeds into the key (sub vs one)
//   9. 502 when stripe.checkout.sessions.create throws

import { beforeEach, describe, expect, it, vi } from "vitest";
import express, { type Express } from "express";
import request from "supertest";

import {
  makeRequireSignedInMock,
  type MockSignedInProfile,
} from "../../test-helpers/auth-mocks";
import {
  installSupabaseMock,
  stageSupabaseResponse,
} from "../../test-helpers/supabase-mock";

// ── Supabase mock ─────────────────────────────────────────────────────────────
const supabaseMock = installSupabaseMock();

// ── Auth mock ─────────────────────────────────────────────────────────────────
const { mockSignedIn } = vi.hoisted(() => ({
  mockSignedIn: { current: null as string | MockSignedInProfile | null },
}));
vi.mock("../../middlewares/requireSignedIn", () =>
  makeRequireSignedInMock(mockSignedIn),
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

// ── Logger mock ───────────────────────────────────────────────────────────────
const { loggerMock } = vi.hoisted(() => ({
  loggerMock: { error: vi.fn(), warn: vi.fn(), info: vi.fn() },
}));
vi.mock("../../lib/logger", () => ({ logger: loggerMock }));

// ── storefront.checkout feature flag ──────────────────────────────────────────
// Toggle `featureEnabled.value` per test; defaults on (reset in beforeEach).
const featureEnabled = vi.hoisted(() => ({ value: true }));
vi.mock("../../lib/feature-flags", () => ({
  isFeatureEnabled: vi.fn(async () => featureEnabled.value),
}));

import quickCheckoutRouter from "./quick-checkout";

// ── Constants ─────────────────────────────────────────────────────────────────
const CUSTOMER_A = "cust_aaaa0001";
const CUSTOMER_B = "cust_bbbb0002";
const STRIPE_CUSTOMER_ID = "cus_stripe_test_123";
const SESSION_URL = "https://checkout.stripe.com/c/test_session";
const SESSION_ID = "cs_test_session_abc123";

const VALID_STRIPE_CONFIG = {
  secretKey: "sk_test_xxx",
  publishableKey: "pk_test_xxx",
  webhookSigningSecret: null,
  publicBaseUrl: "https://shop.example.com",
};

const ONE_ITEM = [{ priceId: "price_abc123xyzabc", quantity: 1 }];

function makeApp(): Express {
  const app = express();
  app.use(express.json());
  app.use(quickCheckoutRouter);
  return app;
}

function stubSignedIn(customerId = CUSTOMER_A): void {
  mockSignedIn.current = {
    customerId,
    email: "alice@example.com",
    displayName: "Alice",
  };
}

let sessionCreateMock: ReturnType<typeof vi.fn>;

function stubStripeConfigured(): void {
  readStripeConfigOrNullMock.mockReturnValue(VALID_STRIPE_CONFIG);
  getOrCreateStripeCustomerMock.mockResolvedValue({
    stripeCustomerId: STRIPE_CUSTOMER_ID,
  });
  sessionCreateMock = vi.fn().mockResolvedValue({
    id: SESSION_ID,
    url: SESSION_URL,
  });
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
  getOrCreateStripeCustomerMock.mockReset();
  getStripeClientMock.mockReset();
  validateCartItemsMock.mockReset();
  loggerMock.error.mockReset();
  loggerMock.warn.mockReset();
  loggerMock.info.mockReset();
});

// ── Basic auth/config guards ──────────────────────────────────────────────────

describe("POST /shop/me/quick-checkout — auth and config guards", () => {
  it("returns 401 when there is no signed-in session", async () => {
    const res = await request(makeApp())
      .post("/shop/me/quick-checkout")
      .send({ items: ONE_ITEM });
    expect(res.status).toBe(401);
    expect(res.body.error).toBe("sign_in_required");
  });

  it("returns 503 when Stripe is not configured", async () => {
    stubSignedIn();
    readStripeConfigOrNullMock.mockReturnValue(null);

    const res = await request(makeApp())
      .post("/shop/me/quick-checkout")
      .send({ items: ONE_ITEM });
    expect(res.status).toBe(503);
    expect(res.body.error).toBe("shop_unavailable");
  });

  it("returns 503 checkout_disabled when the storefront.checkout flag is off", async () => {
    stubSignedIn();
    // Even with Stripe fully configured, a paused storefront must block
    // express checkout — parity with POST /shop/checkout so the toggle
    // can't be bypassed via the saved-card fast path.
    stubStripeConfigured();
    featureEnabled.value = false;

    const res = await request(makeApp())
      .post("/shop/me/quick-checkout")
      .send({ items: ONE_ITEM });
    expect(res.status).toBe(503);
    expect(res.body.error).toBe("checkout_disabled");
  });

  it("returns 400 when neither items nor reorderSessionId is provided", async () => {
    stubSignedIn();
    stubStripeConfigured();

    const res = await request(makeApp())
      .post("/shop/me/quick-checkout")
      .send({});
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_body");
  });

  it("returns 400 when both items and reorderSessionId are provided", async () => {
    stubSignedIn();
    stubStripeConfigured();

    const res = await request(makeApp()).post("/shop/me/quick-checkout").send({
      items: ONE_ITEM,
      reorderSessionId: "cs_test_aaaaaaaaaaaaaaaaaaaaaa",
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_body");
  });

  it("returns 400 when items array is empty", async () => {
    stubSignedIn();
    stubStripeConfigured();

    const res = await request(makeApp())
      .post("/shop/me/quick-checkout")
      .send({ items: [] });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_body");
  });
});

// ── Idempotency key namespacing ───────────────────────────────────────────────
//
// The core security fix: the effective key sent to Stripe must be a
// server-derived SHA-256 hash that includes the customerId, so different
// customers cannot share the same Stripe Checkout Session via an identical
// client-supplied `Idempotency-Key` header.

describe("POST /shop/me/quick-checkout — idempotency key namespacing", () => {
  async function checkoutWithKey(
    customerId: string,
    clientKey: string | null,
    items = ONE_ITEM,
  ) {
    mockSignedIn.current = {
      customerId,
      email: "alice@example.com",
      displayName: "Alice",
    };
    stubStripeConfigured();
    stubCartValid();
    // Stage shop_orders upsert + update for the post-session DB writes.
    stageSupabaseResponse("shop_orders", "upsert", { data: null });
    stageSupabaseResponse("shop_orders", "update", { data: null });

    const req = request(makeApp()).post("/shop/me/quick-checkout");
    if (clientKey !== null) req.set("Idempotency-Key", clientKey);
    await req.send({ items });
    return sessionCreateMock;
  }

  it("passes an idempotency key to stripe.checkout.sessions.create", async () => {
    const mock = await checkoutWithKey(CUSTOMER_A, "client-key-1");
    expect(mock).toHaveBeenCalledTimes(1);
    const [, opts] = mock.mock.calls[0] as [
      unknown,
      { idempotencyKey?: string },
    ];
    expect(typeof opts.idempotencyKey).toBe("string");
    expect(opts.idempotencyKey!.length).toBeGreaterThan(0);
  });

  it("does NOT forward the raw client Idempotency-Key header to Stripe", async () => {
    const rawClientKey = "my-raw-client-key-do-not-use";
    const mock = await checkoutWithKey(CUSTOMER_A, rawClientKey);
    const [, opts] = mock.mock.calls[0] as [
      unknown,
      { idempotencyKey?: string },
    ];
    // The effective key must be a hash, not the verbatim client key.
    expect(opts.idempotencyKey).not.toBe(rawClientKey);
  });

  it("two customers with the SAME client key get DIFFERENT idempotency keys (security regression guard)", async () => {
    const sharedClientKey = "shared-key-across-customers";

    // Customer A
    const mockA = await checkoutWithKey(CUSTOMER_A, sharedClientKey);
    const [, optsA] = mockA.mock.calls[0] as [
      unknown,
      { idempotencyKey?: string },
    ];
    const keyA = optsA.idempotencyKey;

    // Customer B — same client key
    const mockB = await checkoutWithKey(CUSTOMER_B, sharedClientKey);
    const [, optsB] = mockB.mock.calls[0] as [
      unknown,
      { idempotencyKey?: string },
    ];
    const keyB = optsB.idempotencyKey;

    expect(keyA).toBeDefined();
    expect(keyB).toBeDefined();
    expect(keyA).not.toBe(keyB);
  });

  it("the SAME customer with the SAME basket and the SAME client key gets the SAME key (dedup)", async () => {
    const clientKey = "double-click-dedup";

    const mockFirst = await checkoutWithKey(CUSTOMER_A, clientKey, ONE_ITEM);
    const [, optsFirst] = mockFirst.mock.calls[0] as [
      unknown,
      { idempotencyKey?: string },
    ];

    const mockSecond = await checkoutWithKey(CUSTOMER_A, clientKey, ONE_ITEM);
    const [, optsSecond] = mockSecond.mock.calls[0] as [
      unknown,
      { idempotencyKey?: string },
    ];

    expect(optsFirst.idempotencyKey).toBe(optsSecond.idempotencyKey);
  });

  it("the SAME customer with a DIFFERENT basket gets a DIFFERENT key", async () => {
    const clientKey = "same-key-different-cart";

    const itemsA = [{ priceId: "price_aaa111aaabbb222", quantity: 1 }];
    const itemsB = [{ priceId: "price_bbb222bbbccc333", quantity: 2 }];

    const mockFirst = await checkoutWithKey(CUSTOMER_A, clientKey, itemsA);
    const [, optsFirst] = mockFirst.mock.calls[0] as [
      unknown,
      { idempotencyKey?: string },
    ];

    const mockSecond = await checkoutWithKey(CUSTOMER_A, clientKey, itemsB);
    const [, optsSecond] = mockSecond.mock.calls[0] as [
      unknown,
      { idempotencyKey?: string },
    ];

    expect(optsFirst.idempotencyKey).not.toBe(optsSecond.idempotencyKey);
  });

  it("subscription mode and one-time mode produce DIFFERENT keys for the same basket", async () => {
    const clientKey = "mode-differentiator";

    // One-time basket
    const oneTimeItems = [{ priceId: "price_onetimeaaa111", quantity: 1 }];
    const mockOt = await checkoutWithKey(CUSTOMER_A, clientKey, oneTimeItems);
    const [, optsOt] = mockOt.mock.calls[0] as [
      unknown,
      { idempotencyKey?: string },
    ];

    // Subscription basket (same priceId, same quantity, different mode)
    const subItems = [
      {
        priceId: "price_onetimeaaa111",
        quantity: 1,
        mode: "subscription" as const,
      },
    ];
    const mockSub = await checkoutWithKey(CUSTOMER_A, clientKey, subItems);
    const [, optsSub] = mockSub.mock.calls[0] as [
      unknown,
      { idempotencyKey?: string },
    ];

    expect(optsOt.idempotencyKey).not.toBe(optsSub.idempotencyKey);
  });

  it("generates a key even when no Idempotency-Key header is sent (uses random UUID internally)", async () => {
    const mock = await checkoutWithKey(CUSTOMER_A, null /* no header */);
    const [, opts] = mock.mock.calls[0] as [
      unknown,
      { idempotencyKey?: string },
    ];
    expect(typeof opts.idempotencyKey).toBe("string");
    expect(opts.idempotencyKey!.length).toBeGreaterThan(0);
  });
});

// ── Cart validation gate ──────────────────────────────────────────────────────

describe("POST /shop/me/quick-checkout — cart validation", () => {
  it("returns 400 when cart validation fails", async () => {
    stubSignedIn();
    stubStripeConfigured();
    validateCartItemsMock.mockResolvedValue({
      ok: false,
      errors: [
        {
          priceId: "price_abc123xyzabc",
          reason: "archived",
          message: "Price is archived",
        },
      ],
    });

    const res = await request(makeApp())
      .post("/shop/me/quick-checkout")
      .send({ items: ONE_ITEM });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("cart_invalid");
    expect(res.body.issues).toHaveLength(1);
    expect(res.body.issues[0]).toMatchObject({
      priceId: "price_abc123xyzabc",
      reason: "archived",
    });
  });
});

// ── Stripe create error ───────────────────────────────────────────────────────

describe("POST /shop/me/quick-checkout — Stripe error handling", () => {
  it("returns 502 when stripe.checkout.sessions.create throws", async () => {
    stubSignedIn();
    stubStripeConfigured();
    stubCartValid();
    sessionCreateMock.mockRejectedValue(new Error("Stripe API error"));

    const res = await request(makeApp())
      .post("/shop/me/quick-checkout")
      .send({ items: ONE_ITEM });
    expect(res.status).toBe(502);
    expect(res.body.error).toBe("stripe_create_failed");
  });

  it("returns 200 with sessionId and url on success", async () => {
    stubSignedIn();
    stubStripeConfigured();
    stubCartValid();
    stageSupabaseResponse("shop_orders", "upsert", { data: null });
    stageSupabaseResponse("shop_orders", "update", { data: null });

    const res = await request(makeApp())
      .post("/shop/me/quick-checkout")
      .send({ items: ONE_ITEM });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      sessionId: SESSION_ID,
      url: SESSION_URL,
    });
  });
});
