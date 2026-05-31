// Tests for reactivatePatient (new in this PR).
//
// reactivatePatient is the exact inverse of pausePatient: it flips a
// `paused` patient back to `active` and re-enables the shop_customers
// SMS flags (smsMarketing: true, smsTransactional: true).
//
// Key invariants tested here:
//   1. A paused patient is set to active and shop_customers SMS flags
//      are re-enabled.
//   2. The update is guarded to `status = 'paused'` rows only — a
//      non-paused (e.g. archived) patient is a no-op.
//   3. If the patient has no email the function returns without
//      touching shop_customers.
//   4. If there is no matching shop_customers row the function returns
//      without error.
//   5. DB errors propagate as thrown exceptions.
//   6. Existing communication_preferences keys are preserved; only
//      smsMarketing and smsTransactional are overwritten.

import { describe, it, expect, beforeEach } from "vitest";

import {
  installSupabaseMock,
  stageSupabaseResponse,
} from "../../test-helpers/supabase-mock";

const supabaseMock = installSupabaseMock();

import {
  decideCoverageBlock,
  placeResupplyOrderForConversation,
  reactivatePatient,
} from "./order-flow";
import { invalidateFeatureFlagCache } from "../feature-flags";

beforeEach(() => {
  supabaseMock.reset();
  invalidateFeatureFlagCache();
});

const PATIENT_ID = "00000000-0000-4000-8000-000000000011";
const CUSTOMER_ID = "00000000-0000-4000-8000-000000000022";

// ---------------------------------------------------------------------------
// Happy path
// ---------------------------------------------------------------------------

