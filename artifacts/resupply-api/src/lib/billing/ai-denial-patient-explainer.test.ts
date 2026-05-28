// Tests for the patient-facing denial explainer.
//
// Coverage:
//   * Returns errored shape with safe defaults when OPENAI_API_KEY unset
//   * Returns errored when claim is missing
//   * Returns errored when claim status is not denied
//   * Returns errored on upstream HTTP error (>= 400)
//   * Parses well-formed JSON into the typed output
//   * Falls back to safe defaults when content is not JSON
//   * Truncates over-long subject/body
//   * Maps unknown tone values to 'informational'

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

import {
  installSupabaseMock,
  stageSupabaseResponse,
} from "../../test-helpers/supabase-mock";

const supabaseMock = installSupabaseMock();

import { explainDenialToPatient } from "./ai-denial-patient-explainer";

const originalKey = process.env.OPENAI_API_KEY;

beforeEach(() => {
  supabaseMock.reset();
  delete process.env.OPENAI_API_KEY;
});

afterEach(() => {
  if (originalKey === undefined) {
    delete process.env.OPENAI_API_KEY;
  } else {
    process.env.OPENAI_API_KEY = originalKey;
  }
});

describe("explainDenialToPatient", () => {
  it("returns errored fallback when OPENAI_API_KEY is unset", async () => {
    const result = await explainDenialToPatient({ claimId: "claim_1" });
    expect(result.errorMessage).toContain("OPENAI_API_KEY");
    expect(result.subject).toContain("recent insurance claim");
    expect(result.tone).toBe("informational");
    expect(result.latencyMs).toBeNull();
  });

  it("returns errored when claim is not found", async () => {
    process.env.OPENAI_API_KEY = "sk-test";
    stageSupabaseResponse("insurance_claims", "select", { data: null });
    const result = await explainDenialToPatient({ claimId: "missing" });
    expect(result.errorMessage).toMatch(/not found|not denied/);
  });

  it("returns errored when claim status is not 'denied'", async () => {
    process.env.OPENAI_API_KEY = "sk-test";
    stageSupabaseResponse("insurance_claims", "select", {
      data: {
        id: "claim_1",
        status: "paid",
        payer_name: "Acme",
        date_of_service: "2026-01-01",
        total_billed_cents: 50000,
        denial_reason: null,
      },
    });
    const result = await explainDenialToPatient({ claimId: "claim_1" });
    expect(result.errorMessage).toMatch(/not denied/);
  });

  it("returns errored on upstream HTTP error", async () => {
    process.env.OPENAI_API_KEY = "sk-test";
    stageSupabaseResponse("insurance_claims", "select", {
      data: {
        id: "claim_1",
        status: "denied",
        payer_name: "Acme",
        date_of_service: "2026-01-01",
        total_billed_cents: 50000,
        denial_reason: "CO-50",
      },
    });
    stageSupabaseResponse("insurance_claim_line_items", "select", { data: [] });
    const fakeFetch = vi.fn(
      async () =>
        new Response("oops", { status: 500, statusText: "Server Error" }),
    );
    const result = await explainDenialToPatient({
      claimId: "claim_1",
      fetchImpl: fakeFetch as unknown as typeof fetch,
    });
    expect(result.errorMessage).toMatch(/openai http 500/);
  });

  it("parses well-formed JSON into the typed output", async () => {
    process.env.OPENAI_API_KEY = "sk-test";
    stageSupabaseResponse("insurance_claims", "select", {
      data: {
        id: "claim_1",
        status: "denied",
        payer_name: "Acme",
        date_of_service: "2026-01-01",
        total_billed_cents: 50000,
        denial_reason: "CO-50",
      },
    });
    stageSupabaseResponse("insurance_claim_line_items", "select", { data: [] });
    const okBody = JSON.stringify({
      choices: [
        {
          message: {
            content: JSON.stringify({
              subject: "About your recent claim",
              body: "Your insurance asked for one more form. We'll handle it.",
              tone: "action_required",
            }),
          },
        },
      ],
      usage: { prompt_tokens: 100, completion_tokens: 50 },
    });
    const fakeFetch = vi.fn(async () => new Response(okBody, { status: 200 }));
    const result = await explainDenialToPatient({
      claimId: "claim_1",
      fetchImpl: fakeFetch as unknown as typeof fetch,
    });
    expect(result.errorMessage).toBeNull();
    expect(result.subject).toBe("About your recent claim");
    expect(result.tone).toBe("action_required");
    expect(result.promptTokens).toBe(100);
    expect(result.completionTokens).toBe(50);
  });

  it("falls back to safe defaults when content is not JSON", async () => {
    process.env.OPENAI_API_KEY = "sk-test";
    stageSupabaseResponse("insurance_claims", "select", {
      data: {
        id: "claim_1",
        status: "denied",
        payer_name: "Acme",
        date_of_service: "2026-01-01",
        total_billed_cents: 50000,
        denial_reason: "CO-50",
      },
    });
    stageSupabaseResponse("insurance_claim_line_items", "select", { data: [] });
    const body = JSON.stringify({
      choices: [{ message: { content: "not json at all" } }],
    });
    const fakeFetch = vi.fn(async () => new Response(body, { status: 200 }));
    const result = await explainDenialToPatient({
      claimId: "claim_1",
      fetchImpl: fakeFetch as unknown as typeof fetch,
    });
    expect(result.subject).toContain("recent insurance claim");
    expect(result.tone).toBe("informational");
  });

  it("maps unknown tone values to 'informational'", async () => {
    process.env.OPENAI_API_KEY = "sk-test";
    stageSupabaseResponse("insurance_claims", "select", {
      data: {
        id: "claim_1",
        status: "denied",
        payer_name: "Acme",
        date_of_service: "2026-01-01",
        total_billed_cents: 50000,
        denial_reason: "CO-50",
      },
    });
    stageSupabaseResponse("insurance_claim_line_items", "select", { data: [] });
    const body = JSON.stringify({
      choices: [
        {
          message: {
            content: JSON.stringify({
              subject: "x",
              body: "y",
              tone: "made_up_tone",
            }),
          },
        },
      ],
    });
    const fakeFetch = vi.fn(async () => new Response(body, { status: 200 }));
    const result = await explainDenialToPatient({
      claimId: "claim_1",
      fetchImpl: fakeFetch as unknown as typeof fetch,
    });
    expect(result.tone).toBe("informational");
  });
});
