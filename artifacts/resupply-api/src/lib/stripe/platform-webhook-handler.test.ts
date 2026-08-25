// Behavioral test for the platform-billing webhook handler's front-door
// gating.
//
// The gate turns on ONE thing: a verifiable delivery. Both billing modes
// are supported — `dedicated` (its own account + signing secret) and
// `shared` (the legacy STRIPE_SECRET_KEY account still carrying platform
// billing) — and this handler is the only thing left that reconciles
// either, so refusing shared mode would leave those tenants creating
// checkout sessions that never settle. What it must still refuse is an
// event it cannot verify: no config, or no signing secret.

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

  it("PROCESSES shared mode — it is a supported billing configuration", async () => {
    // Regression guard. This handler used to require `mode: "dedicated"`,
    // which meant a deployment on the legacy shared key had its tenant
    // invoices and subscriptions silently never reconciled. Reaching the
    // signature check (400) proves the delivery was accepted for
    // processing rather than turned away at the door.
    process.env.NODE_ENV = "production";
    cfg.current = SHARED;
    const res = makeRes();
    await stripePlatformBillingWebhookHandler(makeReq(), res, vi.fn());
    expect(res.statusCode).toBe(400);
    expect((res.body as { error: string }).error).toBe(
      "missing_stripe_signature",
    );
  });

  it("503s in production when no config resolves at all", async () => {
    process.env.NODE_ENV = "production";
    cfg.current = null;
    const res = makeRes();
    await stripePlatformBillingWebhookHandler(makeReq(), res, vi.fn());
    expect(res.statusCode).toBe(503);
    expect((res.body as { error: string }).error).toBe(
      "platform_billing_webhook_unconfigured",
    );
  });

  it("acks 200 (ignored) outside production when unconfigured", async () => {
    process.env.NODE_ENV = "test";
    cfg.current = null;
    const res = makeRes();
    await stripePlatformBillingWebhookHandler(makeReq(), res, vi.fn());
    expect(res.statusCode).toBe(200);
    expect((res.body as { ignored: string }).ignored).toBe(
      "platform_billing_unconfigured",
    );
  });

  it("refuses a shared-mode delivery it cannot verify", async () => {
    // No signing secret = no way to authenticate the event. Acting on an
    // unverified billing event is worse than dropping it.
    process.env.NODE_ENV = "production";
    cfg.current = { ...SHARED, webhookSigningSecret: null };
    const res = makeRes();
    await stripePlatformBillingWebhookHandler(makeReq(), res, vi.fn());
    expect(res.statusCode).toBe(503);
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
