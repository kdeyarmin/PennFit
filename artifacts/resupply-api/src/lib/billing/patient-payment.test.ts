// Tests for the patient-payment validation surface. We don't
// exercise the real Stripe call (no test keys in CI); instead we
// verify the input-validation paths that fire before any Stripe
// round-trip + the post-success allocation apply.

import { describe, expect, it, beforeEach } from "vitest";

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
