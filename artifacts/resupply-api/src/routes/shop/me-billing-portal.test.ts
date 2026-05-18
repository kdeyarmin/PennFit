// Route tests for POST /shop/me/billing-portal.
//
// Coverage:
//   * 401 when no session
//   * 503 (SHOP_UNAVAILABLE_BODY) when Stripe is not configured
//   * 400 for invalid body (returnPath missing leading slash)
//   * 200 + url on happy path
//   * return_url includes the returnPath supplied by the caller
//   * default returnPath is /account
//   * 502 when Stripe SDK throws
//   * audit log written on successful session creation
//   * returnPath is passed to the Stripe session return_url

import { describe, it, expect, vi, beforeEach } from "vitest";
import express, { type Express } from "express";
import request from "supertest";
import type { NextFunction, Request, Response } from "express";

import {
  makeRequireSignedInMock,
  type MockSignedInRef,
} from "../../test-helpers/auth-mocks";

// ── requireSignedIn mock ────────────────────────────────────────────────────
const { mockSignedIn } = vi.hoisted(() => ({
  mockSignedIn: { current: null } as MockSignedInRef,
}));
vi.mock("../../middlewares/requireSignedIn", () =>
  makeRequireSignedInMock(mockSignedIn),
);

// ── rate-limit mock: pass-through in tests ──────────────────────────────────
vi.mock("../../middlewares/rate-limit", () => ({
  rateLimit: () => (_req: Request, _res: Response, next: NextFunction) =>
    next(),
}));

// ── Stripe config mocks ─────────────────────────────────────────────────────
const readStripeConfigOrNullMock = vi.fn();
const getStripeClientMock = vi.fn();
const SHOP_UNAVAILABLE_BODY_MOCK = {
  error: "shop_unavailable",
  message: "Shop not configured in this environment.",
};
vi.mock("../../lib/stripe/config", () => ({
  readStripeConfigOrNull: (...a: unknown[]) =>
    readStripeConfigOrNullMock(...a),
  getStripeClient: (...a: unknown[]) => getStripeClientMock(...a),
  SHOP_UNAVAILABLE_BODY: SHOP_UNAVAILABLE_BODY_MOCK,
}));

// ── Stripe customer mock ────────────────────────────────────────────────────
const getOrCreateStripeCustomerMock = vi.fn();
vi.mock("../../lib/stripe/customer", () => ({
  getOrCreateStripeCustomer: (...a: unknown[]) =>
    getOrCreateStripeCustomerMock(...a),
}));

// ── Audit log mock ──────────────────────────────────────────────────────────
const logAuditMock = vi.hoisted(() =>
  vi.fn(async (_arg: unknown) => undefined),
);
vi.mock("@workspace/resupply-audit", () => ({
  logAudit: logAuditMock,
}));

import meBillingPortalRouter from "./me-billing-portal";

const CUSTOMER_ID = "cust_test_111";
const STRIPE_CUSTOMER_ID = "cus_stripe_abc";
const PORTAL_URL = "https://billing.stripe.com/p/session/xyz123";
const FAKE_CONFIG = {
  secretKey: "sk_test_xxx",
  publicBaseUrl: "https://app.example.com",
};

function makeApp(): Express {
  const app = express();
  app.use(express.json());
  app.use(meBillingPortalRouter);
  return app;
}

function stubSignedIn(customerId = CUSTOMER_ID): void {
  mockSignedIn.current = {
    customerId,
    email: "patient@example.com",
    displayName: "Alice",
  };
}

