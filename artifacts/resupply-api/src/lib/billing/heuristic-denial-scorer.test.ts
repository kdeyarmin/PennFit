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
        { hcpcs_code: "E0601", modifier: "RR,KX", billed_cents: 24999, quantity: 1 },
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
        { hcpcs_code: "E0601", modifier: "RR,KX", billed_cents: 24999, quantity: 1 },
      ],
    });
    // prior_authorizations lookup returns no rows.
    stageSupabaseResponse("prior_authorizations", "select", { data: [] });
    const r = await scoreClaim(CLAIM_ID);
    expect(r!.probability).toBeGreaterThan(0.3);
    expect(r!.factors.some((f) => f.key === "missing_prior_auth_required")).toBe(
      true,
    );
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
      data: [{ hcpcs_code: "E0601", modifier: "RR", billed_cents: 24999, quantity: 1 }],
    });
    const r = await scoreClaim(CLAIM_ID);
    expect(r!.factors.some((f) => f.key === "missing_referring_provider_medicare")).toBe(
      true,
    );
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
      data: [{ hcpcs_code: "E0601", modifier: "RR", billed_cents: 24999, quantity: 1 }],
    });
    const r = await scoreClaim(CLAIM_ID);
    expect(
      r!.factors.some((f) => f.key === "pap_without_osa_diagnosis"),
    ).toBe(true);
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
