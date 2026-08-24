// Behavioral test for the dedicated platform-billing webhook handler's
// front-door gating: it must refuse (or no-op) when the deployment isn't
// in dedicated-account mode, and reject a missing signature — both before
// any Stripe verification or DB write. The full happy-path dispatch is
// covered indirectly by the platform-billing service tests; here we pin
// the guard branches that keep a misrouted delivery from doing work.

import type { Request, Response } from "express";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { PlatformBillingStripeConfig } from "./config";

const cfg = vi.hoisted(() => ({
  current: null as PlatformBillingStripeConfig | null,
}));

vi.mock("./config", () => ({
  readPlatformBillingStripeConfigOrNull: () => cfg.current,
  readStripeConfigOrNull: () => null,
  getStripeClient: () => ({ webhooks: { constructEvent: () => ({}) } }),
}));

// Keep the module import light — these are only referenced on code paths
// the guard branches never reach.
vi.mock("../platform-billing/stripe", () => ({
  handlePlatformTenantStripeEvent: vi.fn(async () => true),
}));
vi.mock("../../worker/index.js", () => ({ getBoss: vi.fn() }));

const { stripePlatformBillingWebhookHandler } =
  await import("./platform-webhook-handler");

function makeRes() {
  const res = {
    statusCode: 0,
    body: undefined as unknown,
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(payload: unknown) {
      this.body = payload;
      return this;
    },
  };
  return res as unknown as Response & { statusCode: number; body: unknown };
}

function makeReq(overrides: Partial<Request> = {}): Request {
  return {
    headers: {},
    body: Buffer.from("{}"),
    log: undefined,
    ...overrides,
  } as unknown as Request;
}

const SHARED: PlatformBillingStripeConfig = {
  secretKey: "sk_test_patient",
  publishableKey: null,
  webhookSigningSecret: "whsec_patient",
  publicBaseUrl: "https://x.example.com",
  mode: "shared",
};

const ORIGINAL_NODE_ENV = process.env.NODE_ENV;

describe("stripePlatformBillingWebhookHandler gating", () => {
  // Preserve and restore NODE_ENV rather than deleting it — other tests in
  // the same Vitest worker assume it stays "test".
  afterEach(() => {
    cfg.current = null;
    if (ORIGINAL_NODE_ENV === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = ORIGINAL_NODE_ENV;
  });

  it("503s in production when not in dedicated mode", async () => {
    process.env.NODE_ENV = "production";
    cfg.current = SHARED;
    const res = makeRes();
    await stripePlatformBillingWebhookHandler(makeReq(), res, vi.fn());
    expect(res.statusCode).toBe(503);
    expect((res.body as { error: string }).error).toBe(
      "platform_billing_webhook_unconfigured",
    );
  });

  it("acks 200 (ignored) outside production when not in dedicated mode", async () => {
    process.env.NODE_ENV = "test";
    cfg.current = SHARED;
    const res = makeRes();
    await stripePlatformBillingWebhookHandler(makeReq(), res, vi.fn());
    expect(res.statusCode).toBe(200);
    expect((res.body as { ignored: string }).ignored).toBe(
      "platform_billing_not_dedicated",
    );
  });

  it("400s when the stripe-signature header is missing (dedicated mode)", async () => {
    cfg.current = {
      ...SHARED,
      mode: "dedicated",
      webhookSigningSecret: "whsec_platform",
    };
    const res = makeRes();
    await stripePlatformBillingWebhookHandler(makeReq(), res, vi.fn());
    expect(res.statusCode).toBe(400);
    expect((res.body as { error: string }).error).toBe(
      "missing_stripe_signature",
    );
  });

  it("503s in production when dedicated key is set but its webhook secret is missing", async () => {
    process.env.NODE_ENV = "production";
    cfg.current = { ...SHARED, mode: "dedicated", webhookSigningSecret: null };
    const res = makeRes();
    await stripePlatformBillingWebhookHandler(makeReq(), res, vi.fn());
    expect(res.statusCode).toBe(503);
  });
});