describe("reactivatePatient — happy path", () => {
  it("sets patient status to active and re-enables sms flags", async () => {
    // patients update (guarded by .eq("status","paused")) returns the updated row
    stageSupabaseResponse("patients", "update", {
      data: { id: PATIENT_ID, email: "patient@example.com" },
      error: null,
    });
    // shop_customers select by email_lower
    stageSupabaseResponse("shop_customers", "select", {
      data: {
        customer_id: CUSTOMER_ID,
        communication_preferences: {
          smsMarketing: false,
          smsTransactional: false,
        },
      },
      error: null,
    });
    // shop_customers update
    stageSupabaseResponse("shop_customers", "update", {
      data: null,
      error: null,
    });

    await expect(reactivatePatient(PATIENT_ID)).resolves.toBeUndefined();

    // Verify the patient update was called once
    expect(supabaseMock.callCount("patients", "update")).toBe(1);
    const [patientPayload] = supabaseMock.writePayloads(
      "patients",
      "update",
    ) as Array<Record<string, unknown>>;
    expect(patientPayload!.status).toBe("active");

    // Verify shop_customers was updated with smsMarketing and smsTransactional = true
    expect(supabaseMock.callCount("shop_customers", "update")).toBe(1);
    const [custPayload] = supabaseMock.writePayloads(
      "shop_customers",
      "update",
    ) as Array<Record<string, unknown>>;
    const prefs = custPayload!.communication_preferences as Record<
      string,
      unknown
    >;
    expect(prefs.smsMarketing).toBe(true);
    expect(prefs.smsTransactional).toBe(true);
  });

  it("preserves existing communication_preferences keys while enabling SMS", async () => {
    stageSupabaseResponse("patients", "update", {
      data: { id: PATIENT_ID, email: "patient@example.com" },
      error: null,
    });
    stageSupabaseResponse("shop_customers", "select", {
      data: {
        customer_id: CUSTOMER_ID,
        communication_preferences: {
          smsMarketing: false,
          smsTransactional: false,
          emailMarketing: true,
          someOtherKey: "preserved",
        },
      },
      error: null,
    });
    stageSupabaseResponse("shop_customers", "update", {
      data: null,
      error: null,
    });

    await reactivatePatient(PATIENT_ID);

    const [custPayload] = supabaseMock.writePayloads(
      "shop_customers",
      "update",
    ) as Array<Record<string, unknown>>;
    const prefs = custPayload!.communication_preferences as Record<
      string,
      unknown
    >;
    // New values
    expect(prefs.smsMarketing).toBe(true);
    expect(prefs.smsTransactional).toBe(true);
    // Preserved values
    expect(prefs.emailMarketing).toBe(true);
    expect(prefs.someOtherKey).toBe("preserved");
  });

  it("works when shop_customers has null communication_preferences", async () => {
    stageSupabaseResponse("patients", "update", {
      data: { id: PATIENT_ID, email: "patient@example.com" },
      error: null,
    });
    stageSupabaseResponse("shop_customers", "select", {
      data: {
        customer_id: CUSTOMER_ID,
        communication_preferences: null,
      },
      error: null,
    });
    stageSupabaseResponse("shop_customers", "update", {
      data: null,
      error: null,
    });

    await expect(reactivatePatient(PATIENT_ID)).resolves.toBeUndefined();

    const [custPayload] = supabaseMock.writePayloads(
      "shop_customers",
      "update",
    ) as Array<Record<string, unknown>>;
    const prefs = custPayload!.communication_preferences as Record<
      string,
      unknown
    >;
    expect(prefs.smsMarketing).toBe(true);
    expect(prefs.smsTransactional).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// No-op paths
// ---------------------------------------------------------------------------

describe("reactivatePatient — no-op paths", () => {
  it("returns without touching shop_customers when the patient is not paused (null returned from conditional update)", async () => {
    // PostgREST returns null from the conditional update when no row
    // matched the .eq("status", "paused") guard — simulates an already-
    // active or archived patient.
    stageSupabaseResponse("patients", "update", {
      data: null,
      error: null,
    });

    await expect(reactivatePatient(PATIENT_ID)).resolves.toBeUndefined();

    // shop_customers should never be touched
    expect(supabaseMock.callCount("shop_customers", "select")).toBe(0);
    expect(supabaseMock.callCount("shop_customers", "update")).toBe(0);
  });

  it("returns without touching shop_customers when the patient has no email", async () => {
    stageSupabaseResponse("patients", "update", {
      data: { id: PATIENT_ID, email: null },
      error: null,
    });

    await expect(reactivatePatient(PATIENT_ID)).resolves.toBeUndefined();

    expect(supabaseMock.callCount("shop_customers", "select")).toBe(0);
    expect(supabaseMock.callCount("shop_customers", "update")).toBe(0);
  });

  it("returns without error when no matching shop_customers row exists", async () => {
    stageSupabaseResponse("patients", "update", {
      data: { id: PATIENT_ID, email: "noaccount@example.com" },
      error: null,
    });
    // Unstaged select returns null (no matching row)
    stageSupabaseResponse("shop_customers", "select", {
      data: null,
      error: null,
    });

    await expect(reactivatePatient(PATIENT_ID)).resolves.toBeUndefined();

    // Should not attempt to update a row that doesn't exist
    expect(supabaseMock.callCount("shop_customers", "update")).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Error propagation
// ---------------------------------------------------------------------------

describe("reactivatePatient — error propagation", () => {
  it("throws when the patients update returns an error", async () => {
    stageSupabaseResponse("patients", "update", {
      data: null,
      error: { message: "patients write failed", code: "PGRST500" },
    });

    await expect(reactivatePatient(PATIENT_ID)).rejects.toMatchObject({
      message: "patients write failed",
    });
  });

  it("throws when the shop_customers update returns an error", async () => {
    stageSupabaseResponse("patients", "update", {
      data: { id: PATIENT_ID, email: "patient@example.com" },
      error: null,
    });
    stageSupabaseResponse("shop_customers", "select", {
      data: {
        customer_id: CUSTOMER_ID,
        communication_preferences: null,
      },
      error: null,
    });
    stageSupabaseResponse("shop_customers", "update", {
      data: null,
      error: { message: "shop_customers write failed", code: "PGRST500" },
    });

    await expect(reactivatePatient(PATIENT_ID)).rejects.toMatchObject({
      message: "shop_customers write failed",
    });
  });
});

// ---------------------------------------------------------------------------
// Contrast with pausePatient (regression guard)
// ---------------------------------------------------------------------------
// Ensure reactivatePatient does the OPPOSITE of pausePatient with respect
// to the smsMarketing / smsTransactional flags.

describe("reactivatePatient — contrast with pausePatient (regression guard)", () => {
  it("sets smsMarketing=true and smsTransactional=true (not false)", async () => {
    stageSupabaseResponse("patients", "update", {
      data: { id: PATIENT_ID, email: "patient@example.com" },
      error: null,
    });
    stageSupabaseResponse("shop_customers", "select", {
      data: {
        customer_id: CUSTOMER_ID,
        communication_preferences: {
          smsMarketing: false,
          smsTransactional: false,
        },
      },
      error: null,
    });
    stageSupabaseResponse("shop_customers", "update", {
      data: null,
      error: null,
    });

    await reactivatePatient(PATIENT_ID);

    const [payload] = supabaseMock.writePayloads(
      "shop_customers",
      "update",
    ) as Array<Record<string, unknown>>;
    const prefs = payload!.communication_preferences as Record<string, unknown>;
    // If this were pausePatient the values would be false; they must be true here.
    expect(prefs.smsMarketing).toBe(true);
    expect(prefs.smsTransactional).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// decideCoverageBlock — pure coverage decision matrix (#2)
// ---------------------------------------------------------------------------
// The order-time coverage guard only blocks on an EXPLICIT negative
// signal. Everything else (null row, unknown/positive fields) is "no
// opinion" → the order proceeds (fail open).

describe("decideCoverageBlock", () => {
  const ELIG_ID = "00000000-0000-4000-8000-0000000000e1";

  it("returns null when there is no parsed eligibility row", () => {
    expect(decideCoverageBlock(null, "Aetna")).toBeNull();
  });

  it("blocks (inactive) when is_active is explicitly false", () => {
    expect(
      decideCoverageBlock(
        { id: ELIG_ID, is_active: false, requires_prior_auth: null },
        "Aetna",
      ),
    ).toEqual({
      reason: "inactive",
      payerName: "Aetna",
      eligibilityCheckId: ELIG_ID,
    });
  });

  it("blocks (prior_auth_required) when requires_prior_auth is true and plan is active", () => {
    expect(
      decideCoverageBlock(
        { id: ELIG_ID, is_active: true, requires_prior_auth: true },
        "Cigna",
      ),
    ).toEqual({
      reason: "prior_auth_required",
      payerName: "Cigna",
      eligibilityCheckId: ELIG_ID,
    });
  });

  it("does NOT block an active plan with no PA requirement", () => {
    expect(
      decideCoverageBlock(
        { id: ELIG_ID, is_active: true, requires_prior_auth: false },
        "Aetna",
      ),
    ).toBeNull();
  });

  it("does NOT block when activeness is unknown (null) — fail open", () => {
    expect(
      decideCoverageBlock(
        { id: ELIG_ID, is_active: null, requires_prior_auth: false },
        "Aetna",
      ),
    ).toBeNull();
  });

  it("prefers the inactive reason over PA when both are negative", () => {
    expect(
      decideCoverageBlock(
        { id: ELIG_ID, is_active: false, requires_prior_auth: true },
        "Aetna",
      ),
    ).toMatchObject({ reason: "inactive" });
  });
});

// ---------------------------------------------------------------------------
// placeResupplyOrderForConversation — order-time coverage guard (#2)
// ---------------------------------------------------------------------------

describe("placeResupplyOrderForConversation — coverage guard", () => {
  const CONV_ID = "00000000-0000-4000-8000-0000000000c1";
  const EPISODE_ID = "00000000-0000-4000-8000-0000000000e2";
  const RX_ID = "00000000-0000-4000-8000-0000000000r1";
  const COVERAGE_ID = "00000000-0000-4000-8000-0000000000cv";
  const ELIG_ID = "00000000-0000-4000-8000-0000000000e9";

  function stageLookupChain(): void {
    stageSupabaseResponse("conversations", "select", {
      data: { id: CONV_ID, patient_id: PATIENT_ID, episode_id: EPISODE_ID },
      error: null,
    });
    stageSupabaseResponse("episodes", "select", {
      data: {
        id: EPISODE_ID,
        patient_id: PATIENT_ID,
        prescription_id: RX_ID,
        status: "outreach_pending",
      },
      error: null,
    });
    stageSupabaseResponse("prescriptions", "select", {
      data: { id: RX_ID, item_sku: "CUSHION-NASAL-MED" },
      error: null,
    });
    // isFeatureEnabled lookups, in call order: entitlement first
    // (staged OFF so the entitlement guard is skipped), eligibility
    // second (staged ON so the coverage guard runs).
    stageSupabaseResponse("feature_flags", "select", {
      data: { enabled: false },
      error: null,
    });
    stageSupabaseResponse("feature_flags", "select", {
      data: { enabled: true },
      error: null,
    });
    stageSupabaseResponse("insurance_coverages", "select", {
      data: { id: COVERAGE_ID, payer_name: "Aetna" },
      error: null,
    });
  }

  it("holds the order and raises a CSR alert when the cached 271 is inactive", async () => {
    stageLookupChain();
    stageSupabaseResponse("eligibility_checks", "select", {
      data: {
        id: ELIG_ID,
        is_active: false,
        requires_prior_auth: null,
        status: "parsed",
        responded_at: new Date().toISOString(),
      },
      error: null,
    });
    // raiseCoverageAlert: no existing open alert, then insert.
    stageSupabaseResponse("csr_compliance_alerts", "select", {
      data: null,
      error: null,
    });
    stageSupabaseResponse("csr_compliance_alerts", "insert", {
      data: null,
      error: null,
    });

    const result = await placeResupplyOrderForConversation({
      conversationId: CONV_ID,
    });

    expect(result.status).toBe("coverage_blocked");
    if (result.status === "coverage_blocked") {
      expect(result.coverage.reason).toBe("inactive");
      expect(result.coverage.payerName).toBe("Aetna");
      expect(result.coverage.eligibilityCheckId).toBe(ELIG_ID);
    }

    // The episode must NOT be claimed/confirmed — the order is held.
    expect(supabaseMock.callCount("episodes", "update")).toBe(0);
    // Exactly one CSR alert row was written, with the right type.
    expect(supabaseMock.callCount("csr_compliance_alerts", "insert")).toBe(1);
    const [alert] = supabaseMock.writePayloads(
      "csr_compliance_alerts",
      "insert",
    ) as Array<Record<string, unknown>>;
    expect(alert!.alert_type).toBe("resupply_coverage_blocked");
    expect(alert!.patient_id).toBe(PATIENT_ID);
  });

  it("does not de-dupe-insert when an open coverage alert already exists", async () => {
    stageLookupChain();
    stageSupabaseResponse("eligibility_checks", "select", {
      data: {
        id: ELIG_ID,
        is_active: false,
        requires_prior_auth: null,
        status: "parsed",
        responded_at: new Date().toISOString(),
      },
      error: null,
    });
    // An open alert already exists → raiseCoverageAlert returns early.
    stageSupabaseResponse("csr_compliance_alerts", "select", {
      data: { id: "existing-alert" },
      error: null,
    });

    const result = await placeResupplyOrderForConversation({
      conversationId: CONV_ID,
    });

    expect(result.status).toBe("coverage_blocked");
    expect(supabaseMock.callCount("csr_compliance_alerts", "insert")).toBe(0);
  });
});
