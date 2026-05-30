// Tests for the dispense-readiness reviewer. The deterministic
// check engine is the load-bearing piece — we lock down the
// happy-path (everything green), the missing-data paths (each
// category surfaces the right finding), and the verdict-classifier
// (errors with fixable hints vs. blocking).
//
// The AI synthesizer is not exercised here — `synthesizeWithAi` is
// network-bound and OPENAI_API_KEY is not set in CI; it collapses
// to the deterministic fallback action plan via the `errorMessage`
// path, which we verify indirectly through verdict + counts.

import { describe, expect, it, beforeEach } from "vitest";

import {
  installSupabaseMock,
  stageSupabaseResponse,
} from "../../test-helpers/supabase-mock";

const supabaseMock = installSupabaseMock();

import { reviewDispenseReadiness } from "./dispense-readiness-reviewer";

const PATIENT = "11111111-1111-4111-8111-111111111111";
const COVERAGE = "22222222-2222-4222-8222-222222222222";
const PAYER = "33333333-3333-4333-8333-333333333333";
const PROVIDER = "44444444-4444-4444-8444-444444444444";

const FULL_PATIENT = {
  id: PATIENT,
  legal_first_name: "Jane",
  legal_last_name: "Doe",
  date_of_birth: "1965-04-12",
  phone_e164: "+18144710627",
  email: "jane@example.com",
  address: {
    line1: "100 Main St",
    city: "State College",
    state: "PA",
    zip: "16801",
  },
};

const FULL_COVERAGE = {
  id: COVERAGE,
  rank: "primary",
  payer_name: "Highmark BCBS",
  member_id: "M123456789",
  in_network: true,
  effective_date: "2025-01-01",
  termination_date: null,
};

const FULL_PAYER = {
  id: PAYER,
  display_name: "Highmark BCBS",
  line_of_business: "commercial",
  paper_only: false,
  office_ally_payer_id: "54771",
  requires_prior_auth_dme: false,
};

function stageHappyPath(over: Record<string, unknown> = {}): void {
  // 1. patient
  stageSupabaseResponse("patients", "select", {
    data: { ...FULL_PATIENT, ...over },
  });
  // 2. insurance_coverages
  stageSupabaseResponse("insurance_coverages", "select", {
    data: FULL_COVERAGE,
  });
  // 3. payer_profiles — TWO calls in sequence: first the name-ilike
  // lookup that returns just the id, then the full-detail fetch by id.
  stageSupabaseResponse("payer_profiles", "select", { data: { id: PAYER } });
  stageSupabaseResponse("payer_profiles", "select", { data: FULL_PAYER });
  // 4. sleep_studies
  stageSupabaseResponse("sleep_studies", "select", {
    data: {
      id: "s-1",
      study_date: "2025-12-01",
      study_type: "psg",
      ahi: "24.5",
      diagnosis_icd10: "G47.33",
    },
  });
  // 5. prescriptions
  stageSupabaseResponse("prescriptions", "select", {
    data: {
      id: "rx-1",
      hcpcs_code: "E0601",
      item_sku: "cpap-machine",
      status: "active",
      valid_from: "2025-01-01",
      valid_until: null,
      provider_id: PROVIDER,
    },
  });
  // 6. providers
  stageSupabaseResponse("providers", "select", {
    data: { npi: "1700987654", legal_name: "Robin Ashton" },
  });
  // 7. capped_rental_cycles
  stageSupabaseResponse("capped_rental_cycles", "select", {
    data: { id: "c-1", status: "active", current_month: 2, max_months: 13 },
  });
  // 8. patient_therapy_nights
  const compliantNights = Array.from({ length: 25 }, () => ({
    usage_minutes: 360,
  }));
  stageSupabaseResponse("patient_therapy_nights", "select", {
    data: compliantNights,
  });
  // 9. patient_form_acknowledgements (all three required forms)
  stageSupabaseResponse("patient_form_acknowledgements", "select", {
    data: [
      { form_kind: "hipaa_npp", signed_at: "2025-01-01T00:00:00Z" },
      { form_kind: "aob", signed_at: "2025-01-01T00:00:00Z" },
      { form_kind: "supplier_standards", signed_at: "2025-01-01T00:00:00Z" },
    ],
  });
  // 10. equipment_assets (no recalled devices)
  stageSupabaseResponse("equipment_assets", "select", { data: [] });
  // 11. dme_organization
  const farFuture = "2030-01-01";
  stageSupabaseResponse("dme_organization", "select", {
    data: {
      accreditation_expires_on: farFuture,
      state_license_expires_on: farFuture,
      surety_bond_expires_on: farFuture,
    },
  });
  // 12. patient_grievances count
  stageSupabaseResponse("patient_grievances", "select", { count: 0 });
  // 13. csr_compliance_alerts count
  stageSupabaseResponse("csr_compliance_alerts", "select", { count: 0 });
}

