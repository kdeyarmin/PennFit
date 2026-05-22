// Tests for the preflight engine. We mock the Supabase service
// client and stage one response per query the engine issues, then
// assert the returned PreflightSummary.

import { describe, expect, it, beforeEach } from "vitest";

import {
  installSupabaseMock,
  stageSupabaseResponse,
} from "../../test-helpers/supabase-mock";

const supabaseMock = installSupabaseMock();

import { preflightClaim } from "./claim-preflight";

const CLAIM_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const PATIENT_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const COVERAGE_ID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const PAYER_PROFILE_ID = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const PROVIDER_ID = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
const LINE_ID = "ffffffff-ffff-4fff-8fff-ffffffffffff";

const FULL_PATIENT_ADDRESS = {
  line1: "100 Main St",
  city: "State College",
  state: "PA",
  zip: "16801",
};

describe("preflightClaim", () => {
  beforeEach(() => {
    supabaseMock.reset();
  });

  it("returns ready=false with one error when the claim doesn't exist", async () => {
    stageSupabaseResponse("insurance_claims", "select", { data: null });
    const out = await preflightClaim(CLAIM_ID);
    expect(out.readyToSubmit).toBe(false);
    expect(out.errorCount).toBe(1);
    expect(out.items[0]!.key).toBe("claim_exists");
  });

  it("flags claim not in draft as an error", async () => {
    stageSupabaseResponse("insurance_claims", "select", {
      data: {
        id: CLAIM_ID,
        patient_id: PATIENT_ID,
        payer_name: "Highmark",
        payer_profile_id: PAYER_PROFILE_ID,
        date_of_service: "2026-05-12",
        status: "submitted",
        total_billed_cents: 24999,
        insurance_coverage_id: COVERAGE_ID,
        rendering_provider_id: PROVIDER_ID,
        referring_provider_id: PROVIDER_ID,
        secondary_coverage_id: null,
        fulfillment_id: null,
      },
    });
    stagePayerProfile({ paper_only: false, office_ally_payer_id: "54771", is_active: true, requires_prior_auth_dme: false });
    stagePatientHappy();
    stageDiagnosisHappy();
    stageLineItemsHappy();
    const out = await preflightClaim(CLAIM_ID);
    const statusItem = out.items.find((i) => i.key === "claim_status");
    expect(statusItem?.severity).toBe("error");
  });

  it("returns readyToSubmit=true for a fully populated draft", async () => {
    stageHappyPath();
    const out = await preflightClaim(CLAIM_ID);
    expect(out.readyToSubmit).toBe(true);
    expect(out.errorCount).toBe(0);
  });

  it("flags missing referring provider as an error", async () => {
    stageHappyPath({ referring_provider_id: null });
    const out = await preflightClaim(CLAIM_ID);
    const item = out.items.find((i) => i.key === "referring_provider");
    expect(item?.severity).toBe("error");
    expect(out.readyToSubmit).toBe(false);
  });

  it("flags missing rendering provider as a warning (not blocking)", async () => {
    stageHappyPath({ rendering_provider_id: null });
    const out = await preflightClaim(CLAIM_ID);
    const item = out.items.find((i) => i.key === "rendering_provider");
    expect(item?.severity).toBe("warning");
  });

  it("flags missing patient address as an error with edit_address fix action", async () => {
    stageHappyPath({}, { addressOverride: null });
    const out = await preflightClaim(CLAIM_ID);
    const item = out.items.find((i) => i.key === "patient_address");
    expect(item?.severity).toBe("error");
    expect(item?.fixAction).toEqual({
      kind: "edit_address",
      patientId: PATIENT_ID,
    });
  });

  it("flags missing diagnosis with an add_sleep_study fix action", async () => {
    stageHappyPath({}, { diagnosisOverride: null });
    const out = await preflightClaim(CLAIM_ID);
    const item = out.items.find((i) => i.key === "diagnosis");
    expect(item?.severity).toBe("error");
    expect(item?.fixAction).toEqual({
      kind: "add_sleep_study",
      patientId: PATIENT_ID,
    });
  });

  it("flags no line items as an error", async () => {
    stageHappyPath({}, { linesOverride: [] });
    const out = await preflightClaim(CLAIM_ID);
    const item = out.items.find((i) => i.key === "line_items");
    expect(item?.severity).toBe("error");
  });

  it("flags totals mismatch as a warning", async () => {
    stageHappyPath({ total_billed_cents: 99 });
    const out = await preflightClaim(CLAIM_ID);
    const item = out.items.find((i) => i.key === "totals");
    expect(item?.severity).toBe("warning");
  });

  it("flags paper-only payer as a warning", async () => {
    stageHappyPath({}, { payerOverride: { paper_only: true, office_ally_payer_id: null, requires_prior_auth_dme: false, is_active: true } });
    const out = await preflightClaim(CLAIM_ID);
    const item = out.items.find((i) => i.key === "payer_profile");
    expect(item?.severity).toBe("warning");
  });
});

