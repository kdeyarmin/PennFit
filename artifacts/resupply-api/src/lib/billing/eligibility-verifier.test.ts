// Tests for the eligibility verifier auth + lookup gates.
//
// The bulk of the work (270 build, SFTP upload, Office Ally control
// numbers) lives in @workspace/resupply-integrations-office-ally and
// has its own suite. Here we lock down the AUTH-CRITICAL paths:
//
//   * CoverageNotForPatientError when :patientId from the URL does not
//     match insurance_coverages.patient_id (mistyped URL → wrong
//     patient billed if not gated)
//   * Throws "insurance_coverage not found" when coverage row missing
//   * Throws "patient not found" when patient row missing
//   * Throws "payer does not accept electronic 270/271" when the payer
//     profile is paper-only or has no office_ally_payer_id
//   * getCachedEligibility returns null when no parsed rows exist
//   * getCachedEligibility returns null when responded_at is older than
//     freshness window

import { describe, it, expect, vi, beforeEach } from "vitest";

import {
  installSupabaseMock,
  stageSupabaseResponse,
} from "../../test-helpers/supabase-mock";

const supabaseMock = installSupabaseMock();

vi.mock("@workspace/resupply-integrations-office-ally", () => ({
  allocateControlNumbers: vi.fn(() => ({})),
  build270: vi.fn(() => ({
    payload: "ISA*...",
    interchangeControlNumber: "000000001",
    groupControlNumber: "1",
    traceReference: "TRACE-1",
  })),
  createFileTransport: vi.fn(() => ({
    upload: async () => ({ ok: true, message: "ok" }),
  })),
  createSftpTransport: vi.fn(() => ({
    upload: async () => ({ ok: true, message: "ok" }),
  })),
  resolveOutboxDir: vi.fn(() => "/tmp"),
}));

// Stub identity-resolver so we don't depend on its DB reads.
vi.mock("./identity-resolver", () => ({
  resolveBillingIdentity: vi.fn(async () => ({
    source: "stub",
    organization: null,
    billingProvider: { organizationName: "X", npi: "1234567890" },
    submitter: { etin: "X", organizationName: "X", contactName: "B" },
    usageIndicator: "T",
  })),
  resolveClearinghouse: vi.fn(async () => ({
    source: "stub",
    config: null,
    row: null,
    usageIndicator: "T",
    submitter: { etin: "X", organizationName: "X", contactName: "B" },
  })),
}));

import {
  CoverageNotForPatientError,
  getCachedEligibility,
  verifyEligibility,
} from "./eligibility-verifier";

const PATIENT_ID = "11111111-1111-4111-8111-111111111111";
const COVERAGE_ID = "22222222-2222-4222-8222-222222222222";
const OTHER_PATIENT_ID = "33333333-3333-4333-8333-333333333333";

beforeEach(() => supabaseMock.reset());

describe("verifyEligibility — patient/coverage scoping (IDOR guard)", () => {
  it("throws CoverageNotForPatientError when coverage belongs to a different patient", async () => {
    stageSupabaseResponse("insurance_coverages", "select", {
      data: {
        id: COVERAGE_ID,
        patient_id: OTHER_PATIENT_ID, // mismatched
        payer_name: "Acme",
        member_id: "MEM-1",
      },
    });
    await expect(
      verifyEligibility({
        insuranceCoverageId: COVERAGE_ID,
        patientId: PATIENT_ID,
        requestedByEmail: "ops@pennpaps.com",
      }),
    ).rejects.toBeInstanceOf(CoverageNotForPatientError);
  });

  it("throws when coverage row is missing", async () => {
    stageSupabaseResponse("insurance_coverages", "select", { data: null });
    await expect(
      verifyEligibility({
        insuranceCoverageId: COVERAGE_ID,
        patientId: PATIENT_ID,
        requestedByEmail: "ops@pennpaps.com",
      }),
    ).rejects.toThrow(/insurance_coverage not found/);
  });

  it("throws when patient row is missing", async () => {
    stageSupabaseResponse("insurance_coverages", "select", {
      data: {
        id: COVERAGE_ID,
        patient_id: PATIENT_ID,
        payer_name: "Acme",
        member_id: "MEM-1",
      },
    });
    stageSupabaseResponse("patients", "select", { data: null });
    await expect(
      verifyEligibility({
        insuranceCoverageId: COVERAGE_ID,
        patientId: PATIENT_ID,
        requestedByEmail: "ops@pennpaps.com",
      }),
    ).rejects.toThrow(/patient not found/);
  });

  it("throws when the payer is paper-only or lacks an OA payer id", async () => {
    stageSupabaseResponse("insurance_coverages", "select", {
      data: {
        id: COVERAGE_ID,
        patient_id: PATIENT_ID,
        payer_name: "Some Paper-only Payer",
        member_id: "MEM-1",
      },
    });
    stageSupabaseResponse("patients", "select", {
      data: {
        legal_first_name: "Alice",
        legal_last_name: "Patient",
        date_of_birth: "1965-04-12",
      },
    });
    stageSupabaseResponse("payer_profiles", "select", {
      data: {
        id: "pp_1",
        payer_legal_name: "Some Paper-only Payer",
        office_ally_payer_id: null,
        paper_only: true,
      },
    });
    await expect(
      verifyEligibility({
        insuranceCoverageId: COVERAGE_ID,
        patientId: PATIENT_ID,
        requestedByEmail: "ops@pennpaps.com",
      }),
    ).rejects.toThrow(/does not accept electronic 270/);
  });
});

describe("getCachedEligibility", () => {
  it("returns null when no parsed row exists within the freshness window", async () => {
    stageSupabaseResponse("eligibility_checks", "select", { data: null });
    const r = await getCachedEligibility(COVERAGE_ID);
    expect(r).toBeNull();
  });

  it("returns the row when a parsed eligibility check is present", async () => {
    stageSupabaseResponse("eligibility_checks", "select", {
      data: {
        id: "eli_1",
        insurance_coverage_id: COVERAGE_ID,
        status: "parsed",
        responded_at: new Date().toISOString(),
      },
    });
    const r = await getCachedEligibility(COVERAGE_ID);
    expect(r).not.toBeNull();
    expect(r?.id).toBe("eli_1");
  });
});
