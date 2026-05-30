// Route tests for routes/storefront/me-payments.ts
//
// PR changes:
//   1. resolvePatientForCustomer now returns { patientId, customerEmail } (was just { patientId }).
//   2. initiatorEmail now uses link.customerEmail (was using customerId — the wrong value).
//   3. Error status code mapping updated:
//        stripe_not_configured → 503
//        stripe_rejected        → 502  (new code path)
//        other errors           → 409
//
// Coverage matrix:
//   POST /me/payments/intent — unauthenticated (401), invalid body (400),
//                              no linked patient (404), stripe_not_configured (503),
//                              stripe_rejected (502), claim errors (409),
//                              happy path (201 with paymentId + clientSecret).

import { describe, it, expect, vi, beforeEach } from "vitest";
import express, { type Express } from "express";
import request from "supertest";

import {
  installSupabaseMock,
  stageSupabaseResponse,
} from "../../test-helpers/supabase-mock";

const supabaseMock = installSupabaseMock();

// Mock createPaymentIntent from the billing library so we can control its
// return value independently of Stripe.
const createPaymentIntentMock = vi.hoisted(() => vi.fn());
vi.mock("../../lib/billing/patient-payment", () => ({
  createPaymentIntent: (...a: unknown[]) => createPaymentIntentMock(...a),
}));

vi.mock("../../lib/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import mePaymentsRouter from "./me-payments";

const CUSTOMER_ID = "cust-bob-001";
const PATIENT_ID = "aaaaaaaa-1111-1111-8111-111111111111";
const CUSTOMER_EMAIL = "bob@example.com";
const CLAIM_ID = "cccccccc-1111-1111-8111-111111111111";

function makeApp(customerId: string | null = CUSTOMER_ID): Express {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    if (customerId !== null) {
      (req as unknown as Record<string, unknown>).shopCustomerId = customerId;
    }
    next();
  });
  app.use("/resupply-api", mePaymentsRouter);
  return app;
}

function stubLinkedPatient(email = CUSTOMER_EMAIL) {
  stageSupabaseResponse("shop_customers", "select", {
    data: { customer_id: CUSTOMER_ID, email_lower: email },
  });
  // resolvePatientForCustomer now uses .limit(2) to detect the
  // ambiguous email-collision case — stage as a one-element array.
  stageSupabaseResponse("patients", "select", {
    data: [{ id: PATIENT_ID, email }],
  });
}

const VALID_BODY = {
  allocations: [{ claimId: CLAIM_ID, amountAppliedCents: 1000 }],
};

beforeEach(() => {
  supabaseMock.reset();
  createPaymentIntentMock.mockReset();
});

// ===========================================================================
// Authentication guard
// ===========================================================================
describe("POST /me/payments/intent — authentication", () => {
  it("returns 401 when no shopCustomerId is present", async () => {
    const res = await request(makeApp(null))
      .post("/resupply-api/me/payments/intent")
      .send(VALID_BODY);
    expect(res.status).toBe(401);
    expect(res.body.error).toBe("sign_in_required");
  });
});

// ===========================================================================
// Body validation
// ===========================================================================
describe("POST /me/payments/intent — body validation", () => {
  it("returns 400 when the request body is missing allocations", async () => {
    const res = await request(makeApp())
      .post("/resupply-api/me/payments/intent")
      .send({});
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_body");
  });

  it("returns 400 when allocations array is empty", async () => {
    const res = await request(makeApp())
      .post("/resupply-api/me/payments/intent")
      .send({ allocations: [] });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_body");
  });

  it("returns 400 when claimId is not a UUID", async () => {
    const res = await request(makeApp())
      .post("/resupply-api/me/payments/intent")
      .send({
        allocations: [{ claimId: "not-a-uuid", amountAppliedCents: 100 }],
      });
    expect(res.status).toBe(400);
  });

  it("returns 400 when amountAppliedCents is zero or negative", async () => {
    const res = await request(makeApp())
      .post("/resupply-api/me/payments/intent")
      .send({
        allocations: [{ claimId: CLAIM_ID, amountAppliedCents: 0 }],
      });
    expect(res.status).toBe(400);
  });
});

// ===========================================================================
// No linked patient
// ===========================================================================
describe("POST /me/payments/intent — no linked patient", () => {
  it("returns 404 when no patient is linked to the customer", async () => {
    stageSupabaseResponse("shop_customers", "select", { data: null });

    const res = await request(makeApp())
      .post("/resupply-api/me/payments/intent")
      .send(VALID_BODY);

    expect(res.status).toBe(404);
    expect(res.body.error).toBe("no_linked_patient");
  });
});

