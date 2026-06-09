// Route tests for POST /admin/patients/:id/payment-link.
//
// Coverage:
//   * happy path (email) → 201, returns the Stripe URL; vendor not
//     configured in the test env so delivered:false but the link stands
//   * patient not found → 404
//   * chosen channel has no contact on file → 422
//   * SMS to a non-active patient → 409 (STOP opt-out guard)
//   * invalid body (amount below the 50¢ floor) → 400
//   * Stripe not configured → 503
//
// The Stripe + patient_payments machinery
// (createAdhocPaymentCheckoutSession) is mocked here — it has its own
// coverage via the sibling patient-payment flows. These tests pin the
// route's validation, contact-resolution, and delivery wiring.

import { describe, it, expect, vi, beforeEach } from "vitest";
import express, { type Express } from "express";
import request from "supertest";

import {
  makeRequireAdminMock,
  type MockAdminCtx,
} from "../../test-helpers/auth-mocks";
import {
  installSupabaseMock,
  stageSupabaseResponse,
} from "../../test-helpers/supabase-mock";

const supabaseMock = installSupabaseMock();

const { mockAdmin } = vi.hoisted(() => ({
  mockAdmin: { current: null as MockAdminCtx | null },
}));
vi.mock("../../middlewares/requireAdmin", () =>
  makeRequireAdminMock(mockAdmin),
);

// Email/SMS clients degrade to "not configured" in the test env, so
// delivery returns delivered:false but the link is still returned.
vi.mock("@workspace/resupply-email", async () => {
  const actual = await vi.importActual<
    typeof import("@workspace/resupply-email")
  >("@workspace/resupply-email");
  return {
    ...actual,
    createSendgridClient: () => {
      throw new actual.EmailConfigError("no key in test");
    },
  };
});
vi.mock("@workspace/resupply-telecom", async () => {
  const actual = await vi.importActual<
    typeof import("@workspace/resupply-telecom")
  >("@workspace/resupply-telecom");
  return {
    ...actual,
    createTwilioSmsClient: () => {
      throw new actual.TwilioConfigError("no creds in test");
    },
  };
});

const { mockCreateSession } = vi.hoisted(() => ({
  mockCreateSession: vi.fn(),
}));
vi.mock("../../lib/billing/patient-payment", () => ({
  createAdhocPaymentCheckoutSession: mockCreateSession,
}));

import patientPaymentLinkRouter from "./patient-payment-link";

const PATIENT_ID = "22222222-2222-4222-8222-222222222222";
const PAYMENT_ID = "33333333-3333-4333-8333-333333333333";
const CHECKOUT_URL = "https://checkout.stripe.com/c/pay/test_session_123";

function makeApp(): Express {
  const app = express();
  app.use(express.json());
  app.use("/resupply-api", patientPaymentLinkRouter);
  return app;
}

function stagePatient(over: Record<string, unknown> = {}): void {
  stageSupabaseResponse("patients", "select", {
    data: {
      id: PATIENT_ID,
      status: "active",
      email: "patient@example.com",
      phone_e164: "+12155551234",
      legal_first_name: "Jordan",
      ...over,
    },
  });
}

beforeEach(() => {
  supabaseMock.reset();
  mockCreateSession.mockReset();
  mockCreateSession.mockResolvedValue({
    paymentId: PAYMENT_ID,
    url: CHECKOUT_URL,
    amountCents: 4999,
  });
  mockAdmin.current = {
    userId: "u_admin_1",
    email: "ops@penn.example.com",
    role: "admin",
  };
  process.env.SHOP_PUBLIC_BASE_URL = "https://pennpaps.example.com";
});

describe("POST /admin/patients/:id/payment-link", () => {
  it("creates a payment link by email and returns the Stripe URL", async () => {
    stagePatient();
    const res = await request(makeApp())
      .post(`/resupply-api/admin/patients/${PATIENT_ID}/payment-link`)
      .send({ channel: "email", amountCents: 4999, memo: "October copay" });
    expect(res.status).toBe(201);
    expect(res.body.paymentId).toBe(PAYMENT_ID);
    expect(res.body.channel).toBe("email");
    expect(res.body.amountCents).toBe(4999);
    expect(res.body.paymentUrl).toBe(CHECKOUT_URL);
    // No email configured in test → delivered:false, link still given.
    expect(res.body.delivered).toBe(false);

    expect(mockCreateSession).toHaveBeenCalledTimes(1);
    const arg = mockCreateSession.mock.calls[0]![0] as Record<string, unknown>;
    expect(arg.patientId).toBe(PATIENT_ID);
    expect(arg.amountCents).toBe(4999);
    expect(arg.description).toBe("October copay");
  });

  it("404s when the patient does not exist", async () => {
    stageSupabaseResponse("patients", "select", { data: null });
    const res = await request(makeApp())
      .post(`/resupply-api/admin/patients/${PATIENT_ID}/payment-link`)
      .send({ channel: "email", amountCents: 1000 });
    expect(res.status).toBe(404);
    expect(res.body.error).toBe("patient_not_found");
    expect(mockCreateSession).not.toHaveBeenCalled();
  });

  it("422s when the chosen channel has no contact on file", async () => {
    stagePatient({ email: null });
    const res = await request(makeApp())
      .post(`/resupply-api/admin/patients/${PATIENT_ID}/payment-link`)
      .send({ channel: "email", amountCents: 1000 });
    expect(res.status).toBe(422);
    expect(res.body.error).toBe("email_required");
    expect(mockCreateSession).not.toHaveBeenCalled();
  });

  it("409s when sending SMS to a non-active patient (STOP opt-out)", async () => {
    stagePatient({ status: "paused" });
    const res = await request(makeApp())
      .post(`/resupply-api/admin/patients/${PATIENT_ID}/payment-link`)
      .send({ channel: "sms", amountCents: 1000 });
    expect(res.status).toBe(409);
    expect(res.body.error).toBe("patient_not_active");
    expect(mockCreateSession).not.toHaveBeenCalled();
  });

  it("400s on an invalid body (amount below the 50-cent floor)", async () => {
    const res = await request(makeApp())
      .post(`/resupply-api/admin/patients/${PATIENT_ID}/payment-link`)
      .send({ channel: "email", amountCents: 10 });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_body");
    expect(mockCreateSession).not.toHaveBeenCalled();
  });

  it("503s when Stripe is not configured", async () => {
    stagePatient();
    mockCreateSession.mockResolvedValue({
      error: "stripe_not_configured",
      message: "Stripe secret key is not set",
    });
    const res = await request(makeApp())
      .post(`/resupply-api/admin/patients/${PATIENT_ID}/payment-link`)
      .send({ channel: "email", amountCents: 1000 });
    expect(res.status).toBe(503);
    expect(res.body.error).toBe("stripe_not_configured");
  });
});
