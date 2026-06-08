// Tests for the claim-status checker auth + lookup gates. The 276 build
// + SFTP upload live in the office-ally package (own suite); here we lock
// down the auth-critical paths + a happy-path insert, mirroring the
// eligibility-verifier suite.

import { describe, it, expect, vi, beforeEach } from "vitest";

import {
  installSupabaseMock,
  stageSupabaseResponse,
} from "../../test-helpers/supabase-mock";

const supabaseMock = installSupabaseMock();

vi.mock("@workspace/resupply-integrations-office-ally", () => ({
  allocateControlNumbers: vi.fn(() => ({})),
  build276: vi.fn(() => ({
    payload: "ISA*...",
    interchangeControlNumber: "000000009",
    groupControlNumber: "9",
    traceReference: "ETIN-000000009-0001-abcd",
  })),
  createFileTransport: vi.fn(() => ({
    upload: async () => ({ ok: true, message: "ok" }),
  })),
  createSftpTransport: vi.fn(() => ({
    upload: async () => ({ ok: true, message: "ok" }),
  })),
  resolveOutboxDir: vi.fn(() => "/tmp"),
}));

vi.mock("./identity-resolver", () => ({
  resolveBillingIdentity: vi.fn(async () => ({
    source: "stub",
    organization: null,
    billingProvider: { organizationName: "X", npi: "1234567890" },
    submitter: { etin: "ETIN", organizationName: "X", contactName: "B" },
    usageIndicator: "T",
  })),
  resolveClearinghouse: vi.fn(async () => ({
    source: "stub",
    config: null,
    row: null,
    usageIndicator: "T",
    submitter: { etin: "ETIN", organizationName: "X", contactName: "B" },
  })),
}));

import {
  ClaimNotForPatientError,
  submitClaimStatusCheck,
} from "./claim-status-checker";

const PATIENT_ID = "11111111-1111-4111-8111-111111111111";
const CLAIM_ID = "22222222-2222-4222-8222-222222222222";
const OTHER = "33333333-3333-4333-8333-333333333333";

beforeEach(() => supabaseMock.reset());

function stageClaim(over: Record<string, unknown> = {}): void {
  stageSupabaseResponse("insurance_claims", "select", {
    data: {
      id: CLAIM_ID,
      patient_id: PATIENT_ID,
      payer_name: "Aetna",
      payer_profile_id: "pp_1",
      claim_number: "CLM-1",
      date_of_service: "2026-05-01",
      total_billed_cents: 12500,
      insurance_coverage_id: null,
      ...over,
    },
  });
}

describe("submitClaimStatusCheck — scoping + payer gates", () => {
  it("throws ClaimNotForPatientError on a patient mismatch (IDOR guard)", async () => {
    stageClaim({ patient_id: OTHER });
    await expect(
      submitClaimStatusCheck({
        claimId: CLAIM_ID,
        patientId: PATIENT_ID,
        requestedByEmail: "biller@pennpaps.com",
      }),
    ).rejects.toBeInstanceOf(ClaimNotForPatientError);
  });

  it("throws when the claim is missing", async () => {
    stageSupabaseResponse("insurance_claims", "select", { data: null });
    await expect(
      submitClaimStatusCheck({
        claimId: CLAIM_ID,
        patientId: PATIENT_ID,
        requestedByEmail: "biller@pennpaps.com",
      }),
    ).rejects.toThrow(/insurance_claim not found/);
  });

  it("throws when the payer is paper-only / not electronic", async () => {
    stageClaim();
    stageSupabaseResponse("patients", "select", {
      data: { legal_first_name: "Alice", legal_last_name: "P" },
    });
    stageSupabaseResponse("payer_profiles", "select", {
      data: {
        id: "pp_1",
        payer_legal_name: "Paper Payer",
        office_ally_payer_id: null,
        paper_only: true,
      },
    });
    await expect(
      submitClaimStatusCheck({
        claimId: CLAIM_ID,
        patientId: PATIENT_ID,
        requestedByEmail: "biller@pennpaps.com",
      }),
    ).rejects.toThrow(/does not accept electronic 276/);
  });

  it("builds + records a check on the happy path", async () => {
    stageClaim();
    stageSupabaseResponse("patients", "select", {
      data: { legal_first_name: "Alice", legal_last_name: "P" },
    });
    stageSupabaseResponse("payer_profiles", "select", {
      data: {
        id: "pp_1",
        payer_legal_name: "Aetna",
        office_ally_payer_id: "60054",
        paper_only: false,
      },
    });
    stageSupabaseResponse("office_ally_submissions", "select", { data: null });
    stageSupabaseResponse("claim_status_checks", "insert", {
      data: { id: "csc_1" },
    });
    const r = await submitClaimStatusCheck({
      claimId: CLAIM_ID,
      patientId: PATIENT_ID,
      requestedByEmail: "biller@pennpaps.com",
    });
    expect(r.claimStatusCheckId).toBe("csc_1");
    expect(r.uploadOk).toBe(true);
    expect(r.isaControlNumber).toBe("000000009");
    const insert = supabaseMock.writePayloads(
      "claim_status_checks",
      "insert",
    )[0] as Record<string, unknown>;
    expect(insert.status).toBe("submitted");
    expect(insert.claim_id).toBe(CLAIM_ID);
  });
});