// ===========================================================================
// Error status code mapping (PR change)
// ===========================================================================
describe("POST /me/payments/intent — error status code mapping (PR change)", () => {
  it("returns 503 for stripe_not_configured", async () => {
    stubLinkedPatient();
    createPaymentIntentMock.mockResolvedValue({
      error: "stripe_not_configured",
      message: "Stripe secret key is not set",
    });

    const res = await request(makeApp())
      .post("/resupply-api/me/payments/intent")
      .send(VALID_BODY);

    expect(res.status).toBe(503);
    expect(res.body.error).toBe("stripe_not_configured");
  });

  it("returns 502 for stripe_rejected (PR change — new code path)", async () => {
    stubLinkedPatient();
    createPaymentIntentMock.mockResolvedValue({
      error: "stripe_rejected",
      message: "Stripe rejected the payment intent create",
    });

    const res = await request(makeApp())
      .post("/resupply-api/me/payments/intent")
      .send(VALID_BODY);

    expect(res.status).toBe(502);
    expect(res.body.error).toBe("stripe_rejected");
  });

  it("returns 409 for no_allocations", async () => {
    stubLinkedPatient();
    createPaymentIntentMock.mockResolvedValue({
      error: "no_allocations",
      message: "at least one claim allocation is required",
    });

    const res = await request(makeApp())
      .post("/resupply-api/me/payments/intent")
      .send(VALID_BODY);

    expect(res.status).toBe(409);
  });

  it("returns 409 for claim_not_owned", async () => {
    stubLinkedPatient();
    createPaymentIntentMock.mockResolvedValue({
      error: "claim_not_owned",
      message: "claim X does not belong to this patient",
    });

    const res = await request(makeApp())
      .post("/resupply-api/me/payments/intent")
      .send(VALID_BODY);

    expect(res.status).toBe(409);
  });

  it("returns 409 for claim_balance_mismatch", async () => {
    stubLinkedPatient();
    createPaymentIntentMock.mockResolvedValue({
      error: "claim_balance_mismatch",
      message: "allocation exceeds open balance",
    });

    const res = await request(makeApp())
      .post("/resupply-api/me/payments/intent")
      .send(VALID_BODY);

    expect(res.status).toBe(409);
  });

  it("does NOT return 503 for stripe_rejected (regression guard)", async () => {
    stubLinkedPatient();
    createPaymentIntentMock.mockResolvedValue({
      error: "stripe_rejected",
      message: "Stripe rejected the payment intent create",
    });

    const res = await request(makeApp())
      .post("/resupply-api/me/payments/intent")
      .send(VALID_BODY);

    // Before the PR this would have been 503 (same bucket as stripe_not_configured).
    expect(res.status).not.toBe(503);
    expect(res.status).toBe(502);
  });
});

// ===========================================================================
// customerEmail used as initiatorEmail (PR change)
// ===========================================================================
describe("POST /me/payments/intent — initiatorEmail uses customerEmail (PR change)", () => {
  it("passes the customer's email (not their ID) as initiatorEmail to createPaymentIntent", async () => {
    stubLinkedPatient("alice@portal.example.com");
    createPaymentIntentMock.mockResolvedValue({
      paymentId: "pay_1",
      paymentIntentClientSecret: "pi_secret",
      amountCents: 1000,
    });

    await request(makeApp())
      .post("/resupply-api/me/payments/intent")
      .send(VALID_BODY);

    expect(createPaymentIntentMock).toHaveBeenCalledTimes(1);
    const callArg = createPaymentIntentMock.mock.calls[0]?.[0] as Record<
      string,
      unknown
    >;
    // initiatorEmail must be the email address, not the customerId.
    expect(callArg.initiatorEmail).toBe("alice@portal.example.com");
    expect(callArg.initiatorEmail).not.toBe(CUSTOMER_ID);
  });

  it("passes source='portal' (not 'csr') to createPaymentIntent", async () => {
    stubLinkedPatient();
    createPaymentIntentMock.mockResolvedValue({
      paymentId: "pay_2",
      paymentIntentClientSecret: "pi_secret2",
      amountCents: 1000,
    });

    await request(makeApp())
      .post("/resupply-api/me/payments/intent")
      .send(VALID_BODY);

    const callArg = createPaymentIntentMock.mock.calls[0]?.[0] as Record<
      string,
      unknown
    >;
    expect(callArg.source).toBe("portal");
  });
});

// ===========================================================================
// Happy path
// ===========================================================================
describe("POST /me/payments/intent — happy path", () => {
  it("returns 201 with paymentId, clientSecret, and amountCents on success", async () => {
    stubLinkedPatient();
    createPaymentIntentMock.mockResolvedValue({
      paymentId: "pay_happy",
      paymentIntentClientSecret: "pi_happy_secret",
      amountCents: 1000,
    });

    const res = await request(makeApp())
      .post("/resupply-api/me/payments/intent")
      .send(VALID_BODY);

    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      paymentId: "pay_happy",
      clientSecret: "pi_happy_secret",
      amountCents: 1000,
    });
  });

  it("forwards the allocations array to createPaymentIntent unchanged", async () => {
    stubLinkedPatient();
    createPaymentIntentMock.mockResolvedValue({
      paymentId: "pay_alloc",
      paymentIntentClientSecret: "pi_alloc_secret",
      amountCents: 2500,
    });

    const allocations = [{ claimId: CLAIM_ID, amountAppliedCents: 2500 }];
    await request(makeApp())
      .post("/resupply-api/me/payments/intent")
      .send({ allocations });

    const callArg = createPaymentIntentMock.mock.calls[0]?.[0] as Record<
      string,
      unknown
    >;
    expect(callArg.allocations).toEqual(allocations);
  });

  it("passes the note field through when provided", async () => {
    stubLinkedPatient();
    createPaymentIntentMock.mockResolvedValue({
      paymentId: "pay_note",
      paymentIntentClientSecret: "pi_note_secret",
      amountCents: 1000,
    });

    await request(makeApp())
      .post("/resupply-api/me/payments/intent")
      .send({ ...VALID_BODY, note: "Payment for January claim" });

    const callArg = createPaymentIntentMock.mock.calls[0]?.[0] as Record<
      string,
      unknown
    >;
    expect(callArg.note).toBe("Payment for January claim");
  });
});
