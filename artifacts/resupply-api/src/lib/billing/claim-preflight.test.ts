// Tests for the preflight engine. We mock the Supabase service
// client and stage one response per query the engine issues, then
// assert the returned PreflightSummary.

import { describe, expect, it, beforeEach } from "vitest";

import {
  installSupabaseMock,
  stageSupabaseResponse,
  stageSupabaseRpcResponse,
} from "../../test-helpers/supabase-mock";

const supabaseMock = installSupabaseMock();

import { isNocHcpcs, preflightClaim } from "./claim-preflight";

const CLAIM_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const PATIENT_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const COVERAGE_ID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const PAYER_PROFILE_ID = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const PROVIDER_ID = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
const LINE_ID = "ffffffff-ffff-4fff-8fff-ffffffffffff";
const MS_PER_DAY = 24 * 60 * 60 * 1000;

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
    stagePayerProfile({
      paper_only: false,
      office_ally_payer_id: "54771",
      is_active: true,
      requires_prior_auth_dme: false,
    });
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

  it("blocks submit when required paperwork is still outstanding", async () => {
    stageHappyPath(
      {},
      {
        paperworkOverride: [
          {
            status: "outstanding",
            required: true,
            label: "Signed proof of delivery",
          },
        ],
      },
    );
    const out = await preflightClaim(CLAIM_ID);
    const item = out.items.find((i) => i.key === "bill_hold");
    expect(item?.severity).toBe("error");
    expect(item?.label).toBe("On bill hold — signed paperwork outstanding");
    expect(out.readyToSubmit).toBe(false);
  });


  it("surfaces active coverage from a recent parsed 271", async () => {
    stageHappyPath();
    stageSupabaseResponse("eligibility_checks", "select", {
      data: {
        id: "eli-1",
        is_active: true,
        in_network: true,
        requires_prior_auth: false,
        responded_at: "2026-05-20T10:00:00.000Z",
        requested_at: "2026-05-20T09:59:00.000Z",
      },
    });
    const out = await preflightClaim(CLAIM_ID);
    const item = out.items.find((i) => i.key === "eligibility");
    expect(item?.severity).toBe("ok");
    expect(item?.label).toBe("Coverage active");
    expect(item?.detail).toContain("2026-05-20");
    expect(item?.detail).toContain("in-network");
    expect(out.readyToSubmit).toBe(true);
  });

  it("warns (without blocking) when the cached 271 shows the plan inactive", async () => {
    stageHappyPath();
    stageSupabaseResponse("eligibility_checks", "select", {
      data: {
        id: "eli-2",
        is_active: false,
        in_network: null,
        requires_prior_auth: false,
        responded_at: "2026-05-18T10:00:00.000Z",
        requested_at: "2026-05-18T09:59:00.000Z",
      },
    });
    const out = await preflightClaim(CLAIM_ID);
    const item = out.items.find((i) => i.key === "eligibility");
    expect(item?.severity).toBe("warning");
    expect(item?.label).toBe("Coverage shows inactive");
    // Advisory only — eligibility never flips the submit gate.
    expect(out.readyToSubmit).toBe(true);
    expect(out.errorCount).toBe(0);
  });

  it("warns when there is no recent eligibility check on file", async () => {
    stageHappyPath();
    // eligibility_checks unstaged → getCachedEligibility returns null
    const out = await preflightClaim(CLAIM_ID);
    const item = out.items.find((i) => i.key === "eligibility");
    expect(item?.severity).toBe("warning");
    expect(item?.label).toBe("Eligibility not verified recently");
  });

  it("surfaces a non-blocking denial-risk warning from the history RPC", async () => {
    stageHappyPath();
    // Payer has denied 40% of recent E0601 claims (n=50, ≥ defaults).
    // PostgREST serializes bigint as string — stage them that way.
    stageSupabaseRpcResponse("billing_denial_risk", {
      data: [{ hcpcs_code: "E0601", decisions: "50", denials: "20" }],
    });
    const out = await preflightClaim(CLAIM_ID);
    const risk = out.items.find((i) => i.key === "denial_risk:E0601");
    expect(risk?.severity).toBe("warning");
    expect(risk?.detail).toContain("40%");
    // A warning must never flip the submit gate.
    expect(out.readyToSubmit).toBe(true);
    expect(out.errorCount).toBe(0);
  });

  it("adds no denial-risk item when the history RPC returns nothing", async () => {
    stageHappyPath();
    const out = await preflightClaim(CLAIM_ID);
    expect(out.items.some((i) => i.key.startsWith("denial_risk:"))).toBe(false);
  });

  it("flags missing referring provider as an error", async () => {
    stageHappyPath(
      { referring_provider_id: null },
      {
        payerOverride: {
          paper_only: false,
          office_ally_payer_id: "54771",
          requires_prior_auth_dme: false,
          is_active: true,
          requires_referring_provider_npi: true,
        },
      },
    );
    const out = await preflightClaim(CLAIM_ID);
    const item = out.items.find((i) => i.key === "referring_provider");
    expect(item?.severity).toBe("error");
    expect(out.readyToSubmit).toBe(false);
  });

  it("does not block missing referring provider when payer does not require it", async () => {
    stageHappyPath(
      { referring_provider_id: null },
      {
        payerOverride: {
          paper_only: false,
          office_ally_payer_id: "54771",
          requires_prior_auth_dme: false,
          is_active: true,
          requires_referring_provider_npi: false,
        },
      },
    );
    const out = await preflightClaim(CLAIM_ID);
    expect(
      out.items.find((i) => i.key === "referring_provider")?.severity,
    ).toBe("ok");
    expect(
      out.items.find((i) => i.key === "payer_referring_provider")?.severity,
    ).toBe("ok");
    expect(out.readyToSubmit).toBe(true);
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

  it("balances a multi-unit line on the EXTENDED charge (billed_cents * quantity)", async () => {
    // 2 units @ $15.99 each → header must be the extended $31.98, not
    // the per-unit $15.99 (billed_cents is per-unit).
    stageHappyPath(
      { total_billed_cents: 3198 },
      {
        linesOverride: [
          {
            id: LINE_ID,
            hcpcs_code: "A7038",
            modifier: "NU",
            billed_cents: 1599,
            quantity: 2,
          },
        ],
      },
    );
    const out = await preflightClaim(CLAIM_ID);
    const item = out.items.find((i) => i.key === "totals");
    expect(item?.severity).toBe("ok");
  });

  it("flags a header that sums only per-unit billed_cents (ignores quantity)", async () => {
    // The old (buggy) header for a 2-unit line would be $15.99; the
    // extended sum is $31.98, so the preflight must now flag it.
    stageHappyPath(
      { total_billed_cents: 1599 },
      {
        linesOverride: [
          {
            id: LINE_ID,
            hcpcs_code: "A7038",
            modifier: "NU",
            billed_cents: 1599,
            quantity: 2,
          },
        ],
      },
    );
    const out = await preflightClaim(CLAIM_ID);
    const item = out.items.find((i) => i.key === "totals");
    expect(item?.severity).toBe("warning");
  });

  it("flags paper-only payer as a warning", async () => {
    stageHappyPath(
      {},
      {
        payerOverride: {
          paper_only: true,
          office_ally_payer_id: null,
          requires_prior_auth_dme: false,
          is_active: true,
        },
      },
    );
    const out = await preflightClaim(CLAIM_ID);
    const item = out.items.find((i) => i.key === "payer_profile");
    expect(item?.severity).toBe("warning");
  });

  // ── Phase 12 (migration 0142) — payer completeness preflight ────

  it("flags pending enrollment_status as a warning", async () => {
    stageHappyPath(
      {},
      {
        payerOverride: {
          paper_only: false,
          office_ally_payer_id: "54771",
          requires_prior_auth_dme: false,
          is_active: true,
          enrollment_status: "pending",
        },
      },
    );
    const out = await preflightClaim(CLAIM_ID);
    const item = out.items.find((i) => i.key === "payer_enrollment");
    expect(item?.severity).toBe("warning");
  });

  it("flags suspended enrollment_status as an error", async () => {
    stageHappyPath(
      {},
      {
        payerOverride: {
          paper_only: false,
          office_ally_payer_id: "54771",
          requires_prior_auth_dme: false,
          is_active: true,
          enrollment_status: "suspended",
        },
      },
    );
    const out = await preflightClaim(CLAIM_ID);
    const item = out.items.find((i) => i.key === "payer_enrollment");
    expect(item?.severity).toBe("error");
    expect(out.readyToSubmit).toBe(false);
  });

  it("flags DOS pre-dating enrollment_effective_on as an error", async () => {
    stageHappyPath(
      { date_of_service: "2026-05-12" },
      {
        payerOverride: {
          paper_only: false,
          office_ally_payer_id: "54771",
          requires_prior_auth_dme: false,
          is_active: true,
          enrollment_status: "active",
          enrollment_effective_on: "2026-06-01",
        },
      },
    );
    const out = await preflightClaim(CLAIM_ID);
    const item = out.items.find((i) => i.key === "payer_enrollment");
    expect(item?.severity).toBe("error");
  });

  it("marks enrollment_status=not_required as ok", async () => {
    stageHappyPath(
      {},
      {
        payerOverride: {
          paper_only: false,
          office_ally_payer_id: "54771",
          requires_prior_auth_dme: false,
          is_active: true,
          enrollment_status: "not_required",
        },
      },
    );
    const out = await preflightClaim(CLAIM_ID);
    const item = out.items.find((i) => i.key === "payer_enrollment");
    expect(item?.severity).toBe("ok");
  });

  it("flags past-timely-filing-window claim as an error", async () => {
    stageHappyPath(
      { date_of_service: "2025-01-01" },
      {
        payerOverride: {
          paper_only: false,
          office_ally_payer_id: "54771",
          requires_prior_auth_dme: false,
          is_active: true,
          timely_filing_days: 30,
        },
      },
    );
    const out = await preflightClaim(CLAIM_ID);
    const item = out.items.find((i) => i.key === "timely_filing");
    expect(item?.severity).toBe("error");
  });

  it("flags missing timely-filing config as a warning", async () => {
    stageHappyPath(
      {},
      {
        payerOverride: {
          paper_only: false,
          office_ally_payer_id: "54771",
          requires_prior_auth_dme: false,
          is_active: true,
          timely_filing_days: null,
        },
      },
    );
    const out = await preflightClaim(CLAIM_ID);
    const item = out.items.find((i) => i.key === "timely_filing");
    expect(item?.severity).toBe("warning");
  });

  it("flags missing required-modifiers as a warning", async () => {
    stageHappyPath(
      {},
      {
        // Line items default carry "RR,KX" — set the required modifier
        // to one not present so the check fires.
        payerOverride: {
          paper_only: false,
          office_ally_payer_id: "54771",
          requires_prior_auth_dme: false,
          is_active: true,
          required_modifiers_dme: ["GA"],
        },
      },
    );
    const out = await preflightClaim(CLAIM_ID);
    const item = out.items.find((i) => i.key === "payer_modifiers");
    expect(item?.severity).toBe("warning");
  });

  it("flags missing required-modifiers config as a warning", async () => {
    stageHappyPath(
      {},
      {
        payerOverride: {
          paper_only: false,
          office_ally_payer_id: "54771",
          requires_prior_auth_dme: false,
          is_active: true,
          required_modifiers_dme: [],
        },
      },
    );
    const out = await preflightClaim(CLAIM_ID);
    const item = out.items.find((i) => i.key === "payer_modifiers");
    expect(item?.severity).toBe("warning");
  });

  it("flags missing referring provider NPI when payer requires it", async () => {
    stageHappyPath(
      { referring_provider_id: null },
      {
        payerOverride: {
          paper_only: false,
          office_ally_payer_id: "54771",
          requires_prior_auth_dme: false,
          is_active: true,
          requires_referring_provider_npi: true,
        },
      },
    );
    const out = await preflightClaim(CLAIM_ID);
    const item = out.items.find((i) => i.key === "payer_referring_provider");
    expect(item?.severity).toBe("error");
    expect(item?.fixAction).toEqual({
      kind: "set_referring_provider",
      claimId: CLAIM_ID,
    });
  });
});

