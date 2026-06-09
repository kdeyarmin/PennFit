// Route tests for routes/storefront/me-payment-methods.ts
//
// Covers the auth gate, body validation, patient-resolution, Stripe-not-
// configured, and status-mapping wiring for the four endpoints. The
// Stripe/Supabase-touching service functions are mocked so the route's
// own logic is exercised in isolation (same approach as me-payments.test).

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import express, { type Express } from "express";
import request from "supertest";

import {
  installSupabaseMock,
  stageSupabaseResponse,
} from "../../test-helpers/supabase-mock";

const supabaseMock = installSupabaseMock();

const autopayMocks = vi.hoisted(() => ({
  createAutopaySetupSession: vi.fn(),
  getActiveAutopayAuthorization: vi.fn(),
  setAutopayEnabled: vi.fn(),
  revokeAutopayAuthorization: vi.fn(),
}));
vi.mock("../../lib/billing/patient-autopay", () => ({
  ...autopayMocks,
  toAutopayStatusView: (row: unknown) =>
    row
      ? {
          hasCard: true,
          autopayEnabled:
            (row as { autopay_enabled?: boolean }).autopay_enabled ?? false,
          card: null,
          authorizedAt: null,
        }
      : {
          hasCard: false,
          autopayEnabled: false,
          card: null,
          authorizedAt: null,
        },
}));

const readStripeConfigMock = vi.hoisted(() => vi.fn());
vi.mock("../../lib/stripe/config", () => ({
  readStripeConfigOrNull: () => readStripeConfigMock(),
}));

const getOrCreateStripeCustomerMock = vi.hoisted(() => vi.fn());
vi.mock("../../lib/stripe/customer", () => ({
  getOrCreateStripeCustomer: (...a: unknown[]) =>
    getOrCreateStripeCustomerMock(...a),
}));

// Pass-through the rate limiter so bucket state can't make tests flaky.
vi.mock("../../middlewares/rate-limit", () => ({
  rateLimit:
    () =>
    (_req: unknown, _res: unknown, next: () => void): void =>
      next(),
}));

vi.mock("../../lib/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import mePaymentMethodsRouter from "./me-payment-methods";

const CUSTOMER_ID = "cust-bob-001";
const PATIENT_ID = "aaaaaaaa-1111-1111-8111-111111111111";
const CUSTOMER_EMAIL = "bob@example.com";

function makeApp(customerId: string | null = CUSTOMER_ID): Express {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    if (customerId !== null) {
      const r = req as unknown as Record<string, unknown>;
      r.shopCustomerId = customerId;
      r.shopCustomerEmail = CUSTOMER_EMAIL;
      r.shopCustomerDisplayName = "Bob";
    }
    next();
  });
  app.use("/api", mePaymentMethodsRouter);
  return app;
}

function stubLinkedPatient(email = CUSTOMER_EMAIL) {
  stageSupabaseResponse("shop_customers", "select", {
    data: { customer_id: CUSTOMER_ID, email_lower: email },
  });
  stageSupabaseResponse("patients", "select", {
    data: [{ id: PATIENT_ID }],
  });
}

function stubNoPatient() {
  stageSupabaseResponse("shop_customers", "select", {
    data: { customer_id: CUSTOMER_ID, email_lower: CUSTOMER_EMAIL },
  });
  stageSupabaseResponse("patients", "select", { data: [] });
}

const ENV_KEYS = [
  "RESUPPLY_ALLOWED_ORIGINS",
  "RAILWAY_PUBLIC_DOMAIN",
  "SHOP_PUBLIC_BASE_URL",
] as const;
const savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  supabaseMock.reset();
  vi.clearAllMocks();
  for (const k of ENV_KEYS) savedEnv[k] = process.env[k];
  delete process.env.RESUPPLY_ALLOWED_ORIGINS;
  delete process.env.RAILWAY_PUBLIC_DOMAIN;
  // A trusted base so setup-session can resolve a redirect URL without an
  // Origin header. Individual tests override.
  process.env.SHOP_PUBLIC_BASE_URL = "https://shop.example.com";
  readStripeConfigMock.mockReturnValue({});
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
});

// ── GET /me/payment-methods ───────────────────────────────────────────
describe("GET /me/payment-methods", () => {
  it("401s without a session", async () => {
    const res = await request(makeApp(null)).get("/api/me/payment-methods");
    expect(res.status).toBe(401);
  });

  it("returns the saved-card status for a linked patient", async () => {
    stubLinkedPatient();
    autopayMocks.getActiveAutopayAuthorization.mockResolvedValue({
      autopay_enabled: true,
    });
    const res = await request(makeApp()).get("/api/me/payment-methods");
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ hasCard: true, autopayEnabled: true });
  });

  it("returns an empty state when no patient is linked", async () => {
    stubNoPatient();
    const res = await request(makeApp()).get("/api/me/payment-methods");
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ hasCard: false, autopayEnabled: false });
    expect(autopayMocks.getActiveAutopayAuthorization).not.toHaveBeenCalled();
  });
});

