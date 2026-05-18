// Route tests for POST /shop/me/billing-portal.
//
// Coverage:
//   * 401 when requireSignedIn rejects (no session)
//   * 503 when Stripe is not configured
//   * 400 when returnPath is invalid (doesn't start with /)
//   * 200 success — returns portal URL
//   * 200 uses /account as the default returnPath
//   * 502 when stripe.billingPortal.sessions.create throws
//   * audit is written on success (best-effort, non-blocking)

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import express, { type Express } from "express";
import request from "supertest";

import {
  makeRequireSignedInMock,
  type MockSignedInProfile,
} from "../../test-helpers/auth-mocks";

// ── Auth mock ─────────────────────────────────────────────────────────
const { mockSignedIn } = vi.hoisted(() => ({
  mockSignedIn: { current: null as string | MockSignedInProfile | null },
}));
vi.mock("../../middlewares/requireSignedIn", () =>
  makeRequireSignedInMock(mockSignedIn),
);

// ── Rate-limit: pass-through ─────────────────────────────────────────
// We don't test the rate-limit logic here (it has its own tests). Mock
// it to always call next() so it's invisible to these tests.
vi.mock("../../middlewares/rate-limit", () => ({
  rateLimit: () =>
    (_req: unknown, _res: unknown, next: () => void) => next(),
}));

// ── Stripe config + customer mock ─────────────────────────────────────
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

// ── Audit mock ────────────────────────────────────────────────────────
const logAuditMock = vi.fn().mockResolvedValue(undefined);
vi.mock("@workspace/resupply-audit", () => ({
  logAudit: (...a: unknown[]) => logAuditMock(...a),
}));

import meBillingPortalRouter from "./me-billing-portal";

// ── Constants ─────────────────────────────────────────────────────────
const CUSTOMER_ID = "cust_aaaa1111";
const CUSTOMER_EMAIL = "alice@example.com";
const STRIPE_CUSTOMER_ID = "cus_stripe_123";
const PORTAL_URL = "https://billing.stripe.com/session/test_portal_abc";

const VALID_STRIPE_CONFIG = {
  secretKey: "sk_test_xxx",
  publishableKey: "pk_test_xxx",
  webhookSigningSecret: null,
  publicBaseUrl: "https://shop.example.com",
};

function makeApp(): Express {
  const app = express();
  app.use(express.json());
  app.use("/resupply-api", meBillingPortalRouter);
  return app;
}

function stubSignedIn(profile: MockSignedInProfile = { customerId: CUSTOMER_ID, email: CUSTOMER_EMAIL }): void {
  mockSignedIn.current = profile;
}

function stubStripeConfigured(): void {
  readStripeConfigOrNullMock.mockReturnValue(VALID_STRIPE_CONFIG);
  getOrCreateStripeCustomerMock.mockResolvedValue({
    stripeCustomerId: STRIPE_CUSTOMER_ID,
  });
  getStripeClientMock.mockReturnValue({
    billingPortal: {
      sessions: {
        create: vi.fn().mockResolvedValue({ url: PORTAL_URL }),
      },
    },
  });
}

