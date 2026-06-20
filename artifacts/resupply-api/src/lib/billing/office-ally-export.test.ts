// Tests for buildExport837P — the clearinghouse-neutral 837P export path.
//
// The behavior under test (vs. buildEdiPayloadForSubmission): the interchange
// is addressed to the CALLER-supplied receiver, not hard-coded Office Ally,
// and no submission row / status change is required. These assertions lock in
// the "download the 837P and upload it to the clearinghouse of your choice"
// claim the marketing page makes.

import { describe, expect, it, beforeEach, vi } from "vitest";

import {
  installSupabaseMock,
  stageSupabaseResponse,
} from "../../test-helpers/supabase-mock";

const supabaseMock = installSupabaseMock();

vi.mock("../feature-flags", () => ({
  isFeatureEnabled: vi.fn(async () => false),
}));

import { MOCK_ORG_ID } from "../../test-helpers/auth-mocks";
import { buildExport837P } from "./office-ally-batch";

beforeEach(() => {
  supabaseMock.reset();
});

function makeClaim(overrides: Record<string, unknown> = {}) {
  return {
    id: "c1",
    payer_profile_id: "pp1",
    status: "draft",
    insurance_coverage_id: "cov1",
    patient_id: "pat1",
    rendering_provider_id: null,
    referring_provider_id: null,
    secondary_coverage_id: null,
    date_of_service: "2026-05-15",
    total_billed_cents: 2500,
    ...overrides,
  };
}

// Stage the reads buildOneDetail performs for one claim (coverage, patient,
// line items). sleep_studies / providers stay unstaged → defaults.
function stageClaimDetail() {
  stageSupabaseResponse("insurance_coverages", "select", {
    data: { member_id: "MBR-1", policyholder_relationship: "self" },
    error: null,
  });
  stageSupabaseResponse("patients", "select", {
    data: {
      legal_first_name: "Jane",
      legal_last_name: "Doe",
      date_of_birth: "1980-01-01",
      address: {
        line1: "100 Main St",
        city: "Pittsburgh",
        state: "PA",
        zip: "15201",
      },
    },
    error: null,
  });
  stageSupabaseResponse("insurance_claim_line_items", "select", {
    data: [
      { hcpcs_code: "A4604", modifier: null, billed_cents: 2500, quantity: 1 },
    ],
    error: null,
  });
}

describe("buildExport837P", () => {
  it("builds a standard 837P addressed to the caller's receiver (not Office Ally)", async () => {
    stageSupabaseResponse("insurance_claims", "select", {
      data: [makeClaim()],
    });
    stageSupabaseResponse("payer_profiles", "select", {
      data: { payer_legal_name: "Aetna", office_ally_payer_id: "60054" },
    });
    stageClaimDetail();

    const result = await buildExport837P({
      orgId: MOCK_ORG_ID,
      claimIds: ["c1"],
      receiver: {
        interchangeId: "MYCLR",
        organizationName: "MY CLEARINGHOUSE",
      },
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.claimCount).toBe(1);
      // The interchange carries the caller's receiver, not Office Ally's.
      expect(result.payload).toContain("MYCLR");
      expect(result.payload).not.toContain("OFFCLY");
      expect(result.payload).not.toContain("OFFICE ALLY");
      // A real 5010 837P envelope.
      expect(result.payload.startsWith("ISA")).toBe(true);
      expect(result.payload).toContain("005010X222A1");
      expect(result.interchangeControlNumber).toMatch(/^\d{9}$/);
    }
  });

  it("returns no_claims_matched when the selection finds nothing", async () => {
    stageSupabaseResponse("insurance_claims", "select", { data: [] });
    const result = await buildExport837P({
      orgId: MOCK_ORG_ID,
      claimIds: ["missing"],
      receiver: { interchangeId: "X", organizationName: "Y" },
    });
    expect(result).toMatchObject({ ok: false, kind: "no_claims_matched" });
  });

  it("rejects a batch that spans more than one payer", async () => {
    stageSupabaseResponse("insurance_claims", "select", {
      data: [
        makeClaim({ id: "c1", payer_profile_id: "pp1" }),
        makeClaim({ id: "c2", payer_profile_id: "pp2" }),
      ],
    });
    const result = await buildExport837P({
      orgId: MOCK_ORG_ID,
      claimIds: ["c1", "c2"],
      receiver: { interchangeId: "X", organizationName: "Y" },
    });
    expect(result).toMatchObject({ ok: false, kind: "batch_payer_mismatch" });
  });

  it("fails when the payer has no clearinghouse payer id", async () => {
    stageSupabaseResponse("insurance_claims", "select", {
      data: [makeClaim()],
    });
    stageSupabaseResponse("payer_profiles", "select", {
      data: { payer_legal_name: "Aetna", office_ally_payer_id: null },
    });
    const result = await buildExport837P({
      orgId: MOCK_ORG_ID,
      claimIds: ["c1"],
      receiver: { interchangeId: "X", organizationName: "Y" },
    });
    expect(result).toMatchObject({ ok: false, kind: "payer_not_configured" });
  });
});