describe("isNocHcpcs", () => {
  it("flags miscellaneous / not-otherwise-classified DME codes", () => {
    for (const code of ["E1399", "A9999", "K0108", "A4649", "E1699"]) {
      expect(isNocHcpcs(code)).toBe(true);
    }
  });
  it("is case-insensitive and trims", () => {
    expect(isNocHcpcs("  e1399 ")).toBe(true);
  });
  it("does not flag standard CPAP/supply codes", () => {
    for (const code of ["E0601", "A7030", "A7034", "A7038", "E0562"]) {
      expect(isNocHcpcs(code)).toBe(false);
    }
  });
  it("handles null/undefined/empty", () => {
    expect(isNocHcpcs(null)).toBe(false);
    expect(isNocHcpcs(undefined)).toBe(false);
    expect(isNocHcpcs("")).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────

interface ClaimOverrides {
  rendering_provider_id?: string | null;
  referring_provider_id?: string | null;
  total_billed_cents?: number;
  date_of_service?: string;
}

interface DataOverrides {
  addressOverride?: typeof FULL_PATIENT_ADDRESS | null;
  diagnosisOverride?: string | null;
  linesOverride?: Array<{
    id: string;
    hcpcs_code: string;
    modifier: string | null;
    billed_cents: number;
    quantity: number;
  }>;
  payerOverride?: {
    paper_only: boolean;
    office_ally_payer_id: string | null;
    requires_prior_auth_dme: boolean;
    is_active: boolean;
    // ── Phase 12 (migration 0142) optional payer fields ──
    timely_filing_days?: number | null;
    required_modifiers_dme?: string[];
    requires_referring_provider_npi?: boolean;
    enrollment_status?:
      | "unknown"
      | "not_required"
      | "pending"
      | "active"
      | "suspended";
    enrollment_effective_on?: string | null;
  };
  paperworkOverride?: Array<{
    status: "outstanding" | "satisfied" | "waived" | "voided";
    required: boolean;
    label: string;
  }>;
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
      status: "draft",
      total_billed_cents: claimOver.total_billed_cents ?? 24999,
      date_of_service: claimOver.date_of_service ?? isoDateDaysAgo(30),
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
  stageClaimPaperwork(data.paperworkOverride);
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
  if ((data.payerOverride?.required_modifiers_dme?.length ?? 0) > 0) {
    stageLineItemsHappy(data.linesOverride);
  }

  function isoDateDaysAgo(daysAgo: number): string {
    const now = new Date();
    const todayUtc = Date.UTC(
      now.getUTCFullYear(),
      now.getUTCMonth(),
      now.getUTCDate(),
    );
    return new Date(todayUtc - daysAgo * MS_PER_DAY).toISOString().slice(0, 10);
  }
}

function stageClaimPaperwork(
  rows:
    | Array<{
        status: "outstanding" | "satisfied" | "waived" | "voided";
        required: boolean;
        label: string;
      }>
    | undefined = [
    { status: "satisfied", required: true, label: "Signed prescription" },
    { status: "satisfied", required: true, label: "Proof of delivery" },
    { status: "satisfied", required: true, label: "Assignment of Benefits" },
  ],
): void {
  stageSupabaseResponse("claim_paperwork_requirements", "select", {
    data: rows,
  });
}

function stagePayerProfile(overrides: {
  paper_only: boolean;
  office_ally_payer_id: string | null;
  requires_prior_auth_dme: boolean;
  is_active: boolean;
  timely_filing_days?: number | null;
  required_modifiers_dme?: string[];
  requires_referring_provider_npi?: boolean;
  enrollment_status?:
    | "unknown"
    | "not_required"
    | "pending"
    | "active"
    | "suspended";
  enrollment_effective_on?: string | null;
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
      edi_enrollment_status: "enrolled",
      timely_filing_days:
        overrides.timely_filing_days === undefined
          ? 180
          : overrides.timely_filing_days,
      required_modifiers_dme: overrides.required_modifiers_dme ?? [],
      requires_referring_provider_npi:
        overrides.requires_referring_provider_npi ?? false,
      enrollment_status: overrides.enrollment_status ?? "active",
      enrollment_effective_on: overrides.enrollment_effective_on ?? null,
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

function stageDiagnosisHappy(
  diagnosisOverride: string | null = "G47.33",
): void {
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
    {
      id: LINE_ID,
      hcpcs_code: "E0601",
      modifier: "RR,KX",
      billed_cents: 24999,
      quantity: 1,
    },
  ],
): void {
  stageSupabaseResponse("insurance_claim_line_items", "select", {
    data: lines,
  });
}