// ── POST /me/payment-methods/setup-session ────────────────────────────
describe("POST /me/payment-methods/setup-session", () => {
  it("401s without a session", async () => {
    const res = await request(makeApp(null)).post(
      "/api/me/payment-methods/setup-session",
    );
    expect(res.status).toBe(401);
  });

  it("400s on an unknown body field (strict schema)", async () => {
    const res = await request(makeApp())
      .post("/api/me/payment-methods/setup-session")
      .send({ bogus: true });
    expect(res.status).toBe(400);
  });

  it("503s when Stripe is not configured", async () => {
    readStripeConfigMock.mockReturnValue(null);
    const res = await request(makeApp())
      .post("/api/me/payment-methods/setup-session")
      .send({ enableAutopay: false });
    expect(res.status).toBe(503);
  });

  it("404s when no patient is linked", async () => {
    stubNoPatient();
    const res = await request(makeApp())
      .post("/api/me/payment-methods/setup-session")
      .send({ enableAutopay: false });
    expect(res.status).toBe(404);
  });

  it("400s invalid_origin when no trusted base can be resolved", async () => {
    delete process.env.SHOP_PUBLIC_BASE_URL;
    stubLinkedPatient();
    const res = await request(makeApp())
      .post("/api/me/payment-methods/setup-session")
      .send({ enableAutopay: false });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_origin");
  });

  it("201s with the Stripe URL on the happy path", async () => {
    stubLinkedPatient();
    getOrCreateStripeCustomerMock.mockResolvedValue({
      stripeCustomerId: "cus_x",
      row: {},
    });
    autopayMocks.createAutopaySetupSession.mockResolvedValue({
      url: "https://checkout.stripe.com/setup",
    });
    const res = await request(makeApp())
      .post("/api/me/payment-methods/setup-session")
      .send({ enableAutopay: true });
    expect(res.status).toBe(201);
    expect(res.body.url).toBe("https://checkout.stripe.com/setup");
    // enableAutopay flows through to the service.
    expect(autopayMocks.createAutopaySetupSession).toHaveBeenCalledWith(
      expect.objectContaining({
        patientId: PATIENT_ID,
        stripeCustomerId: "cus_x",
        enableAutopay: true,
      }),
    );
  });
});

// ── PATCH /me/payment-methods/autopay ─────────────────────────────────
describe("PATCH /me/payment-methods/autopay", () => {
  it("401s without a session", async () => {
    const res = await request(makeApp(null))
      .patch("/api/me/payment-methods/autopay")
      .send({ enabled: true });
    expect(res.status).toBe(401);
  });

  it("400s when `enabled` is missing", async () => {
    const res = await request(makeApp())
      .patch("/api/me/payment-methods/autopay")
      .send({});
    expect(res.status).toBe(400);
  });

  it("409s when there is no card on file", async () => {
    stubLinkedPatient();
    autopayMocks.setAutopayEnabled.mockResolvedValue({
      error: "no_card_on_file",
    });
    const res = await request(makeApp())
      .patch("/api/me/payment-methods/autopay")
      .send({ enabled: true });
    expect(res.status).toBe(409);
  });

  it("200s and echoes the new state on success", async () => {
    stubLinkedPatient();
    autopayMocks.setAutopayEnabled.mockResolvedValue({
      ok: true,
      autopayEnabled: true,
    });
    const res = await request(makeApp())
      .patch("/api/me/payment-methods/autopay")
      .send({ enabled: true });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, autopayEnabled: true });
  });
});

// ── DELETE /me/payment-methods ────────────────────────────────────────
describe("DELETE /me/payment-methods", () => {
  it("401s without a session", async () => {
    const res = await request(makeApp(null)).delete("/api/me/payment-methods");
    expect(res.status).toBe(401);
  });

  it("409s when there is no card on file", async () => {
    stubLinkedPatient();
    autopayMocks.revokeAutopayAuthorization.mockResolvedValue({
      error: "no_card_on_file",
    });
    const res = await request(makeApp()).delete("/api/me/payment-methods");
    expect(res.status).toBe(409);
  });

  it("200s on success", async () => {
    stubLinkedPatient();
    autopayMocks.revokeAutopayAuthorization.mockResolvedValue({ ok: true });
    const res = await request(makeApp()).delete("/api/me/payment-methods");
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true });
  });
});
