// Tests for the paperwork sign-off gate. Exercises the requirement
// triggers (global flag, per-payer flag), the patient-resolution
// short-circuits (guest / non-clinical orders), and the
// signed-vs-missing form accounting.
//
// The Supabase client is stubbed via the shared `supabase-mock` helper;
// each test stages the rows the helper's queries see in order:
//   1. shop_customers   (auth_user_id)
//   2. patients         (id by portal_auth_user_id)
//   3. feature_flags     (isFeatureEnabled — global flag)
//   4. insurance_coverages (primary payer_name)
//   5. payer_profiles    (requires_signed_paperwork — only if coverage)
//   6. patient_form_acknowledgements (form_kind — only if required)

import { describe, it, expect, beforeEach } from "vitest";

import {
  installSupabaseMock,
  stageSupabaseResponse,
} from "../../test-helpers/supabase-mock";

const supabaseMock = installSupabaseMock();

import { invalidateFeatureFlagCache } from "../feature-flags";
import { evaluatePaperworkGateForCustomer } from "./require-signed-paperwork";

const CUSTOMER = "user_alice";
const AUTH_USER = "auth_alice";
const PATIENT = "11111111-1111-4111-8111-111111111111";

beforeEach(() => {
  supabaseMock.reset();
  invalidateFeatureFlagCache();
});

function stagePatientResolution(): void {
  stageSupabaseResponse("shop_customers", "select", {
    data: { auth_user_id: AUTH_USER },
  });
  stageSupabaseResponse("patients", "select", { data: { id: PATIENT } });
}

describe("evaluatePaperworkGateForCustomer", () => {
  it("is not required for a guest order (no customer)", async () => {
    const decision = await evaluatePaperworkGateForCustomer(null);
    expect(decision.required).toBe(false);
    expect(decision.satisfied).toBe(true);
    expect(decision.patientId).toBeNull();
  });

  it("is not required for a non-clinical customer (no patient record)", async () => {
    stageSupabaseResponse("shop_customers", "select", {
      data: { auth_user_id: null },
    });
    const decision = await evaluatePaperworkGateForCustomer(CUSTOMER);
    expect(decision.required).toBe(false);
    expect(decision.satisfied).toBe(true);
    expect(decision.patientId).toBeNull();
  });

  it("is not required when neither the global flag nor the payer demands it", async () => {
    stagePatientResolution();
    stageSupabaseResponse("feature_flags", "select", {
      data: { enabled: false },
    });
    stageSupabaseResponse("insurance_coverages", "select", { data: null });
    const decision = await evaluatePaperworkGateForCustomer(CUSTOMER);
    expect(decision.required).toBe(false);
    expect(decision.satisfied).toBe(true);
    expect(decision.patientId).toBe(PATIENT);
  });

  it("blocks when the global flag is on and forms are unsigned", async () => {
    stagePatientResolution();
    stageSupabaseResponse("feature_flags", "select", {
      data: { enabled: true },
    });
    stageSupabaseResponse("insurance_coverages", "select", { data: null });
    stageSupabaseResponse("patient_form_acknowledgements", "select", {
      data: [],
    });
    const decision = await evaluatePaperworkGateForCustomer(CUSTOMER);
    expect(decision.required).toBe(true);
    expect(decision.satisfied).toBe(false);
    expect(decision.sources).toEqual(["global"]);
    expect(decision.missingForms).toEqual([
      "HIPAA Notice of Privacy Practices",
      "Assignment of Benefits",
      "Supplier Standards",
    ]);
  });

  it("is satisfied when the global flag is on and every form is signed", async () => {
    stagePatientResolution();
    stageSupabaseResponse("feature_flags", "select", {
      data: { enabled: true },
    });
    stageSupabaseResponse("insurance_coverages", "select", { data: null });
    stageSupabaseResponse("patient_form_acknowledgements", "select", {
      data: [
        { form_kind: "hipaa_npp" },
        { form_kind: "aob" },
        { form_kind: "supplier_standards" },
      ],
    });
    const decision = await evaluatePaperworkGateForCustomer(CUSTOMER);
    expect(decision.required).toBe(true);
    expect(decision.satisfied).toBe(true);
    expect(decision.missingForms).toEqual([]);
  });

  it("blocks on a per-payer requirement even when the global flag is off", async () => {
    stagePatientResolution();
    stageSupabaseResponse("feature_flags", "select", {
      data: { enabled: false },
    });
    stageSupabaseResponse("insurance_coverages", "select", {
      data: { payer_name: "Highmark BCBS" },
    });
    stageSupabaseResponse("payer_profiles", "select", {
      data: { requires_signed_paperwork: true },
    });
    stageSupabaseResponse("patient_form_acknowledgements", "select", {
      data: [{ form_kind: "aob" }],
    });
    const decision = await evaluatePaperworkGateForCustomer(CUSTOMER);
    expect(decision.required).toBe(true);
    expect(decision.satisfied).toBe(false);
    expect(decision.sources).toEqual(["payer"]);
    // hipaa_npp + supplier_standards still missing; aob signed.
    expect(decision.missingForms).toEqual([
      "HIPAA Notice of Privacy Practices",
      "Supplier Standards",
    ]);
  });

  it("does not impose a payer requirement when the payer flag is off", async () => {
    stagePatientResolution();
    stageSupabaseResponse("feature_flags", "select", {
      data: { enabled: false },
    });
    stageSupabaseResponse("insurance_coverages", "select", {
      data: { payer_name: "Some Payer" },
    });
    stageSupabaseResponse("payer_profiles", "select", {
      data: { requires_signed_paperwork: false },
    });
    const decision = await evaluatePaperworkGateForCustomer(CUSTOMER);
    expect(decision.required).toBe(false);
    expect(decision.satisfied).toBe(true);
  });
});