function stubStripeConfigured(): void {
  readStripeConfigOrNullMock.mockReturnValue(FAKE_CONFIG);
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

beforeEach(() => {
  mockSignedIn.current = null;
  readStripeConfigOrNullMock.mockReset();
  getStripeClientMock.mockReset();
  getOrCreateStripeCustomerMock.mockReset();
  logAuditMock.mockReset().mockResolvedValue(undefined);
});

describe("POST /shop/me/billing-portal", () => {
  it("returns 401 when no session", async () => {
    const res = await request(makeApp())
      .post("/shop/me/billing-portal")
      .send({});
    expect(res.status).toBe(401);
  });

  it("returns 503 when Stripe is not configured", async () => {
    stubSignedIn();
    readStripeConfigOrNullMock.mockReturnValue(null);
    const res = await request(makeApp())
      .post("/shop/me/billing-portal")
      .send({ returnPath: "/account" });
    expect(res.status).toBe(503);
    expect(res.body.error).toBe("shop_unavailable");
  });

  it("returns 400 when returnPath does not start with /", async () => {
    stubSignedIn();
    readStripeConfigOrNullMock.mockReturnValue(FAKE_CONFIG);
    const res = await request(makeApp())
      .post("/shop/me/billing-portal")
      .send({ returnPath: "http://evil.example.com/steal" });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_body");
  });

  it("returns 400 for extra unexpected body fields (strict schema)", async () => {
    stubSignedIn();
    readStripeConfigOrNullMock.mockReturnValue(FAKE_CONFIG);
    const res = await request(makeApp())
      .post("/shop/me/billing-portal")
      .send({ returnPath: "/account", extraField: "oops" });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_body");
  });

  it("returns 200 and the portal url on success", async () => {
    stubSignedIn();
    stubStripeConfigured();
    const res = await request(makeApp())
      .post("/shop/me/billing-portal")
      .send({ returnPath: "/account" });
    expect(res.status).toBe(200);
    expect(res.body.url).toBe(PORTAL_URL);
  });

  it("uses /account as default returnPath when not specified", async () => {
    stubSignedIn();
    const createSessionMock = vi
      .fn()
      .mockResolvedValue({ url: PORTAL_URL });
    readStripeConfigOrNullMock.mockReturnValue(FAKE_CONFIG);
    getOrCreateStripeCustomerMock.mockResolvedValue({
      stripeCustomerId: STRIPE_CUSTOMER_ID,
    });
    getStripeClientMock.mockReturnValue({
      billingPortal: { sessions: { create: createSessionMock } },
    });

    await request(makeApp()).post("/shop/me/billing-portal").send({});

    expect(createSessionMock).toHaveBeenCalledWith(
      expect.objectContaining({
        return_url: expect.stringContaining("/account"),
      }),
    );
  });

  it("passes the custom returnPath into the Stripe session return_url", async () => {
    stubSignedIn();
    const createSessionMock = vi
      .fn()
      .mockResolvedValue({ url: PORTAL_URL });
    readStripeConfigOrNullMock.mockReturnValue(FAKE_CONFIG);
    getOrCreateStripeCustomerMock.mockResolvedValue({
      stripeCustomerId: STRIPE_CUSTOMER_ID,
    });
    getStripeClientMock.mockReturnValue({
      billingPortal: { sessions: { create: createSessionMock } },
    });

    await request(makeApp())
      .post("/shop/me/billing-portal")
      .send({ returnPath: "/account/subscriptions" });

    expect(createSessionMock).toHaveBeenCalledWith(
      expect.objectContaining({
        return_url: "https://app.example.com/account/subscriptions",
      }),
    );
  });

  it("passes the stripeCustomerId to the session create call", async () => {
    stubSignedIn();
    const createSessionMock = vi
      .fn()
      .mockResolvedValue({ url: PORTAL_URL });
    readStripeConfigOrNullMock.mockReturnValue(FAKE_CONFIG);
    getOrCreateStripeCustomerMock.mockResolvedValue({
      stripeCustomerId: STRIPE_CUSTOMER_ID,
    });
    getStripeClientMock.mockReturnValue({
      billingPortal: { sessions: { create: createSessionMock } },
    });

    await request(makeApp())
      .post("/shop/me/billing-portal")
      .send({ returnPath: "/account" });

    expect(createSessionMock).toHaveBeenCalledWith(
      expect.objectContaining({ customer: STRIPE_CUSTOMER_ID }),
    );
  });

  it("returns 502 when the Stripe SDK throws", async () => {
    stubSignedIn();
    readStripeConfigOrNullMock.mockReturnValue(FAKE_CONFIG);
    getOrCreateStripeCustomerMock.mockRejectedValue(
      new Error("Stripe unavailable"),
    );
    const res = await request(makeApp())
      .post("/shop/me/billing-portal")
      .send({ returnPath: "/account" });
    expect(res.status).toBe(502);
    expect(res.body.error).toBe("stripe_portal_unavailable");
  });

  it("returns 502 when the session create call throws", async () => {
    stubSignedIn();
    readStripeConfigOrNullMock.mockReturnValue(FAKE_CONFIG);
    getOrCreateStripeCustomerMock.mockResolvedValue({
      stripeCustomerId: STRIPE_CUSTOMER_ID,
    });
    getStripeClientMock.mockReturnValue({
      billingPortal: {
        sessions: {
          create: vi
            .fn()
            .mockRejectedValue(new Error("rate limited by Stripe")),
        },
      },
    });
    const res = await request(makeApp())
      .post("/shop/me/billing-portal")
      .send({ returnPath: "/account" });
    expect(res.status).toBe(502);
    expect(res.body.error).toBe("stripe_portal_unavailable");
  });

  it("writes an audit row on successful session creation", async () => {
    stubSignedIn();
    stubStripeConfigured();
    await request(makeApp())
      .post("/shop/me/billing-portal")
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
    logAuditMock.mockRejectedValue(new Error("audit DB down"));
    const res = await request(makeApp())
      .post("/shop/me/billing-portal")
      .send({ returnPath: "/account" });
    // audit failure is caught; session URL still returned
    expect(res.status).toBe(200);
    expect(res.body.url).toBe(PORTAL_URL);
  });
});