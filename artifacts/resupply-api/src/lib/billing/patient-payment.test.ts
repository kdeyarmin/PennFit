// Tests for the patient-payment validation surface. We don't
// exercise the real Stripe call (no test keys in CI); instead we
// verify the input-validation paths that fire before any Stripe
// round-trip + the post-success allocation apply.
//
// PR additions (stripe_rejected):
//   The catch block that fires when Stripe throws during
//   paymentIntents.create now returns error:"stripe_rejected"
//   instead of the old "stripe_not_configured". Tests below verify
//   the new error code and confirm the old code path is gone.

import { describe, expect, it, vi, beforeEach } from "vitest";

import {
  getSupabaseWritePayloads,
  installSupabaseMock,
  stageSupabaseResponse,
} from "../../test-helpers/supabase-mock";

const supabaseMock = installSupabaseMock();

import {
  applySucceededPayment,
  createPaymentIntent,
} from "./patient-payment";

const PATIENT = "11111111-1111-4111-8111-111111111111";
const CLAIM1 = "22222222-2222-4222-8222-222222222222";

describe("createPaymentIntent — validation paths", () => {
  beforeEach(() => supabaseMock.reset());

  it("rejects empty allocations", async () => {
    const r = await createPaymentIntent({
      patientId: PATIENT,
      allocations: [],
      source: "portal",
      initiatorEmail: "x@x",
    });
    expect("error" in r).toBe(true);
    if ("error" in r) {
      expect(r.error).toBe("no_allocations");
    }
  });

  it("rejects zero-total allocation", async () => {
    const r = await createPaymentIntent({
      patientId: PATIENT,
      allocations: [{ claimId: CLAIM1, amountAppliedCents: 0 }],
      source: "portal",
      initiatorEmail: "x@x",
    });
    expect("error" in r).toBe(true);
    if ("error" in r) {
      expect(r.error).toBe("no_allocations");
    }
  });

  it("rejects when Stripe is not configured (no STRIPE_SECRET_KEY)", async () => {
    const r = await createPaymentIntent({
      patientId: PATIENT,
      allocations: [{ claimId: CLAIM1, amountAppliedCents: 1000 }],
      source: "portal",
      initiatorEmail: "x@x",
    });
    expect("error" in r).toBe(true);
    if ("error" in r) {
      expect(r.error).toBe("stripe_not_configured");
    }
  });
});

describe("applySucceededPayment — allocation walk", () => {
  beforeEach(() => supabaseMock.reset());

  it("decrements patient_responsibility_cents on each allocated claim", async () => {
    const supabase = installSupabaseMock(); // get a real reference
    // 1. patient_payments lookup
    stageSupabaseResponse("patient_payments", "select", {
      data: {
        id: "p-1",
        status: "succeeded",
        patient_id: PATIENT,
        applied_claims_json: [
          { claimId: CLAIM1, amountAppliedCents: 4000 },
        ],
      },
    });
    // 2. insurance_claims lookup
    stageSupabaseResponse("insurance_claims", "select", {
      data: { id: CLAIM1, patient_responsibility_cents: 12500 },
    });
    stageSupabaseResponse("insurance_claims", "update", { data: {} });
    stageSupabaseResponse("insurance_claim_events", "insert", { data: {} });
    void supabase;
    // Run.
    const realSupabase = (await import("@workspace/resupply-db"))
      .getSupabaseServiceRoleClient();
    await applySucceededPayment(realSupabase, "p-1");
    const claimUpdates = getSupabaseWritePayloads(
      "insurance_claims",
      "update",
    );
    expect(claimUpdates).toHaveLength(1);
    expect(
      (claimUpdates[0] as Record<string, unknown>).patient_responsibility_cents,
    ).toBe(8500); // 12500 - 4000
    const events = getSupabaseWritePayloads("insurance_claim_events", "insert");
    expect(events).toHaveLength(1);
    expect((events[0] as Record<string, unknown>).event_type).toBe("note");
    expect((events[0] as Record<string, unknown>).amount_cents).toBe(4000);
  });

  it("clamps to zero rather than going negative", async () => {
    stageSupabaseResponse("patient_payments", "select", {
      data: {
        id: "p-2",
        status: "succeeded",
        patient_id: PATIENT,
        applied_claims_json: [
          { claimId: CLAIM1, amountAppliedCents: 99999 },
        ],
      },
    });
    stageSupabaseResponse("insurance_claims", "select", {
      data: { id: CLAIM1, patient_responsibility_cents: 100 },
    });
    stageSupabaseResponse("insurance_claims", "update", { data: {} });
    stageSupabaseResponse("insurance_claim_events", "insert", { data: {} });
    const realSupabase = (await import("@workspace/resupply-db"))
      .getSupabaseServiceRoleClient();
    await applySucceededPayment(realSupabase, "p-2");
    const claimUpdates = getSupabaseWritePayloads(
      "insurance_claims",
      "update",
    );
    expect(
      (claimUpdates[0] as Record<string, unknown>).patient_responsibility_cents,
    ).toBe(0);
  });

  it("is a no-op when the payment row is missing", async () => {
    stageSupabaseResponse("patient_payments", "select", { data: null });
    const realSupabase = (await import("@workspace/resupply-db"))
      .getSupabaseServiceRoleClient();
    await applySucceededPayment(realSupabase, "missing");
    expect(getSupabaseWritePayloads("insurance_claims", "update")).toEqual(
      [],
    );
  });
});

