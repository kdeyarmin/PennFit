import { describe, expect, it, beforeEach } from "vitest";

import {
  installSupabaseMock,
  stageSupabaseResponse,
} from "../../test-helpers/supabase-mock";

const supabaseMock = installSupabaseMock();

import { scoreClaim } from "./heuristic-denial-scorer";

const CLAIM_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const PATIENT_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

function stageClaim(over: Record<string, unknown> = {}): void {
  stageSupabaseResponse("insurance_claims", "select", {
    data: {
      id: CLAIM_ID,
      patient_id: PATIENT_ID,
      payer_profile_id: "pp-1",
      insurance_coverage_id: "cov-1",
      referring_provider_id: "prov-1",
      date_of_service: "2026-05-12",
      total_billed_cents: 24999,
      ...over,
    },
  });
}

function stagePayer(over: Record<string, unknown> = {}): void {
  stageSupabaseResponse("payer_profiles", "select", {
    data: {
      display_name: "Highmark BCBS",
      line_of_business: "commercial",
      requires_prior_auth_dme: false,
      ...over,
    },
  });
}

describe("scoreClaim", () => {
  beforeEach(() => supabaseMock.reset());

  it("returns null when the claim doesn't exist", async () => {
    stageSupabaseResponse("insurance_claims", "select", { data: null });
    const r = await scoreClaim(CLAIM_ID);
    expect(r).toBeNull();
  });

  it("returns a low probability for a fully-populated commercial claim", async () => {
    stageClaim();
    stagePayer();
    stageSupabaseResponse("sleep_studies", "select", {
      data: { diagnosis_icd10: "G47.33" },
    });
    stageSupabaseResponse("patients", "select", {
      data: {
        address: {
          line1: "100 Main",
          city: "State College",
          state: "PA",
          zip: "16801",
        },
      },
    });
    stageSupabaseResponse("insurance_claim_line_items", "select", {
      data: [
        {
          hcpcs_code: "E0601",
          modifier: "RR,KX",
          billed_cents: 24999,
          quantity: 1,
        },
      ],
    });
    const r = await scoreClaim(CLAIM_ID);
    expect(r).not.toBeNull();
    expect(r!.probability).toBeLessThan(0.2);
  });

  it("returns a high probability when payer requires PA and none on file", async () => {
    stageClaim();
    stagePayer({ requires_prior_auth_dme: true });
    stageSupabaseResponse("sleep_studies", "select", {
      data: { diagnosis_icd10: "G47.33" },
    });
    stageSupabaseResponse("patients", "select", {
      data: {
        address: { line1: "100 Main", city: "X", state: "PA", zip: "16801" },
      },
    });
    stageSupabaseResponse("insurance_claim_line_items", "select", {
      data: [
        {
          hcpcs_code: "E0601",
          modifier: "RR,KX",
          billed_cents: 24999,
          quantity: 1,
        },
      ],
    });
    // prior_authorizations lookup returns no rows.
    stageSupabaseResponse("prior_authorizations", "select", { data: [] });
    const r = await scoreClaim(CLAIM_ID);
    expect(r!.probability).toBeGreaterThan(0.3);
    expect(
      r!.factors.some((f) => f.key === "missing_prior_auth_required"),
    ).toBe(true);
  });

  it("flags missing referring provider on Medicare-like LOB", async () => {
    stageClaim({ referring_provider_id: null });
    stagePayer({ line_of_business: "medicare_part_b" });
    stageSupabaseResponse("sleep_studies", "select", {
      data: { diagnosis_icd10: "G47.33" },
    });
    stageSupabaseResponse("patients", "select", {
      data: {
        address: { line1: "X", city: "Y", state: "PA", zip: "16801" },
      },
    });
    stageSupabaseResponse("insurance_claim_line_items", "select", {
      data: [
        {
          hcpcs_code: "E0601",
          modifier: "RR",
          billed_cents: 24999,
          quantity: 1,
        },
      ],
    });
    const r = await scoreClaim(CLAIM_ID);
    expect(
      r!.factors.some((f) => f.key === "missing_referring_provider_medicare"),
    ).toBe(true);
  });

  it("flags PAP-without-OSA-diagnosis mismatch", async () => {
    stageClaim();
    stagePayer();
    stageSupabaseResponse("sleep_studies", "select", {
      data: { diagnosis_icd10: "J44.9" }, // COPD, not OSA
    });
    stageSupabaseResponse("patients", "select", {
      data: {
        address: { line1: "X", city: "Y", state: "PA", zip: "16801" },
      },
    });
    stageSupabaseResponse("insurance_claim_line_items", "select", {
      data: [
        {
          hcpcs_code: "E0601",
          modifier: "RR",
          billed_cents: 24999,
          quantity: 1,
        },
      ],
    });
    const r = await scoreClaim(CLAIM_ID);
    expect(r!.factors.some((f) => f.key === "pap_without_osa_diagnosis")).toBe(
      true,
    );
  });

  it("never exceeds 0.95 even with every factor stacked", async () => {
    stageClaim({ payer_profile_id: null, referring_provider_id: null });
    stageSupabaseResponse("sleep_studies", "select", { data: null });
    stageSupabaseResponse("patients", "select", { data: { address: null } });
    stageSupabaseResponse("insurance_claim_line_items", "select", { data: [] });
    const r = await scoreClaim(CLAIM_ID);
    expect(r!.probability).toBeLessThanOrEqual(0.95);
    expect(r!.probability).toBeGreaterThan(0.5);
  });
});

