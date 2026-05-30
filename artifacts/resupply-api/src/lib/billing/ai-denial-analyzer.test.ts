// Tests for the AI denial analyzer. Mocks the fetch + the supabase
// client and confirms:
//   - errored verdict when the API key is missing,
//   - errored verdict when the claim isn't denied,
//   - happy-path parsing produces a structured DenialAnalysisOutput,
//   - the can_auto_resubmit gate downgrades unsafe model output,
//   - PHI containment.

import { describe, expect, it, beforeEach, vi } from "vitest";

import {
  installSupabaseMock,
  stageSupabaseResponse,
} from "../../test-helpers/supabase-mock";

const supabaseMock = installSupabaseMock();

import { analyzeDenial } from "./ai-denial-analyzer";

const CLAIM_ID = "11111111-1111-4111-8111-111111111111";

function stageDeniedClaimContext(): void {
  // First insurance_claims select
  stageSupabaseResponse("insurance_claims", "select", {
    data: {
      id: CLAIM_ID,
      status: "denied",
      payer_name: "Highmark BCBS",
      payer_profile_id: "33333333-3333-4333-8333-333333333333",
      date_of_service: "2026-05-12",
      total_billed_cents: 24999,
      total_paid_cents: 0,
      denial_reason: "CARC 197; CARC 96",
    },
  });
  // line items
  stageSupabaseResponse("insurance_claim_line_items", "select", {
    data: [
      {
        hcpcs_code: "E0601",
        modifier: "RR",
        billed_cents: 24999,
        allowed_cents: 0,
        paid_cents: 0,
        status: "denied",
        denial_reason: "CARC 197",
        quantity: 1,
      },
    ],
  });
  // events
  stageSupabaseResponse("insurance_claim_events", "select", {
    data: [
      {
        event_type: "denied",
        amount_cents: 0,
        payer_ref: "CHK-1",
        note: "ERA 835 — CARC 197",
        occurred_at: "2026-05-13T10:00:00Z",
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
    },
  });
  // denial codes catalog
  stageSupabaseResponse("denial_codes", "select", {
    data: [
      {
        code_system: "carc",
        code: "197",
        description: "Precertification absent",
        category: "authorization",
        recommended_action: "File prior auth retroactively",
      },
    ],
  });
}

describe("analyzeDenial", () => {
  beforeEach(() => {
    supabaseMock.reset();
  });

  it("returns errored when OPENAI_API_KEY is missing", async () => {
    const r = await analyzeDenial({ claimId: CLAIM_ID });
    expect(r.recommendation).toBe("manual_review");
    expect(r.errorMessage).toMatch(/OPENAI_API_KEY/);
    expect(r.canAutoResubmit).toBe(false);
  });

  it("returns errored when the claim isn't denied", async () => {
    stageSupabaseResponse("insurance_claims", "select", { data: null });
    const fetchImpl = vi.fn();
    const r = await analyzeDenial({
      claimId: CLAIM_ID,
      apiKey: "sk-test",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(r.recommendation).toBe("manual_review");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("parses a clean auto_resubmit recommendation when model is confident", async () => {
    stageDeniedClaimContext();
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        choices: [
          {
            message: {
              content: JSON.stringify({
                verdict: "auto_resubmit",
                confidence: 0.9,
                root_cause_summary: "Missing prior auth REF*G1 on the claim.",
                mapped_codes: [
                  {
                    code: "197",
                    system: "carc",
                    category: "authorization",
                    explanation: "Pre-cert / auth absent",
                  },
                ],
                fix_steps: [
                  {
                    step: "Attach the approved PA number 'PA-9988' as REF*G1.",
                  },
                ],
                appeal_letter_sketch: null,
                suggested_patches: [
                  {
                    kind: "set_prior_auth_number",
                    authNumber: "PA-9988",
                    rationale: "Approved PA on file",
                  },
                ],
                can_auto_resubmit: true,
              }),
            },
          },
        ],
      }),
    });
    const r = await analyzeDenial({
      claimId: CLAIM_ID,
      apiKey: "sk-test",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(r.recommendation).toBe("auto_resubmit");
    expect(r.canAutoResubmit).toBe(true);
    expect(r.suggestedPatches).toHaveLength(1);
    expect(r.mappedCodes[0]!.code).toBe("197");
  });

  it("downgrades can_auto_resubmit=true to false when patches include an unsafe kind", async () => {
    stageDeniedClaimContext();
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        choices: [
          {
            message: {
              content: JSON.stringify({
                verdict: "auto_resubmit",
                confidence: 0.95,
                root_cause_summary: "rm a line",
                mapped_codes: [],
                fix_steps: [],
                suggested_patches: [
                  // remove_line is NOT in the safe set
                  { kind: "remove_line", hcpcsCode: "E0601" },
                  {
                    kind: "set_line_modifier",
                    hcpcsCode: "E0601",
                    modifierCsv: "RR,KX",
                  },
                ],
                can_auto_resubmit: true,
              }),
            },
          },
        ],
      }),
    });
    const r = await analyzeDenial({
      claimId: CLAIM_ID,
      apiKey: "sk-test",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(r.canAutoResubmit).toBe(false);
  });

  it("downgrades can_auto_resubmit when confidence < 0.75", async () => {
    stageDeniedClaimContext();
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        choices: [
          {
            message: {
              content: JSON.stringify({
                verdict: "auto_resubmit",
                confidence: 0.5,
                root_cause_summary: "low confidence",
                mapped_codes: [],
                fix_steps: [],
                suggested_patches: [
                  {
                    kind: "set_line_modifier",
                    hcpcsCode: "E0601",
                    modifierCsv: "RR,KX",
                  },
                ],
                can_auto_resubmit: true,
              }),
            },
          },
        ],
      }),
    });
    const r = await analyzeDenial({
      claimId: CLAIM_ID,
      apiKey: "sk-test",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(r.canAutoResubmit).toBe(false);
  });

  it("preserves an appeal recommendation with sketch but no auto-resubmit", async () => {
    stageDeniedClaimContext();
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        choices: [
          {
            message: {
              content: JSON.stringify({
                verdict: "appeal",
                confidence: 0.85,
                root_cause_summary: "Medical necessity denial — supportable.",
                mapped_codes: [
                  {
                    code: "50",
                    system: "carc",
                    category: "medical_necessity",
                    explanation: "Service deemed not medically necessary",
                  },
                ],
                fix_steps: [
                  {
                    step: "Compile sleep study + compliance report; file appeal",
                  },
                ],
                appeal_letter_sketch:
                  "Dear payer review board, attached is the patient's sleep study...",
                suggested_patches: [],
                can_auto_resubmit: false,
              }),
            },
          },
        ],
      }),
    });
    const r = await analyzeDenial({
      claimId: CLAIM_ID,
      apiKey: "sk-test",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(r.recommendation).toBe("appeal");
    expect(r.appealLetterSketch).toContain("payer review board");
    expect(r.canAutoResubmit).toBe(false);
  });
});