// ============================================================================
// PR change: stripe_rejected — Stripe accepts the call but rejects the intent
// ============================================================================
// We mock the Stripe client to throw so we can test the catch branch without
// a real API key. The mock must be registered before importing the module, so
// we use vi.mock + vi.hoisted.

const stripeIntentCreateMock = vi.hoisted(() => vi.fn());
// Default to false so the existing "stripe_not_configured" tests continue to
// work without supabase stages. The stripe_rejected describe block resets to
// true in its own beforeEach.
const stripeConfiguredFlag = vi.hoisted(() => ({ value: false }));

vi.mock("../../lib/stripe/config", () => ({
  readStripeConfigOrNull: () =>
    stripeConfiguredFlag.value ? { secretKey: "sk_test_fake" } : null,
  getStripeClient: () => ({
    paymentIntents: {
      create: (...args: unknown[]) => stripeIntentCreateMock(...args),
    },
  }),
}));

vi.mock("../../lib/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const PATIENT_STR = "33333333-3333-4333-8333-333333333333";
const CLAIM_STR = "44444444-4444-4444-8444-444444444444";
const PAYMENT_STR_ID = "55555555-5555-4555-8555-555555555555";

describe("createPaymentIntent — stripe_rejected (PR change)", () => {
  beforeEach(() => {
    supabaseMock.reset();
    stripeConfiguredFlag.value = true;
    stripeIntentCreateMock.mockReset();
  });

  function stageClaimOwned() {
    stageSupabaseResponse("insurance_claims", "select", {
      data: [
        {
          id: CLAIM_STR,
          patient_id: PATIENT_STR,
          patient_responsibility_cents: 5000,
        },
      ],
    });
  }

  function stagePaymentInsert() {
    stageSupabaseResponse("patient_payments", "insert", {
      data: { id: PAYMENT_STR_ID },
    });
  }

  function stagePaymentUpdate() {
    stageSupabaseResponse("patient_payments", "update", { data: null });
  }

  it("returns stripe_rejected when Stripe throws during paymentIntents.create", async () => {
    stageClaimOwned();
    stagePaymentInsert();
    stripeIntentCreateMock.mockRejectedValue(new Error("card_declined"));
    stagePaymentUpdate();

    const result = await createPaymentIntent({
      patientId: PATIENT_STR,
      allocations: [{ claimId: CLAIM_STR, amountAppliedCents: 1000 }],
      source: "portal",
      initiatorEmail: "patient@example.com",
    });

    expect("error" in result).toBe(true);
    if ("error" in result) {
      expect(result.error).toBe("stripe_rejected");
    }
  });

  it("does NOT return stripe_not_configured when Stripe rejects (regression guard)", async () => {
    stageClaimOwned();
    stagePaymentInsert();
    stripeIntentCreateMock.mockRejectedValue(new Error("api_connection_error"));
    stagePaymentUpdate();

    const result = await createPaymentIntent({
      patientId: PATIENT_STR,
      allocations: [{ claimId: CLAIM_STR, amountAppliedCents: 1000 }],
      source: "portal",
      initiatorEmail: "patient@example.com",
    });

    // Before the PR this erroneously returned "stripe_not_configured".
    if ("error" in result) {
      expect(result.error).not.toBe("stripe_not_configured");
      expect(result.error).toBe("stripe_rejected");
    }
  });

  it("marks the pending payment row as 'failed' before returning stripe_rejected", async () => {
    stageClaimOwned();
    stagePaymentInsert();
    stripeIntentCreateMock.mockRejectedValue(new Error("stripe_error"));
    stagePaymentUpdate();

    await createPaymentIntent({
      patientId: PATIENT_STR,
      allocations: [{ claimId: CLAIM_STR, amountAppliedCents: 1000 }],
      source: "portal",
      initiatorEmail: "patient@example.com",
    });

    const updatePayloads = getSupabaseWritePayloads("patient_payments", "update");
    expect(updatePayloads.length).toBeGreaterThanOrEqual(1);
    expect((updatePayloads[0] as Record<string, unknown>).status).toBe("failed");
  });

  it("records the thrown error message in failure_reason", async () => {
    stageClaimOwned();
    stagePaymentInsert();
    const errMsg = "Stripe: insufficient_funds";
    stripeIntentCreateMock.mockRejectedValue(new Error(errMsg));
    stagePaymentUpdate();

    await createPaymentIntent({
      patientId: PATIENT_STR,
      allocations: [{ claimId: CLAIM_STR, amountAppliedCents: 1000 }],
      source: "portal",
      initiatorEmail: "patient@example.com",
    });

    const updatePayloads = getSupabaseWritePayloads("patient_payments", "update");
    const payload = updatePayloads[0] as Record<string, unknown>;
    expect(typeof payload.failure_reason).toBe("string");
    expect((payload.failure_reason as string)).toContain("insufficient_funds");
  });

  it("calls paymentIntents.create with the idempotency key derived from patient_payment.id", async () => {
    stageClaimOwned();
    stagePaymentInsert();
    stripeIntentCreateMock.mockResolvedValue({
      id: "pi_test_123",
      status: "requires_payment_method",
      client_secret: "pi_test_123_secret",
    });
    stagePaymentUpdate();

    await createPaymentIntent({
      patientId: PATIENT_STR,
      allocations: [{ claimId: CLAIM_STR, amountAppliedCents: 1000 }],
      source: "portal",
      initiatorEmail: "patient@example.com",
    });

    expect(stripeIntentCreateMock).toHaveBeenCalledWith(
      expect.objectContaining({ metadata: expect.any(Object) }),
      { idempotencyKey: `pennpaps-patient-payment-${PAYMENT_STR_ID}` },
    );
  });

  it("returns stripe_not_configured (not stripe_rejected) when no key is set", async () => {
    // Distinct path: stripe_not_configured fires BEFORE hitting Stripe.
    stripeConfiguredFlag.value = false;

    const result = await createPaymentIntent({
      patientId: PATIENT_STR,
      allocations: [{ claimId: CLAIM_STR, amountAppliedCents: 1000 }],
      source: "portal",
      initiatorEmail: "patient@example.com",
    });

    expect("error" in result).toBe(true);
    if ("error" in result) {
      expect(result.error).toBe("stripe_not_configured");
      expect(result.error).not.toBe("stripe_rejected");
    }
  });
});
