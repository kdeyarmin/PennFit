// Tests for office-ally-batch, focused on the billedCents = billed_cents * quantity
// change in buildOneDetail introduced in this PR.
//
// Before this PR, the service-line mapping was:
//   billedCents: l.billed_cents
//
// That was wrong because 837P SV102 is the EXTENDED line charge
// (per-unit × units), not the per-unit amount.  SV104 carries the
// quantity separately.  The fix changes the mapping to:
//   billedCents: l.billed_cents * l.quantity
//
// These tests verify the corrected mapping via buildOneDetail's return
// value.

import { describe, expect, it, beforeEach } from "vitest";
import {
  getSupabaseServiceRoleClient,
} from "@workspace/resupply-db";

import {
  installSupabaseMock,
  stageSupabaseResponse,
} from "../../test-helpers/supabase-mock";

const supabaseMock = installSupabaseMock();

import { buildOneDetail } from "./office-ally-batch";

beforeEach(() => {
  supabaseMock.reset();
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// Minimal ClaimRow shape that satisfies buildOneDetail's type.
function makeClaimRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "claim-oa-001",
    patient_id: "patient-oa-001",
    insurance_coverage_id: "cov-oa-001",
    secondary_coverage_id: null,
    rendering_provider_id: null,
    referring_provider_id: null,
    total_billed_cents: 5000,
    date_of_service: "2026-05-15",
    payer_profile_id: null,
    status: "draft",
    ...overrides,
  };
}

// Stage the minimal set of DB calls for buildOneDetail to succeed:
// 1. insurance_coverages (primary)
// 2. patients
// 3. insurance_claim_line_items
// (sleep_studies, providers: optional → unstaged default returns null)
function stageMinimalDetail(
  lines: Array<{ hcpcs_code: string; modifier: string | null; billed_cents: number; quantity: number }>,
) {
  stageSupabaseResponse("insurance_coverages", "select", {
    data: { member_id: "MBR-001", policyholder_relationship: "self" },
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
    data: lines,
    error: null,
  });
}

// ---------------------------------------------------------------------------
// billedCents = billed_cents × quantity (the PR's core change)
// ---------------------------------------------------------------------------

describe("buildOneDetail — serviceLines billedCents = billed_cents × quantity", () => {
  it("multiplies billed_cents by quantity to produce the extended line charge", async () => {
    // 2 units @ $15.99 → extended = $31.98
    stageMinimalDetail([
      { hcpcs_code: "A7038", modifier: "NU", billed_cents: 1599, quantity: 2 },
    ]);

    const claim = makeClaimRow({ total_billed_cents: 3198 });
    const supabase = getSupabaseServiceRoleClient();
    const detail = await buildOneDetail(supabase, claim as never, "Highmark Blue Cross", "00700");

    expect(detail).not.toBeNull();
    expect(detail!.serviceLines).toHaveLength(1);
    expect(detail!.serviceLines[0]!.billedCents).toBe(3198); // 1599 × 2
    expect(detail!.serviceLines[0]!.units).toBe(2);
  });

  it("treats quantity=1 as the pass-through case (billedCents equals billed_cents)", async () => {
    stageMinimalDetail([
      { hcpcs_code: "E0601", modifier: "RR,KX", billed_cents: 24999, quantity: 1 },
    ]);

    const claim = makeClaimRow({ total_billed_cents: 24999 });
    const supabase = getSupabaseServiceRoleClient();
    const detail = await buildOneDetail(supabase, claim as never, "Aetna", "60054");

    expect(detail!.serviceLines[0]!.billedCents).toBe(24999); // 24999 × 1
    expect(detail!.serviceLines[0]!.units).toBe(1);
  });

  it("multiplies correctly for multi-line claims (each line independently)", async () => {
    // Line 1: 1 × $50.00 = $50.00
    // Line 2: 3 × $10.00 = $30.00
    stageMinimalDetail([
      { hcpcs_code: "E0601", modifier: "RR", billed_cents: 5000, quantity: 1 },
      { hcpcs_code: "A7032", modifier: "NU", billed_cents: 1000, quantity: 3 },
    ]);

    const claim = makeClaimRow({ total_billed_cents: 8000 });
    const supabase = getSupabaseServiceRoleClient();
    const detail = await buildOneDetail(supabase, claim as never, "UHC", "87726");

    expect(detail!.serviceLines).toHaveLength(2);
    expect(detail!.serviceLines[0]!.billedCents).toBe(5000); // 5000 × 1
    expect(detail!.serviceLines[1]!.billedCents).toBe(3000); // 1000 × 3
  });

  it("carries the hcpcs code and modifiers through unchanged", async () => {
    stageMinimalDetail([
      { hcpcs_code: "E0601", modifier: "rr,kx", billed_cents: 24999, quantity: 1 },
    ]);

    const claim = makeClaimRow({ total_billed_cents: 24999 });
    const supabase = getSupabaseServiceRoleClient();
    const detail = await buildOneDetail(supabase, claim as never, "BCBS", "00790");

    const line = detail!.serviceLines[0]!;
    expect(line.hcpcsCode).toBe("E0601");
    // Modifiers are uppercased and filtered to exactly 2-char strings.
    expect(line.modifiers).toContain("RR");
    expect(line.modifiers).toContain("KX");
  });

  it("returns the date_of_service from the claim on each service line", async () => {
    stageMinimalDetail([
      { hcpcs_code: "E0601", modifier: "RR", billed_cents: 24999, quantity: 1 },
    ]);

    const claim = makeClaimRow({ date_of_service: "2026-05-15" });
    const supabase = getSupabaseServiceRoleClient();
    const detail = await buildOneDetail(supabase, claim as never, "BCBS", "00790");

    expect(detail!.serviceLines[0]!.serviceDate).toBe("2026-05-15");
  });
});

