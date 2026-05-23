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
  createPaymentCheckoutSession,
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
const stripeCheckoutCreateMock = vi.hoisted(() => vi.fn());
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
    checkout: {
      sessions: {
        create: (...args: unknown[]) => stripeCheckoutCreateMock(...args),
      },
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

// ============================================================================
// createPaymentCheckoutSession — idempotency key
// ============================================================================
// Verify that stripe.checkout.sessions.create receives the RequestOptions
// second argument with idempotencyKey: `pennpaps-patient-checkout-${row.id}`.

const CHECKOUT_PATIENT = "66666666-6666-4666-8666-666666666666";
const CHECKOUT_CLAIM = "77777777-7777-4777-8777-777777777777";
const CHECKOUT_PAYMENT_ID = "88888888-8888-4888-8888-888888888888";

describe("createPaymentCheckoutSession — idempotency key", () => {
  beforeEach(() => {
    supabaseMock.reset();
    stripeConfiguredFlag.value = true;
    stripeCheckoutCreateMock.mockReset();
  });

  it("passes idempotencyKey: pennpaps-patient-checkout-<payment.id> to checkout.sessions.create", async () => {
    // Stage claim ownership check
    stageSupabaseResponse("insurance_claims", "select", {
      data: [
        {
          id: CHECKOUT_CLAIM,
          patient_id: CHECKOUT_PATIENT,
          patient_responsibility_cents: 5000,
        },
      ],
    });
    // Stage patient_payments insert returning the stable row id
    stageSupabaseResponse("patient_payments", "insert", {
      data: { id: CHECKOUT_PAYMENT_ID },
    });
    // Mock stripe returning a valid session with a URL
    stripeCheckoutCreateMock.mockResolvedValue({
      id: "cs_test_fake",
      url: "https://checkout.stripe.com/pay/cs_test_fake",
    });

    const result = await createPaymentCheckoutSession({
      patientId: CHECKOUT_PATIENT,
      allocations: [{ claimId: CHECKOUT_CLAIM, amountAppliedCents: 2000 }],
      successUrl: "https://example.com/success",
      cancelUrl: "https://example.com/cancel",
      initiatorEmail: "patient@example.com",
    });

    // The result should be a successful checkout session
    expect("error" in result).toBe(false);
    if (!("error" in result)) {
      expect(result.url).toBe("https://checkout.stripe.com/pay/cs_test_fake");
      expect(result.paymentId).toBe(CHECKOUT_PAYMENT_ID);
    }

    // Core assertion: the idempotency key was forwarded as a RequestOptions
    // second argument to stripe.checkout.sessions.create.
    expect(stripeCheckoutCreateMock).toHaveBeenCalledOnce();
    const [, requestOptions] = stripeCheckoutCreateMock.mock.calls[0] as [
      unknown,
      { idempotencyKey: string },
    ];
    expect(requestOptions).toBeDefined();
    expect(requestOptions.idempotencyKey).toBe(
      `pennpaps-patient-checkout-${CHECKOUT_PAYMENT_ID}`,
    );
  });
});

// ============================================================================
// PR change: stamp PaymentIntent id before status — sync-succeeded path
// ============================================================================
// The PR separates the initial patient_payments update into two steps:
//   1. Stamp stripe_payment_intent_id + set status to "requires_action" or
//      "pending" (never "succeeded" — even when Stripe returns succeeded
//      synchronously). This is so the webhook can always correlate by PI id.
//   2. If Stripe returned succeeded synchronously, route through the SAME
//      markPaymentStatus check-and-set used by the webhook, not directly
//      through applySucceededPayment.
//
// These tests verify:
//   a. The first update payload never contains status="succeeded" or
//      succeeded_at, regardless of the Stripe intent status.
//   b. When Stripe returns succeeded, the first update sets status="pending"
//      (not succeeded), and markPaymentStatus is invoked to handle the
//      allocation walk with idempotency protection.

const SYNC_PATIENT = "aaaaaaaa-1111-4aaa-8aaa-aaaaaaaaaaaa";
const SYNC_CLAIM = "bbbbbbbb-2222-4bbb-8bbb-bbbbbbbbbbbb";
const SYNC_PAYMENT_ID = "cccccccc-3333-4ccc-8ccc-cccccccccccc";

describe("createPaymentIntent — PI id stamp (PR change)", () => {
  beforeEach(() => {
    supabaseMock.reset();
    stripeConfiguredFlag.value = true;
    stripeIntentCreateMock.mockReset();
  });

  function stageSyncClaim() {
    stageSupabaseResponse("insurance_claims", "select", {
      data: [
        {
          id: SYNC_CLAIM,
          patient_id: SYNC_PATIENT,
          patient_responsibility_cents: 10000,
        },
      ],
    });
  }

  function stageSyncPaymentInsert() {
    stageSupabaseResponse("patient_payments", "insert", {
      data: { id: SYNC_PAYMENT_ID },
    });
  }

  it("does not include status='succeeded' in the first PI-stamp update when Stripe returns pending", async () => {
    stageSyncClaim();
    stageSyncPaymentInsert();
    stripeIntentCreateMock.mockResolvedValue({
      id: "pi_pending_001",
      status: "requires_payment_method",
      client_secret: "pi_pending_001_secret",
    });
    // Stage the first update (stamp) and any subsequent updates.
    stageSupabaseResponse("patient_payments", "update", { data: null });
    stageSupabaseResponse("patient_payments", "update", { data: null });

    await createPaymentIntent({
      patientId: SYNC_PATIENT,
      allocations: [{ claimId: SYNC_CLAIM, amountAppliedCents: 5000 }],
      source: "portal",
      initiatorEmail: "test@example.com",
    });

    const updates = getSupabaseWritePayloads("patient_payments", "update");
    // The first update is the PI-stamp; it must not contain status="succeeded".
    const firstUpdate = updates[0] as Record<string, unknown>;
    expect(firstUpdate).toBeDefined();
    expect(firstUpdate.stripe_payment_intent_id).toBe("pi_pending_001");
    expect(firstUpdate.status).not.toBe("succeeded");
    expect(firstUpdate.succeeded_at).toBeUndefined();
  });

  it("does not include succeeded_at in the PI-stamp update when Stripe returns requires_action", async () => {
    stageSyncClaim();
    stageSyncPaymentInsert();
    stripeIntentCreateMock.mockResolvedValue({
      id: "pi_3dSecure_001",
      status: "requires_action",
      client_secret: "pi_3dSecure_001_secret",
    });
    stageSupabaseResponse("patient_payments", "update", { data: null });

    await createPaymentIntent({
      patientId: SYNC_PATIENT,
      allocations: [{ claimId: SYNC_CLAIM, amountAppliedCents: 5000 }],
      source: "portal",
      initiatorEmail: "test@example.com",
    });

    const updates = getSupabaseWritePayloads("patient_payments", "update");
    const firstUpdate = updates[0] as Record<string, unknown>;
    expect(firstUpdate.status).toBe("requires_action");
    expect(firstUpdate.succeeded_at).toBeUndefined();
  });

  it("stamps stripe_payment_intent_id in the first update (before any succeeded handling)", async () => {
    stageSyncClaim();
    stageSyncPaymentInsert();
    const PI_ID = "pi_stamp_test_xyz";
    stripeIntentCreateMock.mockResolvedValue({
      id: PI_ID,
      status: "requires_payment_method",
      client_secret: `${PI_ID}_secret`,
    });
    stageSupabaseResponse("patient_payments", "update", { data: null });

    await createPaymentIntent({
      patientId: SYNC_PATIENT,
      allocations: [{ claimId: SYNC_CLAIM, amountAppliedCents: 3000 }],
      source: "csr",
      initiatorEmail: "csr@example.com",
    });

    const updates = getSupabaseWritePayloads("patient_payments", "update");
    const firstUpdate = updates[0] as Record<string, unknown>;
    expect(firstUpdate.stripe_payment_intent_id).toBe(PI_ID);
  });
});
