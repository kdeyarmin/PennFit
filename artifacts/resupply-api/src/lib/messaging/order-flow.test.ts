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

import { reactivatePatient } from "./order-flow";

beforeEach(() => {
  supabaseMock.reset();
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
