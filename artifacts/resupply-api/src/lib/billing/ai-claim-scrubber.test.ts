// Tests for the AI scrubber. We mock the supabase client + the
// fetch call so the run is hermetic. The scrubber's job is to
// assemble a PHI-safe context, call OpenAI, parse the JSON response
// into the structured output shape, and degrade gracefully on
// failure. We exercise each of those.

import { describe, expect, it, beforeEach, vi } from "vitest";

import {
  installSupabaseMock,
  stageSupabaseResponse,
} from "../../test-helpers/supabase-mock";

const supabaseMock = installSupabaseMock();

import { scrubClaim } from "./ai-claim-scrubber";

const CLAIM_ID = "11111111-1111-4111-8111-111111111111";

function stageHappyContext(): void {
  // First insurance_claims select — context assembler
  stageSupabaseResponse("insurance_claims", "select", {
    data: {
      id: CLAIM_ID,
      patient_id: "22222222-2222-4222-8222-222222222222",
      payer_name: "Highmark BCBS",
      payer_profile_id: "33333333-3333-4333-8333-333333333333",
      date_of_service: "2026-05-12",
      status: "draft",
      total_billed_cents: 24999,
      insurance_coverage_id: "44444444-4444-4444-8444-444444444444",
      fulfillment_id: null,
      notes: null,
    },
  });
  // Second insurance_claims select — preflightClaim()
  stageSupabaseResponse("insurance_claims", "select", {
    data: {
      id: CLAIM_ID,
      patient_id: "22222222-2222-4222-8222-222222222222",
      payer_name: "Highmark BCBS",
      payer_profile_id: "33333333-3333-4333-8333-333333333333",
      date_of_service: "2026-05-12",
      status: "draft",
      total_billed_cents: 24999,
      insurance_coverage_id: "44444444-4444-4444-8444-444444444444",
      rendering_provider_id: "55555555-5555-4555-8555-555555555555",
      referring_provider_id: "55555555-5555-4555-8555-555555555555",
      secondary_coverage_id: null,
      fulfillment_id: null,
    },
  });
  // patients select (context)
  stageSupabaseResponse("patients", "select", {
    data: {
      legal_first_name: "JANE",
      legal_last_name: "DOE",
      date_of_birth: "1965-04-12",
    },
  });
  // insurance_coverages select
  stageSupabaseResponse("insurance_coverages", "select", {
    data: {
      member_id: "M123456789",
      plan_name: "PPO",
      in_network: true,
      capped_rental_status: "rental_month_4_to_13",
    },
  });
  // line items
  stageSupabaseResponse("insurance_claim_line_items", "select", {
    data: [
      {
        id: "lll",
        hcpcs_code: "E0601",
        modifier: "RR",
        description: "CPAP",
        quantity: 1,
        billed_cents: 24999,
      },
    ],
  });
  // payer profile
  stageSupabaseResponse("payer_profiles", "select", {
    data: {
      display_name: "Highmark BCBS",
      line_of_business: "commercial",
      region: "pa",
      requires_prior_auth_dme: true,
      claim_format: "837p",
    },
  });
  // sleep study
  stageSupabaseResponse("sleep_studies", "select", {
    data: { diagnosis_icd10: "G47.33", study_date: "2025-12-01" },
  });
  // prior_authorizations (list)
  stageSupabaseResponse("prior_authorizations", "select", { data: [] });
  // Now preflight() fires another sequence — it runs its own checks.
  // It will issue several more reads; the mock returns empty success
  // for anything not staged so those run as "nothing on file" which
  // the preflight surfaces as warning/error items.
  stageSupabaseResponse("patients", "select", {
    data: {
      legal_first_name: "JANE",
      legal_last_name: "DOE",
      date_of_birth: "1965-04-12",
      address: {
        line1: "100 Main",
        city: "State College",
        state: "PA",
        zip: "16801",
      },
    },
  });
  stageSupabaseResponse("sleep_studies", "select", {
    data: { diagnosis_icd10: "G47.33", study_date: "2025-12-01" },
  });
  stageSupabaseResponse("insurance_claim_line_items", "select", {
    data: [
      {
        id: "lll",
        hcpcs_code: "E0601",
        modifier: "RR",
        billed_cents: 24999,
        quantity: 1,
      },
    ],
  });
  stageSupabaseResponse("payer_profiles", "select", {
    data: {
      requires_prior_auth_dme: true,
      display_name: "Highmark BCBS",
    },
  });
  stageSupabaseResponse("prior_authorizations", "select", { data: [] });
}