describe("reviewDispenseReadiness", () => {
  beforeEach(() => supabaseMock.reset());

  it("returns errored when patient not found", async () => {
    stageSupabaseResponse("patients", "select", { data: null });
    const r = await reviewDispenseReadiness({
      patientId: PATIENT,
      hcpcsCode: "E0601",
    });
    expect(r.readyToDispense).toBe(false);
    expect(r.findings[0]!.key).toBe("patient_exists");
    expect(r.findings[0]!.severity).toBe("error");
  });

  it("returns ready when every check passes", async () => {
    stageHappyPath();
    const r = await reviewDispenseReadiness({
      patientId: PATIENT,
      hcpcsCode: "E0601",
    });
    expect(r.counts.failed).toBe(0);
    expect(r.overallVerdict).toBe("ready");
    expect(r.readyToDispense).toBe(true);
    // Every category should appear among the ok findings.
    const categories = new Set(r.findings.map((f) => f.category));
    expect(categories.has("patient_identity")).toBe(true);
    expect(categories.has("insurance")).toBe(true);
    expect(categories.has("clinical_documentation")).toBe(true);
    expect(categories.has("provider")).toBe(true);
    expect(categories.has("dme_organization")).toBe(true);
  });

  it("flags incomplete patient address as a blocking error", async () => {
    stageHappyPath({
      address: { line1: "100 Main", city: "", state: "PA", zip: "16801" },
    });
    const r = await reviewDispenseReadiness({
      patientId: PATIENT,
      hcpcsCode: "E0601",
    });
    const f = r.findings.find((x) => x.key === "patient_address");
    expect(f?.severity).toBe("error");
    expect(r.readyToDispense).toBe(false);
  });

  it("flags missing phone + email as warnings, not errors", async () => {
    stageHappyPath({ phone_e164: null, email: null });
    const r = await reviewDispenseReadiness({
      patientId: PATIENT,
      hcpcsCode: "E0601",
    });
    const phone = r.findings.find((x) => x.key === "patient_phone");
    const email = r.findings.find((x) => x.key === "patient_email");
    expect(phone?.severity).toBe("warning");
    expect(email?.severity).toBe("warning");
  });

  it("flags terminated coverage as error", async () => {
    stageSupabaseResponse("patients", "select", { data: FULL_PATIENT });
    stageSupabaseResponse("insurance_coverages", "select", {
      data: { ...FULL_COVERAGE, termination_date: "2020-01-01" },
    });
    stageSupabaseResponse("payer_profiles", "select", { data: { id: PAYER } });
    stageSupabaseResponse("payer_profiles", "select", { data: FULL_PAYER });
    stageSupabaseResponse("sleep_studies", "select", {
      data: {
        id: "s-1",
        study_date: "2025-12-01",
        study_type: "psg",
        ahi: "24.5",
        diagnosis_icd10: "G47.33",
      },
    });
    stageSupabaseResponse("prescriptions", "select", {
      data: {
        id: "rx-1",
        hcpcs_code: "E0601",
        item_sku: "cpap-machine",
        status: "active",
        valid_from: "2025-01-01",
        valid_until: null,
        provider_id: PROVIDER,
      },
    });
    stageSupabaseResponse("providers", "select", {
      data: { npi: "1700987654", legal_name: "Robin Ashton" },
    });
    stageSupabaseResponse("capped_rental_cycles", "select", { data: null });
    stageSupabaseResponse("patient_therapy_nights", "select", {
      data: Array.from({ length: 25 }, () => ({ usage_minutes: 360 })),
    });
    stageSupabaseResponse("patient_form_acknowledgements", "select", {
      data: [
        { form_kind: "hipaa_npp", signed_at: "2025-01-01T00:00:00Z" },
        { form_kind: "aob", signed_at: "2025-01-01T00:00:00Z" },
        { form_kind: "supplier_standards", signed_at: "2025-01-01T00:00:00Z" },
      ],
    });
    stageSupabaseResponse("equipment_assets", "select", { data: [] });
    stageSupabaseResponse("dme_organization", "select", {
      data: {
        accreditation_expires_on: "2030-01-01",
        state_license_expires_on: "2030-01-01",
        surety_bond_expires_on: "2030-01-01",
      },
    });
    stageSupabaseResponse("patient_grievances", "select", { count: 0 });
    stageSupabaseResponse("csr_compliance_alerts", "select", { count: 0 });
    const r = await reviewDispenseReadiness({
      patientId: PATIENT,
      hcpcsCode: "E0601",
    });
    const f = r.findings.find((x) => x.key === "insurance_coverage_active");
    expect(f?.severity).toBe("error");
  });

  it("flags missing form acknowledgments as errors", async () => {
    stageSupabaseResponse("patients", "select", { data: FULL_PATIENT });
    stageSupabaseResponse("insurance_coverages", "select", {
      data: FULL_COVERAGE,
    });
    stageSupabaseResponse("payer_profiles", "select", { data: { id: PAYER } });
    stageSupabaseResponse("payer_profiles", "select", { data: FULL_PAYER });
    stageSupabaseResponse("sleep_studies", "select", {
      data: {
        id: "s-1",
        study_date: "2025-12-01",
        study_type: "psg",
        ahi: "24.5",
        diagnosis_icd10: "G47.33",
      },
    });
    stageSupabaseResponse("prescriptions", "select", {
      data: {
        id: "rx-1",
        hcpcs_code: "E0601",
        item_sku: "cpap-machine",
        status: "active",
        valid_from: "2025-01-01",
        valid_until: null,
        provider_id: PROVIDER,
      },
    });
    stageSupabaseResponse("providers", "select", {
      data: { npi: "1700987654", legal_name: "Robin Ashton" },
    });
    stageSupabaseResponse("capped_rental_cycles", "select", { data: null });
    stageSupabaseResponse("patient_therapy_nights", "select", {
      data: Array.from({ length: 25 }, () => ({ usage_minutes: 360 })),
    });
    // No form acknowledgements on file
    stageSupabaseResponse("patient_form_acknowledgements", "select", {
      data: [],
    });
    stageSupabaseResponse("equipment_assets", "select", { data: [] });
    stageSupabaseResponse("dme_organization", "select", {
      data: {
        accreditation_expires_on: "2030-01-01",
        state_license_expires_on: "2030-01-01",
        surety_bond_expires_on: "2030-01-01",
      },
    });
    stageSupabaseResponse("patient_grievances", "select", { count: 0 });
    stageSupabaseResponse("csr_compliance_alerts", "select", { count: 0 });
    const r = await reviewDispenseReadiness({
      patientId: PATIENT,
      hcpcsCode: "E0601",
    });
    expect(r.findings.find((f) => f.key === "form_hipaa_npp")?.severity).toBe(
      "error",
    );
    expect(r.findings.find((f) => f.key === "form_aob")?.severity).toBe(
      "error",
    );
    expect(
      r.findings.find((f) => f.key === "form_supplier_standards")?.severity,
    ).toBe("error");
  });

  it("flags expired DME accreditation as error", async () => {
    stageSupabaseResponse("patients", "select", { data: FULL_PATIENT });
    stageSupabaseResponse("insurance_coverages", "select", {
      data: FULL_COVERAGE,
    });
    stageSupabaseResponse("payer_profiles", "select", { data: { id: PAYER } });
    stageSupabaseResponse("payer_profiles", "select", { data: FULL_PAYER });
    stageSupabaseResponse("sleep_studies", "select", {
      data: {
        id: "s-1",
        study_date: "2025-12-01",
        study_type: "psg",
        ahi: "24.5",
        diagnosis_icd10: "G47.33",
      },
    });
    stageSupabaseResponse("prescriptions", "select", {
      data: {
        id: "rx-1",
        hcpcs_code: "E0601",
        item_sku: "cpap-machine",
        status: "active",
        valid_from: "2025-01-01",
        valid_until: null,
        provider_id: PROVIDER,
      },
    });
    stageSupabaseResponse("providers", "select", {
      data: { npi: "1700987654", legal_name: "Robin Ashton" },
    });
    stageSupabaseResponse("capped_rental_cycles", "select", { data: null });
    stageSupabaseResponse("patient_therapy_nights", "select", {
      data: Array.from({ length: 25 }, () => ({ usage_minutes: 360 })),
    });
    stageSupabaseResponse("patient_form_acknowledgements", "select", {
      data: [
        { form_kind: "hipaa_npp", signed_at: "2025-01-01T00:00:00Z" },
        { form_kind: "aob", signed_at: "2025-01-01T00:00:00Z" },
        { form_kind: "supplier_standards", signed_at: "2025-01-01T00:00:00Z" },
      ],
    });
    stageSupabaseResponse("equipment_assets", "select", { data: [] });
    stageSupabaseResponse("dme_organization", "select", {
      data: {
        accreditation_expires_on: "2020-01-01", // EXPIRED
        state_license_expires_on: "2030-01-01",
        surety_bond_expires_on: "2030-01-01",
      },
    });
    stageSupabaseResponse("patient_grievances", "select", { count: 0 });
    stageSupabaseResponse("csr_compliance_alerts", "select", { count: 0 });
    const r = await reviewDispenseReadiness({
      patientId: PATIENT,
      hcpcsCode: "E0601",
    });
    const f = r.findings.find((x) => x.key === "dme_accreditation");
    expect(f?.severity).toBe("error");
    expect(r.readyToDispense).toBe(false);
  });
});