// ---------------------------------------------------------------------------
// Fee-schedule date filtering (new in this PR)
// ---------------------------------------------------------------------------
// Before this PR the fee schedule lookup used only `.eq("payer_profile_id",
// ...).eq("hcpcs_code", ...)` — no date guards. That meant a future-dated
// or already-expired fee row could be selected and used to weight the
// predicted-denial score, producing incorrect risk estimates.
//
// The PR adds `.lte("effective_from", onDate)` and
// `.or("effective_through.is.null,effective_through.gte.<onDate>")` so
// only a row effective on the date of service can be returned.
//
// These tests verify the filter calls by inspecting `supabaseMock.filterCalls`.

describe("scoreClaim — fee-schedule date filtering (payer_fee_schedules)", () => {
  // Reset the mock between tests in this block too — without it the
  // per-(table,op) callCount accumulates across tests, so the
  // "never queried" assertion below saw 5 instead of 0.
  beforeEach(() => supabaseMock.reset());

  it("applies lte(effective_from) with the claim date_of_service", async () => {
    stageClaim({ date_of_service: "2026-05-12" });
    stagePayer();
    stageSupabaseResponse("sleep_studies", "select", {
      data: { diagnosis_icd10: "G47.33" },
    });
    stageSupabaseResponse("patients", "select", {
      data: {
        address: {
          line1: "1 Main",
          city: "Pittsburgh",
          state: "PA",
          zip: "15201",
        },
      },
    });
    stageSupabaseResponse("insurance_claim_line_items", "select", {
      data: [
        {
          hcpcs_code: "E0601",
          modifier: "RR,KX",
          billed_cents: 24999,
          quantity: 1,
        },
      ],
    });
    // Stage the fee schedule lookup
    stageSupabaseResponse("payer_fee_schedules", "select", {
      data: { allowed_cents: 20000 },
    });

    await scoreClaim(CLAIM_ID);

    const filters = supabaseMock.filterCalls("payer_fee_schedules", "select");
    const lteCall = filters.find((f) => f.verb === "lte");
    expect(lteCall).toBeDefined();
    expect(lteCall!.args[0]).toBe("effective_from");
    expect(lteCall!.args[1]).toBe("2026-05-12");
  });

  it("applies or(effective_through) with the claim date_of_service", async () => {
    stageClaim({ date_of_service: "2026-05-12" });
    stagePayer();
    stageSupabaseResponse("sleep_studies", "select", {
      data: { diagnosis_icd10: "G47.33" },
    });
    stageSupabaseResponse("patients", "select", {
      data: {
        address: {
          line1: "1 Main",
          city: "Pittsburgh",
          state: "PA",
          zip: "15201",
        },
      },
    });
    stageSupabaseResponse("insurance_claim_line_items", "select", {
      data: [
        {
          hcpcs_code: "E0601",
          modifier: "RR,KX",
          billed_cents: 24999,
          quantity: 1,
        },
      ],
    });
    stageSupabaseResponse("payer_fee_schedules", "select", {
      data: { allowed_cents: 20000 },
    });

    await scoreClaim(CLAIM_ID);

    const filters = supabaseMock.filterCalls("payer_fee_schedules", "select");
    const orCall = filters.find((f) => f.verb === "or");
    expect(orCall).toBeDefined();
    expect(orCall!.args[0] as string).toContain("effective_through.is.null");
    expect(orCall!.args[0] as string).toContain("2026-05-12");
  });

  it("uses today's date as the fallback when claim has no date_of_service", async () => {
    stageClaim({ date_of_service: null });
    stagePayer();
    stageSupabaseResponse("sleep_studies", "select", {
      data: { diagnosis_icd10: "G47.33" },
    });
    stageSupabaseResponse("patients", "select", {
      data: {
        address: {
          line1: "1 Main",
          city: "Pittsburgh",
          state: "PA",
          zip: "15201",
        },
      },
    });
    stageSupabaseResponse("insurance_claim_line_items", "select", {
      data: [
        {
          hcpcs_code: "E0601",
          modifier: "RR,KX",
          billed_cents: 24999,
          quantity: 1,
        },
      ],
    });
    stageSupabaseResponse("payer_fee_schedules", "select", {
      data: { allowed_cents: 20000 },
    });

    await scoreClaim(CLAIM_ID);

    const filters = supabaseMock.filterCalls("payer_fee_schedules", "select");
    const lteCall = filters.find((f) => f.verb === "lte");
    expect(lteCall).toBeDefined();
    // The fallback is today's date (YYYY-MM-DD). We can't assert the exact
    // value without freezing time, but we can confirm it is a valid date string.
    expect(lteCall!.args[1] as string).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it("flags billed_over_fee_schedule_2x when billed_cents > 2x allowed_cents on the DOS fee row", async () => {
    // Billed: 50000 ($500), allowed: 20000 ($200) → 2x threshold = 40000.
    stageClaim({ date_of_service: "2026-05-12" });
    stagePayer();
    stageSupabaseResponse("sleep_studies", "select", {
      data: { diagnosis_icd10: "G47.33" },
    });
    stageSupabaseResponse("patients", "select", {
      data: {
        address: {
          line1: "1 Main",
          city: "Pittsburgh",
          state: "PA",
          zip: "15201",
        },
      },
    });
    stageSupabaseResponse("insurance_claim_line_items", "select", {
      data: [
        {
          hcpcs_code: "E0601",
          modifier: "RR,KX",
          billed_cents: 50000,
          quantity: 1,
        },
      ],
    });
    stageSupabaseResponse("payer_fee_schedules", "select", {
      data: { allowed_cents: 20000 },
    });

    const r = await scoreClaim(CLAIM_ID);
    expect(
      r!.factors.some((f) => f.key === "billed_over_fee_schedule_2x"),
    ).toBe(true);
  });

  it("does NOT flag billed_over_fee_schedule_2x when billed_cents ≤ 2x allowed_cents", async () => {
    // Billed: 30000, allowed: 20000 → 2x threshold = 40000, so no flag.
    stageClaim({ date_of_service: "2026-05-12" });
    stagePayer();
    stageSupabaseResponse("sleep_studies", "select", {
      data: { diagnosis_icd10: "G47.33" },
    });
    stageSupabaseResponse("patients", "select", {
      data: {
        address: {
          line1: "1 Main",
          city: "Pittsburgh",
          state: "PA",
          zip: "15201",
        },
      },
    });
    stageSupabaseResponse("insurance_claim_line_items", "select", {
      data: [
        {
          hcpcs_code: "E0601",
          modifier: "RR,KX",
          billed_cents: 30000,
          quantity: 1,
        },
      ],
    });
    stageSupabaseResponse("payer_fee_schedules", "select", {
      data: { allowed_cents: 20000 },
    });

    const r = await scoreClaim(CLAIM_ID);
    expect(
      r!.factors.some((f) => f.key === "billed_over_fee_schedule_2x"),
    ).toBe(false);
  });

  it("skips the fee schedule lookup entirely when claim has no payer_profile_id", async () => {
    stageClaim({ payer_profile_id: null });
    stageSupabaseResponse("sleep_studies", "select", {
      data: { diagnosis_icd10: "G47.33" },
    });
    stageSupabaseResponse("patients", "select", {
      data: {
        address: {
          line1: "1 Main",
          city: "Pittsburgh",
          state: "PA",
          zip: "15201",
        },
      },
    });
    stageSupabaseResponse("insurance_claim_line_items", "select", {
      data: [
        {
          hcpcs_code: "E0601",
          modifier: "RR",
          billed_cents: 24999,
          quantity: 1,
        },
      ],
    });

    await scoreClaim(CLAIM_ID);

    // payer_fee_schedules should never be queried
    expect(supabaseMock.callCount("payer_fee_schedules", "select")).toBe(0);
  });
});
