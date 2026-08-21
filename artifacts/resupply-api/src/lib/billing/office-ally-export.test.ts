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
import { isFeatureEnabled } from "../feature-flags";
import { buildExport837P } from "./office-ally-batch";

const isFeatureEnabledMock = vi.mocked(isFeatureEnabled);

beforeEach(() => {
  supabaseMock.reset();
  // Default: every flag (incl. multi_location.enabled) OFF, so the
  // single-location path is the baseline. Multi-location tests opt in below.
  isFeatureEnabledMock.mockReset();
  isFeatureEnabledMock.mockResolvedValue(false);
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
// line items, sleep study). The sleep study is required: the diagnosis no
// longer defaults to G47.33, so a claim without one is refused as
// `claim_missing_required_data`. (providers stays unstaged → default.)
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
  stageSupabaseResponse("sleep_studies", "select", {
    data: { diagnosis_icd10: "G47.33" },
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

// Multi-location Phase 1 (PR #1210 P1): the clearinghouse-neutral export path
// must honor per-location billing identity exactly like the submit/resubmit
// path — emit the BRANCH NPI for a branch claim, and refuse a mixed-location
// export (one 837P interchange carries one billing provider).
describe("buildExport837P — multi-location Phase 1", () => {
  const WEST_LOCATION_ID = "00000000-0000-4000-8000-0000000000c3";
  const EAST_LOCATION_ID = "00000000-0000-4000-8000-0000000000c4";

  // A complete org-level DB identity (org NPI 9999999999) so the location
  // overlay has a real base to overlay onto (it never overlays onto a stub).
  function stageOrgIdentity(times: number) {
    for (let i = 0; i < times; i += 1) {
      stageSupabaseResponse("dme_organization", "select", {
        data: {
          id: "org_1",
          singleton: true,
          legal_name: "PennPaps Inc",
          organizational_npi: "9999999999",
          tax_id: "999999999",
          physical_address_line1: "1 Penn Plaza",
          physical_city: "Philadelphia",
          physical_state: "PA",
          physical_zip: "19103",
          phone_e164: "+18001234567",
        },
      });
      stageSupabaseResponse("clearinghouse_credentials", "select", {
        data: {
          id: "ch_1",
          slug: "office_ally",
          etin: "DBETIN",
          usage_indicator: "T",
          submitter_organization_name: "PennPaps Inc Submitter",
          contact_name: "Billing",
          contact_phone_e164: "+18005550100",
          sftp_host: "h",
          sftp_port: 22,
          sftp_username: "u",
          private_key_path: "/k",
          known_hosts_path: "/kh",
          remote_inbox_dir: "in",
        },
      });
    }
  }

  function westBranchRow() {
    return {
      id: WEST_LOCATION_ID,
      name: "West Branch",
      npi: "1212121212",
      is_active: true,
      billing_legal_name: "PennPaps West LLC",
      billing_tax_id: "222222222",
      billing_address_line1: "9 West Ave",
      billing_address_line2: null,
      billing_city: "Pittsburgh",
      billing_state: "PA",
      billing_zip: "15201",
    };
  }
  function eastBranchRow() {
    return {
      id: EAST_LOCATION_ID,
      name: "East Branch",
      npi: "3434343434",
      is_active: true,
      billing_legal_name: "PennPaps East LLC",
      billing_tax_id: "333333333",
      billing_address_line1: "7 East Ave",
      billing_address_line2: null,
      billing_city: "Scranton",
      billing_state: "PA",
      billing_zip: "18503",
    };
  }

  it("emits the BRANCH billing NPI for a single-branch export", async () => {
    isFeatureEnabledMock.mockResolvedValue(true);
    // One claim for a patient anchored to the West branch.
    stageSupabaseResponse("insurance_claims", "select", {
      data: [makeClaim({ id: "c1", patient_id: "pat1" })],
    });
    stageSupabaseResponse("payer_profiles", "select", {
      data: { payer_legal_name: "Aetna", office_ally_payer_id: "60054" },
    });
    stageClaimDetail();
    // resolveBatchBillingLocation: patient → West branch.
    stageSupabaseResponse("patients", "select", {
      data: [{ id: "pat1", location_id: WEST_LOCATION_ID }],
    });
    // Two resolveBillingIdentity passes (mismatch probe + final build), each
    // reads org + clearinghouse + the West location row.
    stageOrgIdentity(2);
    stageSupabaseResponse("locations", "select", { data: westBranchRow() });
    stageSupabaseResponse("locations", "select", { data: westBranchRow() });

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
      // The 2010AA billing-provider loop carries the BRANCH NPI, not the org's.
      expect(result.payload).toContain("1212121212");
      expect(result.payload).not.toContain("9999999999");
    }
  });

  it("rejects a mixed-location export (location_billing_mismatch)", async () => {
    isFeatureEnabledMock.mockResolvedValue(true);
    // Two claims, same payer, but patients anchored to DIFFERENT branches.
    stageSupabaseResponse("insurance_claims", "select", {
      data: [
        makeClaim({ id: "c1", patient_id: "patW" }),
        makeClaim({ id: "c2", patient_id: "patE" }),
      ],
    });
    stageSupabaseResponse("payer_profiles", "select", {
      data: { payer_legal_name: "Aetna", office_ally_payer_id: "60054" },
    });
    // buildOneDetail runs for both claims before the mismatch check.
    stageClaimDetail();
    stageClaimDetail();
    // resolveBatchBillingLocation: patW → West, patE → East.
    stageSupabaseResponse("patients", "select", {
      data: [
        { id: "patW", location_id: WEST_LOCATION_ID },
        { id: "patE", location_id: EAST_LOCATION_ID },
      ],
    });
    // Two distinct candidates → two resolveBillingIdentity calls (one each).
    stageOrgIdentity(2);
    stageSupabaseResponse("locations", "select", { data: westBranchRow() });
    stageSupabaseResponse("locations", "select", { data: eastBranchRow() });

    const result = await buildExport837P({
      orgId: MOCK_ORG_ID,
      claimIds: ["c1", "c2"],
      receiver: {
        interchangeId: "MYCLR",
        organizationName: "MY CLEARINGHOUSE",
      },
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.kind).toBe("location_billing_mismatch");
      // Both distinct branch NPIs are surfaced for the operator.
      expect(result.detail?.npis).toEqual(
        expect.arrayContaining(["1212121212", "3434343434"]),
      );
    }
  });
});