describe("scrubClaim", () => {
  beforeEach(() => {
    supabaseMock.reset();
  });

  it("returns errored verdict when OPENAI_API_KEY is missing", async () => {
    const r = await scrubClaim({ claimId: CLAIM_ID });
    expect(r.verdict).toBe("errored");
    expect(r.errorMessage).toMatch(/OPENAI_API_KEY/);
  });

  it("returns errored verdict when the claim does not exist", async () => {
    stageSupabaseResponse("insurance_claims", "select", { data: null });
    const fetchImpl = vi.fn();
    const r = await scrubClaim({
      claimId: CLAIM_ID,
      apiKey: "sk-test",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(r.verdict).toBe("errored");
    expect(r.errorMessage).toMatch(/claim not found/);
    // Should never have called OpenAI for a missing claim.
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("parses a happy-path model response into structured output", async () => {
    stageHappyContext();
    const modelOutput = {
      verdict: "fixable",
      confidence: 0.92,
      summary: "Missing KX on a continuing-rental month.",
      findings: [
        {
          key: "missing_kx_continuing",
          severity: "error",
          problem: "E0601 in continuing rental cycle requires KX",
          recommended_fix: "Append KX to the modifier list",
        },
      ],
      suggested_patches: [
        {
          kind: "set_line_modifier",
          hcpcsCode: "E0601",
          modifierCsv: "RR,KX",
          rationale: "Continuing rental + compliance proven",
        },
      ],
    };
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        choices: [{ message: { content: JSON.stringify(modelOutput) } }],
        usage: { prompt_tokens: 1200, completion_tokens: 200 },
      }),
    });
    const r = await scrubClaim({
      claimId: CLAIM_ID,
      apiKey: "sk-test",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(r.verdict).toBe("fixable");
    expect(r.confidence).toBe(0.92);
    expect(r.findings).toHaveLength(1);
    expect(r.findings[0]!.key).toBe("missing_kx_continuing");
    expect(r.suggestedPatches).toHaveLength(1);
    expect(r.suggestedPatches[0]).toMatchObject({
      kind: "set_line_modifier",
      hcpcsCode: "E0601",
    });
    expect(r.promptTokens).toBe(1200);
    expect(r.completionTokens).toBe(200);
  });

  it("never sends PHI (full name, full DOB, address, full member id)", async () => {
    stageHappyContext();
    const capturedBodies: string[] = [];
    const fetchImpl = vi
      .fn()
      .mockImplementation(async (_url: string, init: RequestInit) => {
        capturedBodies.push(typeof init.body === "string" ? init.body : "");
        return {
          ok: true,
          json: async () => ({
            choices: [
              {
                message: {
                  content: JSON.stringify({
                    verdict: "ready",
                    confidence: 1,
                    summary: "ok",
                    findings: [],
                    suggested_patches: [],
                  }),
                },
              },
            ],
          }),
        };
      });
    await scrubClaim({
      claimId: CLAIM_ID,
      apiKey: "sk-test",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const body = capturedBodies[0] ?? "";
    // Patient name JANE / DOE must NOT appear; initials JD only.
    // The body is JSON-in-JSON so inner quotes are backslash-escaped;
    // we match on the bare token instead.
    expect(body).not.toContain("JANE");
    expect(body).not.toContain("DOE");
    expect(body).toMatch(/initials.*JD/);
    // Full DOB must NOT appear; only the year.
    expect(body).not.toContain("1965-04-12");
    expect(body).toMatch(/dobYear.*1965/);
    // Full member id must NOT appear; only a fingerprint.
    expect(body).not.toContain("M123456789");
    expect(body).toMatch(/memberIdFingerprint.*len=10,end=89/);
  });

  it("collapses model JSON parse failure to errored verdict", async () => {
    stageHappyContext();
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        choices: [{ message: { content: "not json at all" } }],
      }),
    });
    const r = await scrubClaim({
      claimId: CLAIM_ID,
      apiKey: "sk-test",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(r.verdict).toBe("errored");
  });

  it("propagates OpenAI HTTP errors as errored verdict", async () => {
    stageHappyContext();
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: false,
      status: 503,
      text: async () => "service unavailable",
    });
    const r = await scrubClaim({
      claimId: CLAIM_ID,
      apiKey: "sk-test",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(r.verdict).toBe("errored");
    expect(r.errorMessage).toMatch(/503/);
  });

  it("drops unsafe patches the model invents", async () => {
    stageHappyContext();
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        choices: [
          {
            message: {
              content: JSON.stringify({
                verdict: "fixable",
                confidence: 0.8,
                summary: "x",
                findings: [],
                suggested_patches: [
                  { kind: "set_patient_name", value: "EVIL" },
                  { kind: "drop_claim", target: "*" },
                  { kind: "add_diagnosis", icd10: "G47.33" },
                ],
              }),
            },
          },
        ],
      }),
    });
    const r = await scrubClaim({
      claimId: CLAIM_ID,
      apiKey: "sk-test",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(r.suggestedPatches).toHaveLength(1);
    expect(r.suggestedPatches[0]!.kind).toBe("add_diagnosis");
    expect(r.droppedPatches).toHaveLength(2);
  });
});