// ---------------------------------------------------------------------------
// Null/missing guard cases
// ---------------------------------------------------------------------------

describe("buildOneDetail — null guard paths", () => {
  it("returns null when insurance_coverage_id is missing from claim", async () => {
    const claim = makeClaimRow({ insurance_coverage_id: null });
    const supabase = getSupabaseServiceRoleClient();
    const detail = await buildOneDetail(supabase, claim as never, "BCBS", "00790");
    expect(detail).toBeNull();
  });

  it("returns null when no line items exist for the claim", async () => {
    stageSupabaseResponse("insurance_coverages", "select", {
      data: { member_id: "MBR-002", policyholder_relationship: "self" },
      error: null,
    });
    stageSupabaseResponse("patients", "select", {
      data: {
        legal_first_name: "John",
        legal_last_name: "Smith",
        date_of_birth: "1975-05-10",
        address: { line1: "5 Oak Ave", city: "Erie", state: "PA", zip: "16501" },
      },
      error: null,
    });
    stageSupabaseResponse("insurance_claim_line_items", "select", {
      data: [],
      error: null,
    });

    const claim = makeClaimRow();
    const supabase = getSupabaseServiceRoleClient();
    const detail = await buildOneDetail(supabase, claim as never, "BCBS", "00790");
    expect(detail).toBeNull();
  });

  it("returns null when patient address is incomplete (missing zip)", async () => {
    stageSupabaseResponse("insurance_coverages", "select", {
      data: { member_id: "MBR-003", policyholder_relationship: "self" },
      error: null,
    });
    stageSupabaseResponse("patients", "select", {
      data: {
        legal_first_name: "Ann",
        legal_last_name: "Jones",
        date_of_birth: "1990-03-15",
        address: { line1: "10 Elm", city: "Altoona", state: "PA", zip: null },
      },
      error: null,
    });
    stageSupabaseResponse("insurance_claim_line_items", "select", {
      data: [{ hcpcs_code: "E0601", modifier: "RR", billed_cents: 24999, quantity: 1 }],
      error: null,
    });

    const claim = makeClaimRow();
    const supabase = getSupabaseServiceRoleClient();
    const detail = await buildOneDetail(supabase, claim as never, "BCBS", "00790");
    expect(detail).toBeNull();
  });

  it("returns null when the patient row is missing entirely", async () => {
    stageSupabaseResponse("insurance_coverages", "select", {
      data: { member_id: "MBR-004", policyholder_relationship: "self" },
      error: null,
    });
    stageSupabaseResponse("patients", "select", {
      data: null,
      error: null,
    });
    stageSupabaseResponse("insurance_claim_line_items", "select", {
      data: [{ hcpcs_code: "E0601", modifier: "RR", billed_cents: 24999, quantity: 1 }],
      error: null,
    });

    const claim = makeClaimRow();
    const supabase = getSupabaseServiceRoleClient();
    const detail = await buildOneDetail(supabase, claim as never, "BCBS", "00790");
    expect(detail).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Claim-level fields
// ---------------------------------------------------------------------------

describe("buildOneDetail — claim-level fields", () => {
  it("passes totalBilledCents from the claim header unchanged", async () => {
    stageMinimalDetail([
      { hcpcs_code: "E0601", modifier: "RR", billed_cents: 24999, quantity: 1 },
    ]);

    const claim = makeClaimRow({ total_billed_cents: 99999 });
    const supabase = getSupabaseServiceRoleClient();
    const detail = await buildOneDetail(supabase, claim as never, "BCBS", "00790");

    // totalBilledCents comes from claim.total_billed_cents, not from line sum.
    expect(detail!.totalBilledCents).toBe(99999);
  });

  it("trims the internal claim id to 38 chars for the clearinghouse control number", async () => {
    stageMinimalDetail([
      { hcpcs_code: "E0601", modifier: "RR", billed_cents: 24999, quantity: 1 },
    ]);

    const claim = makeClaimRow({
      id: "00000000-0000-4000-8000-000000000001",
    });
    const supabase = getSupabaseServiceRoleClient();
    const detail = await buildOneDetail(supabase, claim as never, "BCBS", "00790");

    expect(detail!.internalClaimId.length).toBeLessThanOrEqual(38);
  });

  it("sets placeOfServiceCode to '12' (home)", async () => {
    stageMinimalDetail([
      { hcpcs_code: "E0601", modifier: "RR", billed_cents: 24999, quantity: 1 },
    ]);

    const claim = makeClaimRow();
    const supabase = getSupabaseServiceRoleClient();
    const detail = await buildOneDetail(supabase, claim as never, "Aetna", "60054");

    expect(detail!.placeOfServiceCode).toBe("12");
  });

  it("uses the sleep study diagnosis when available, falls back to G47.33", async () => {
    stageSupabaseResponse("insurance_coverages", "select", {
      data: { member_id: "MBR-DX", policyholder_relationship: "self" },
      error: null,
    });
    stageSupabaseResponse("patients", "select", {
      data: {
        legal_first_name: "Bob",
        legal_last_name: "Lee",
        date_of_birth: "1970-01-01",
        address: { line1: "99 Pine", city: "Harrisburg", state: "PA", zip: "17101" },
      },
      error: null,
    });
    stageSupabaseResponse("insurance_claim_line_items", "select", {
      data: [{ hcpcs_code: "E0601", modifier: "RR", billed_cents: 24999, quantity: 1 }],
      error: null,
    });
    stageSupabaseResponse("sleep_studies", "select", {
      data: { diagnosis_icd10: "G47.30" },
      error: null,
    });

    const claim = makeClaimRow();
    const supabase = getSupabaseServiceRoleClient();
    const detail = await buildOneDetail(supabase, claim as never, "BCBS", "00790");

    expect(detail!.diagnosisCodes).toContain("G47.30");
  });

  it("falls back to G47.33 when no sleep study exists", async () => {
    stageSupabaseResponse("insurance_coverages", "select", {
      data: { member_id: "MBR-NOstudy", policyholder_relationship: "self" },
      error: null,
    });
    stageSupabaseResponse("patients", "select", {
      data: {
        legal_first_name: "Carol",
        legal_last_name: "Kim",
        date_of_birth: "1985-07-04",
        address: { line1: "8 River Rd", city: "Scranton", state: "PA", zip: "18503" },
      },
      error: null,
    });
    stageSupabaseResponse("insurance_claim_line_items", "select", {
      data: [{ hcpcs_code: "E0601", modifier: "RR", billed_cents: 24999, quantity: 1 }],
      error: null,
    });
    // sleep_studies unstaged → returns null

    const claim = makeClaimRow();
    const supabase = getSupabaseServiceRoleClient();
    const detail = await buildOneDetail(supabase, claim as never, "BCBS", "00790");

    expect(detail!.diagnosisCodes).toContain("G47.33");
  });
});
