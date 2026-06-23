// Route tests for /shop/membership/* (self-serve membership join).

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
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

const supabaseMock = installSupabaseMock();

const { mockSignedIn } = vi.hoisted(() => ({
  mockSignedIn: { current: null as string | MockSignedInProfile | null },
}));
vi.mock("../../middlewares/requireSignedIn", () =>
  makeRequireSignedInMock(mockSignedIn),
);

vi.mock("../../middlewares/rate-limit", () => ({
  rateLimit: () => (_req: unknown, _res: unknown, next: () => void) => next(),
}));

const readStripeConfigOrNullMock = vi.fn();
const getStripeClientMock = vi.fn();
vi.mock("../../lib/stripe/config", () => ({
  readStripeConfigOrNull: () => readStripeConfigOrNullMock(),
  getStripeClient: (...args: unknown[]) => getStripeClientMock(...args),
}));

const getOrCreateStripeCustomerMock = vi.fn();
vi.mock("../../lib/stripe/customer", () => ({
  getOrCreateStripeCustomer: (...args: unknown[]) =>
    getOrCreateStripeCustomerMock(...args),
}));

vi.mock("../../lib/stripe/connect", () => ({
  stripeAccountRequestOptions: async () => ({}),
}));

import membershipRouter from "./membership-checkout";

const CUSTOMER = "cust-1";
const sessionsCreate = vi.fn();
const pricesRetrieve = vi.fn();

function makeApp(): Express {
  const app = express();
  app.use(express.json());
  app.use(membershipRouter);
  return app;
}

beforeEach(() => {
  supabaseMock.reset();
  // Default: not currently a member (the already-member guard reads this).
  stageSupabaseResponse("shop_customers", "select", { data: null });
  mockSignedIn.current = null;
  readStripeConfigOrNullMock.mockReset();
  getStripeClientMock.mockReset();
  getOrCreateStripeCustomerMock.mockReset();
  sessionsCreate.mockReset();
  pricesRetrieve.mockReset();
  readStripeConfigOrNullMock.mockReturnValue({
    publicBaseUrl: "https://shop.example.com",
  });
  getStripeClientMock.mockReturnValue({
    checkout: { sessions: { create: sessionsCreate } },
    prices: { retrieve: pricesRetrieve },
  });
  getOrCreateStripeCustomerMock.mockResolvedValue({
    stripeCustomerId: "cus_1",
  });
  delete process.env.STRIPE_MEMBERSHIP_MONTHLY_PRICE_ID;
  delete process.env.STRIPE_MEMBERSHIP_QUARTERLY_PRICE_ID;
});

afterEach(() => {
  delete process.env.STRIPE_MEMBERSHIP_MONTHLY_PRICE_ID;
  delete process.env.STRIPE_MEMBERSHIP_QUARTERLY_PRICE_ID;
});

describe("POST /shop/membership/checkout", () => {
  it("401 when not signed in", async () => {
    const res = await request(makeApp())
      .post("/shop/membership/checkout")
      .send({ tier: "monthly_unlimited" });
    expect(res.status).toBe(401);
  });

  it("503 when the requested tier has no configured price", async () => {
    mockSignedIn.current = CUSTOMER;
    const res = await request(makeApp())
      .post("/shop/membership/checkout")
      .send({ tier: "monthly_unlimited" });
    expect(res.status).toBe(503);
    expect(res.body.error).toBe("membership_tier_unavailable");
  });

  it("creates a subscription Checkout session stamped with the tier", async () => {
    mockSignedIn.current = CUSTOMER;
    process.env.STRIPE_MEMBERSHIP_MONTHLY_PRICE_ID = "price_monthly";
    sessionsCreate.mockResolvedValue({ url: "https://checkout.stripe/x" });

    const res = await request(makeApp())
      .post("/shop/membership/checkout")
      .send({ tier: "monthly_unlimited" });

    expect(res.status).toBe(200);
    expect(res.body.url).toBe("https://checkout.stripe/x");
    const arg = sessionsCreate.mock.calls[0][0] as Record<string, unknown>;
    expect(arg.mode).toBe("subscription");
    expect(arg.line_items).toEqual([{ price: "price_monthly", quantity: 1 }]);
    expect(arg.success_url).toBe(
      "https://shop.example.com/account?membership=joined",
    );
    expect(arg.cancel_url).toBe("https://shop.example.com/account");
    expect(
      (arg.subscription_data as { metadata: Record<string, string> }).metadata,
    ).toMatchObject({
      customer_id: CUSTOMER,
      membership_tier: "monthly_unlimited",
    });
    // A server-derived idempotency key guards against double-click duplicates.
    const opts = sessionsCreate.mock.calls[0][1] as Record<string, unknown>;
    expect(typeof opts.idempotencyKey).toBe("string");
    expect(opts.idempotencyKey).toContain(
      "membership:cust-1:monthly_unlimited",
    );
  });

  it("409 when the customer already has a paid membership", async () => {
    mockSignedIn.current = CUSTOMER;
    process.env.STRIPE_MEMBERSHIP_QUARTERLY_PRICE_ID = "price_quarterly";
    supabaseMock.reset();
    stageSupabaseResponse("shop_customers", "select", {
      data: {
        membership_tier: "monthly_unlimited",
        membership_stripe_subscription_id: "sub_existing",
      },
    });
    const res = await request(makeApp())
      .post("/shop/membership/checkout")
      .send({ tier: "quarterly_unlimited" });
    expect(res.status).toBe(409);
    expect(res.body.error).toBe("already_member");
    expect(sessionsCreate).not.toHaveBeenCalled();
  });

  it("400 on an unknown tier", async () => {
    mockSignedIn.current = CUSTOMER;
    const res = await request(makeApp())
      .post("/shop/membership/checkout")
      .send({ tier: "platinum" });
    expect(res.status).toBe(400);
  });
});

describe("GET /shop/membership/options", () => {
  it("lists only configured tiers with their price", async () => {
    mockSignedIn.current = CUSTOMER;
    process.env.STRIPE_MEMBERSHIP_MONTHLY_PRICE_ID = "price_monthly";
    pricesRetrieve.mockResolvedValue({
      unit_amount: 4999,
      currency: "usd",
      recurring: { interval: "month", interval_count: 1 },
    });
    const res = await request(makeApp()).get("/shop/membership/options");
    expect(res.status).toBe(200);
    expect(res.body.tiers).toHaveLength(1);
    expect(res.body.tiers[0]).toMatchObject({
      tier: "monthly_unlimited",
      priceId: "price_monthly",
      unitAmountCents: 4999,
      interval: "month",
    });
  });

  it("returns an empty list when no tiers are configured", async () => {
    mockSignedIn.current = CUSTOMER;
    const res = await request(makeApp()).get("/shop/membership/options");
    expect(res.status).toBe(200);
    expect(res.body.tiers).toEqual([]);
  });
});