// ─────────────────────────────────────────────────────────────────────

interface ClaimOverrides {
  rendering_provider_id?: string | null;
  referring_provider_id?: string | null;
  total_billed_cents?: number;
}

interface DataOverrides {
  addressOverride?: typeof FULL_PATIENT_ADDRESS | null;
  diagnosisOverride?: string | null;
  linesOverride?: Array<{ id: string; hcpcs_code: string; modifier: string | null; billed_cents: number; quantity: number }>;
  payerOverride?: {
    paper_only: boolean;
    office_ally_payer_id: string | null;
    requires_prior_auth_dme: boolean;
    is_active: boolean;
  };
}

function stageHappyPath(
  claimOver: ClaimOverrides = {},
  data: DataOverrides = {},
): void {
  stageSupabaseResponse("insurance_claims", "select", {
    data: {
      id: CLAIM_ID,
      patient_id: PATIENT_ID,
      payer_name: "Highmark BCBS",
      payer_profile_id: PAYER_PROFILE_ID,
      date_of_service: "2026-05-12",
      status: "draft",
      total_billed_cents: claimOver.total_billed_cents ?? 24999,
      insurance_coverage_id: COVERAGE_ID,
      rendering_provider_id:
        claimOver.rendering_provider_id === undefined
          ? PROVIDER_ID
          : claimOver.rendering_provider_id,
      referring_provider_id:
        claimOver.referring_provider_id === undefined
          ? PROVIDER_ID
          : claimOver.referring_provider_id,
      secondary_coverage_id: null,
      fulfillment_id: null,
    },
  });
  stagePayerProfile(
    data.payerOverride ?? {
      paper_only: false,
      office_ally_payer_id: "54771",
      requires_prior_auth_dme: false,
      is_active: true,
    },
  );
  stagePatientHappy(data.addressOverride);
  stageDiagnosisHappy(data.diagnosisOverride);
  stageLineItemsHappy(data.linesOverride);
}

function stagePayerProfile(overrides: {
  paper_only: boolean;
  office_ally_payer_id: string | null;
  requires_prior_auth_dme: boolean;
  is_active: boolean;
}): void {
  stageSupabaseResponse("payer_profiles", "select", {
    data: {
      id: PAYER_PROFILE_ID,
      display_name: "Highmark BCBS",
      is_active: overrides.is_active,
      paper_only: overrides.paper_only,
      office_ally_payer_id: overrides.office_ally_payer_id,
      claim_format: "837p",
      requires_prior_auth_dme: overrides.requires_prior_auth_dme,
      // Default to "enrolled" so happy-path preflight tests pass the
      // new EDI-enrollment gate (migration 0149 + preflight check).
      // Tests that exercise the enrollment failure path can pass an
      // override into stagePayerProfile to flip this.
      edi_enrollment_status: "enrolled",
    },
  });
}

function stagePatientHappy(
  addressOverride: typeof FULL_PATIENT_ADDRESS | null = FULL_PATIENT_ADDRESS,
): void {
  stageSupabaseResponse("patients", "select", {
    data: {
      legal_first_name: "JANE",
      legal_last_name: "DOE",
      date_of_birth: "1965-04-12",
      address: addressOverride,
    },
  });
}

function stageDiagnosisHappy(diagnosisOverride: string | null = "G47.33"): void {
  stageSupabaseResponse("sleep_studies", "select", {
    data: diagnosisOverride
      ? { diagnosis_icd10: diagnosisOverride, study_date: "2025-12-01" }
      : null,
  });
}

function stageLineItemsHappy(
  lines:
    | Array<{
        id: string;
        hcpcs_code: string;
        modifier: string | null;
        billed_cents: number;
        quantity: number;
      }>
    | undefined = [
    { id: LINE_ID, hcpcs_code: "E0601", modifier: "RR,KX", billed_cents: 24999, quantity: 1 },
  ],
): void {
  stageSupabaseResponse("insurance_claim_line_items", "select", {
    data: lines,
  });
}