describe("POST /shop/me/billing-portal", () => {
  beforeEach(() => {
    mockSignedIn.current = null;
    readStripeConfigOrNullMock.mockReset();
    getOrCreateStripeCustomerMock.mockReset();
    getStripeClientMock.mockReset();
    logAuditMock.mockReset().mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns 401 when there is no session", async () => {
    const res = await request(makeApp())
      .post("/resupply-api/shop/me/billing-portal")
      .send({ returnPath: "/account" });
    expect(res.status).toBe(401);
    expect(res.body.error).toBe("sign_in_required");
  });

  it("returns 503 when Stripe is not configured", async () => {
    stubSignedIn();
    readStripeConfigOrNullMock.mockReturnValue(null);
    const res = await request(makeApp())
      .post("/resupply-api/shop/me/billing-portal")
      .send({ returnPath: "/account" });
    expect(res.status).toBe(503);
    expect(res.body.error).toBe("shop_unavailable");
  });

  it("returns 400 when returnPath does not start with /", async () => {
    stubSignedIn();
    const res = await request(makeApp())
      .post("/resupply-api/shop/me/billing-portal")
      .send({ returnPath: "https://evil.example.com/steal" });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_body");
  });

  it("returns 400 when returnPath exceeds 200 characters", async () => {
    stubSignedIn();
    const longPath = "/" + "a".repeat(200);
    const res = await request(makeApp())
      .post("/resupply-api/shop/me/billing-portal")
      .send({ returnPath: longPath });
    expect(res.status).toBe(400);
  });

  it("returns 200 with portal URL on success", async () => {
    stubSignedIn();
    stubStripeConfigured();
    const res = await request(makeApp())
      .post("/resupply-api/shop/me/billing-portal")
      .send({ returnPath: "/account" });
    expect(res.status).toBe(200);
    expect(res.body.url).toBe(PORTAL_URL);
  });

  it("uses /account as default returnPath when body is empty", async () => {
    stubSignedIn();
    stubStripeConfigured();
    // Use a fresh mock to capture the call arg so we can assert
    // the returnPath default (the stub returns a fresh client every
    // call so the previous test's mock is not reused).
    const sessionCreateMock = vi.fn().mockResolvedValue({ url: PORTAL_URL });
    getStripeClientMock.mockReturnValue({
      billingPortal: {
        sessions: {
          create: sessionCreateMock,
        },
      },
    });

    const res = await request(makeApp())
      .post("/resupply-api/shop/me/billing-portal")
      .send({});
    expect(res.status).toBe(200);
    expect(sessionCreateMock).toHaveBeenCalledWith(
      expect.objectContaining({
        return_url: expect.stringContaining("/account"),
      }),
    );
  });

  it("constructs the return_url using publicBaseUrl + returnPath", async () => {
    stubSignedIn();
    const sessionCreateMock = vi.fn().mockResolvedValue({ url: PORTAL_URL });
    readStripeConfigOrNullMock.mockReturnValue(VALID_STRIPE_CONFIG);
    getOrCreateStripeCustomerMock.mockResolvedValue({
      stripeCustomerId: STRIPE_CUSTOMER_ID,
    });
    getStripeClientMock.mockReturnValue({
      billingPortal: { sessions: { create: sessionCreateMock } },
    });

    await request(makeApp())
      .post("/resupply-api/shop/me/billing-portal")
      .send({ returnPath: "/account?tab=billing" });

    expect(sessionCreateMock).toHaveBeenCalledWith(
      expect.objectContaining({
        return_url: "https://shop.example.com/account?tab=billing",
        customer: STRIPE_CUSTOMER_ID,
      }),
    );
  });

  it("returns 502 when stripe.billingPortal.sessions.create throws", async () => {
    stubSignedIn();
    readStripeConfigOrNullMock.mockReturnValue(VALID_STRIPE_CONFIG);
    getOrCreateStripeCustomerMock.mockResolvedValue({
      stripeCustomerId: STRIPE_CUSTOMER_ID,
    });
    getStripeClientMock.mockReturnValue({
      billingPortal: {
        sessions: {
          create: vi.fn().mockRejectedValue(new Error("Stripe network error")),
        },
      },
    });

    const res = await request(makeApp())
      .post("/resupply-api/shop/me/billing-portal")
      .send({ returnPath: "/account" });
    expect(res.status).toBe(502);
    expect(res.body.error).toBe("stripe_portal_unavailable");
  });

  it("does not leak the Stripe error message in the 502 response", async () => {
    stubSignedIn();
    readStripeConfigOrNullMock.mockReturnValue(VALID_STRIPE_CONFIG);
    getOrCreateStripeCustomerMock.mockResolvedValue({
      stripeCustomerId: STRIPE_CUSTOMER_ID,
    });
    getStripeClientMock.mockReturnValue({
      billingPortal: {
        sessions: {
          create: vi
            .fn()
            .mockRejectedValue(
              new Error("stripe_secret_with_sensitive_key_content"),
            ),
        },
      },
    });

    const res = await request(makeApp())
      .post("/resupply-api/shop/me/billing-portal")
      .send({ returnPath: "/account" });
    expect(JSON.stringify(res.body)).not.toMatch(/sensitive_key_content/);
  });

  it("calls getOrCreateStripeCustomer with the signed-in customerId", async () => {
    stubSignedIn({
      customerId: CUSTOMER_ID,
      email: CUSTOMER_EMAIL,
      displayName: "Alice Smith",
    });
    stubStripeConfigured();

    await request(makeApp())
      .post("/resupply-api/shop/me/billing-portal")
      .send({ returnPath: "/account" });

    expect(getOrCreateStripeCustomerMock).toHaveBeenCalledWith(
      VALID_STRIPE_CONFIG,
      expect.objectContaining({ customerId: CUSTOMER_ID }),
    );
  });

  it("writes an audit log entry on success", async () => {
    stubSignedIn();
    stubStripeConfigured();

    await request(makeApp())
      .post("/resupply-api/shop/me/billing-portal")
      .send({ returnPath: "/account" });

    expect(logAuditMock).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "shop.billing_portal.opened",
        targetTable: "shop_customers",
        targetId: CUSTOMER_ID,
      }),
    );
  });

  it("still returns 200 even if the audit write fails", async () => {
    stubSignedIn();
    stubStripeConfigured();
    // Simulate audit failure — the .catch() in the handler should swallow it.
    logAuditMock.mockRejectedValue(new Error("DB write timeout"));

    const res = await request(makeApp())
      .post("/resupply-api/shop/me/billing-portal")
      .send({ returnPath: "/account" });
    expect(res.status).toBe(200);
    expect(res.body.url).toBe(PORTAL_URL);
  });

  it("accepts an empty body and uses the default returnPath", async () => {
    stubSignedIn();
    stubStripeConfigured();

    const res = await request(makeApp())
      .post("/resupply-api/shop/me/billing-portal");
    expect(res.status).toBe(200);
  });
});