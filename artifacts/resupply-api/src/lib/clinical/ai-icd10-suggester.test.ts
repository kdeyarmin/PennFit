// Tests for lib/clinical/ai-icd10-suggester.ts
//
// PR change (May 2026): provider selection dispatched through
// `selectLlmProvider()` — Anthropic-first, OpenAI fallback. Previously
// the suggester hard-coded OpenAI; callers that passed an explicit
// `input.apiKey` still force the OpenAI path.
//
// Test strategy:
//   - `installSupabaseMock` stubs the Supabase client so we never hit
//     a real PostgREST server.
//   - `../llm-provider` is vi.mock'd to control `selectLlmProvider` and
//     `getAnthropicClient` per-test. vi.hoisted() ensures the mock fns
//     are available when the factory runs (required by Vitest ESM hoisting).
//   - `@workspace/resupply-ai` is vi.mock'd to control `sendWithRetry`
//     and `getResponseText` without real network calls.
//   - The OpenAI path is exercised via `input.fetchImpl` injection
//     (same seam used by the pre-existing scrubber tests).

import { beforeEach, describe, expect, it, vi } from "vitest";

// ── Supabase mock — must be installed before importing the module under test ─

import {
  installSupabaseMock,
  stageSupabaseResponse,
} from "../../test-helpers/supabase-mock";

const supabaseMock = installSupabaseMock();

// ── Hoisted mock functions ────────────────────────────────────────────────
// vi.hoisted() runs before any import-resolution happens so that the
// vi.fn() references are valid when the vi.mock() factory functions below
// are executed by Vitest.

const mockSelectLlmProvider = vi.hoisted(() => vi.fn());
const mockGetAnthropicClient = vi.hoisted(() => vi.fn());
const mockSendWithRetry = vi.hoisted(() => vi.fn());
const mockGetResponseText = vi.hoisted(() => vi.fn());

// ── Module-level vi.mock calls — Vitest hoists these ──────────────────────

vi.mock("../logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock("../llm-provider", () => ({
  selectLlmProvider: mockSelectLlmProvider,
  getAnthropicClient: mockGetAnthropicClient,
}));

vi.mock("@workspace/resupply-ai", () => ({
  sendWithRetry: mockSendWithRetry,
  getResponseText: mockGetResponseText,
}));

// ── Import the module under test (after all mocks are in place) ────────────

import { suggestIcd10 } from "./ai-icd10-suggester";

// ── Shared fixtures ────────────────────────────────────────────────────────

const STUDY_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

/** Minimal valid sleep_studies row returned by Supabase. */
function stageSleepStudy(overrides: Record<string, unknown> = {}): void {
  stageSupabaseResponse("sleep_studies", "select", {
    data: {
      id: STUDY_ID,
      study_type: "psg",
      ahi: "18.5",
      rdi: "20.0",
      lowest_spo2_pct: 88,
      sleep_efficiency_pct: 78,
      source: "lab_fax",
      ...overrides,
    },
  });
}

/** OpenAI-shaped JSON response for a successful ICD-10 suggestion. */
function openAiIcd10Response(
  icd10: string,
  confidence: number,
  rationale: string,
): Response {
  return new Response(
    JSON.stringify({
      choices: [
        {
          message: {
            content: JSON.stringify({ icd10, confidence, rationale }),
          },
        },
      ],
      usage: { prompt_tokens: 80, completion_tokens: 40 },
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

/** Anthropic-shaped result returned by the mocked `sendWithRetry`. */
function anthropicOkResult(text: string) {
  return {
    ok: true as const,
    latencyMs: 100,
    cacheHitTokens: 0,
    response: {
      id: "msg_test",
      type: "message",
      role: "assistant",
      model: "claude-haiku-4-5-20251001",
      content: [{ type: "text", text }],
      stop_reason: "end_turn",
      usage: { input_tokens: 50, output_tokens: 30 },
    },
  };
}

// ---------------------------------------------------------------------------
// Setup — reset supabase mock and module-level vi.fn() state before each test
// ---------------------------------------------------------------------------

beforeEach(() => {
  supabaseMock.reset();
  mockSelectLlmProvider.mockReset();
  mockGetAnthropicClient.mockReset();
  mockSendWithRetry.mockReset();
  mockGetResponseText.mockReset();
});

// ---------------------------------------------------------------------------
// Fail-fast: sleep study not found
// ---------------------------------------------------------------------------

describe("suggestIcd10 — sleep study not found", () => {
  it("returns errored when the sleep study row is missing", async () => {
    // Supabase returns { data: null } (unstaged → default)
    const result = await suggestIcd10({ sleepStudyId: STUDY_ID });
    expect(result.icd10).toBeNull();
    expect(result.errorMessage).toBe("sleep_study not found");
    expect(result.confidence).toBe(0);
    expect(result.inAllowlist).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Explicit apiKey → forces OpenAI path
// ---------------------------------------------------------------------------

describe("suggestIcd10 — explicit apiKey short-circuits to OpenAI", () => {
  it("calls the OpenAI endpoint and returns parsed output on success", async () => {
    stageSleepStudy();
    const result = await suggestIcd10({
      sleepStudyId: STUDY_ID,
      apiKey: "sk-explicit-key",
      fetchImpl: async () => openAiIcd10Response("G47.33", 0.95, "AHI >= 15, PSG study."),
    });
    // selectLlmProvider should NOT be called when apiKey is explicit
    expect(mockSelectLlmProvider).not.toHaveBeenCalled();
    expect(result.icd10).toBe("G47.33");
    expect(result.confidence).toBe(0.95);
    expect(result.inAllowlist).toBe(true);
    expect(result.errorMessage).toBeNull();
    expect(result.promptTokens).toBe(80);
    expect(result.completionTokens).toBe(40);
  });

  it("returns errored when the OpenAI endpoint returns an HTTP error", async () => {
    stageSleepStudy();
    const result = await suggestIcd10({
      sleepStudyId: STUDY_ID,
      apiKey: "sk-explicit-key",
      fetchImpl: async () => new Response("rate limited", { status: 429 }),
    });
    expect(result.icd10).toBeNull();
    expect(result.errorMessage).toMatch(/openai http 429/);
  });

  it("returns errored when fetch throws a transport error", async () => {
    stageSleepStudy();
    const result = await suggestIcd10({
      sleepStudyId: STUDY_ID,
      apiKey: "sk-explicit-key",
      fetchImpl: async () => { throw new TypeError("fetch failed"); },
    });
    expect(result.icd10).toBeNull();
    expect(result.errorMessage).toBe("fetch failed");
  });

  it("returns icd10=null when suggested code is not on the allowlist", async () => {
    stageSleepStudy();
    const result = await suggestIcd10({
      sleepStudyId: STUDY_ID,
      apiKey: "sk-explicit-key",
      // Z99.89 is not in LCD_L33718
      fetchImpl: async () => openAiIcd10Response("Z99.89", 0.5, "Other reason."),
    });
    expect(result.icd10).toBeNull();
    expect(result.inAllowlist).toBe(false);
    expect(result.confidence).toBe(0);
  });

  it("normalises icd10 code to uppercase and strips whitespace", async () => {
    stageSleepStudy();
    const result = await suggestIcd10({
      sleepStudyId: STUDY_ID,
      apiKey: "sk-explicit-key",
      fetchImpl: async () => openAiIcd10Response("g47.33", 0.9, "PSG study."),
    });
    expect(result.icd10).toBe("G47.33");
    expect(result.inAllowlist).toBe(true);
  });

  it("handles malformed JSON from the OpenAI model gracefully", async () => {
    stageSleepStudy();
    const result = await suggestIcd10({
      sleepStudyId: STUDY_ID,
      apiKey: "sk-explicit-key",
      fetchImpl: async () =>
        new Response(
          JSON.stringify({ choices: [{ message: { content: "not json" } }] }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
    });
    expect(result.icd10).toBeNull();
    expect(result.inAllowlist).toBe(false);
    expect(result.rationale).toBe("Model returned malformed JSON");
    expect(result.errorMessage).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Anthropic provider path
// ---------------------------------------------------------------------------

describe("suggestIcd10 — Anthropic provider path", () => {
  it("uses Anthropic when selectLlmProvider returns 'anthropic' and client is available", async () => {
    stageSleepStudy();

    const mockClient = { send: vi.fn(), stream: vi.fn() };
    mockSelectLlmProvider.mockReturnValue({ provider: "anthropic" });
    mockGetAnthropicClient.mockReturnValue(mockClient);

    const anthropicText = JSON.stringify({ icd10: "G47.33", confidence: 0.92, rationale: "AHI=18.5, PSG." });
    mockSendWithRetry.mockResolvedValue(anthropicOkResult(anthropicText));
    mockGetResponseText.mockReturnValue(anthropicText);

    const result = await suggestIcd10({ sleepStudyId: STUDY_ID });

    expect(mockSendWithRetry).toHaveBeenCalledOnce();
    expect(result.icd10).toBe("G47.33");
    expect(result.confidence).toBe(0.92);
    expect(result.inAllowlist).toBe(true);
    expect(result.errorMessage).toBeNull();
    expect(result.promptTokens).toBe(50);
    expect(result.completionTokens).toBe(30);
  });

  it("uses the DEFAULT_ANTHROPIC_MODEL when no model is supplied", async () => {
    stageSleepStudy();

    const mockClient = { send: vi.fn(), stream: vi.fn() };
    mockSelectLlmProvider.mockReturnValue({ provider: "anthropic" });
    mockGetAnthropicClient.mockReturnValue(mockClient);

    const anthropicText = JSON.stringify({ icd10: "G47.30", confidence: 0.7, rationale: "RDI>AHI." });
    mockSendWithRetry.mockResolvedValue(anthropicOkResult(anthropicText));
    mockGetResponseText.mockReturnValue(anthropicText);

    await suggestIcd10({ sleepStudyId: STUDY_ID });

    const callArg = mockSendWithRetry.mock.calls[0][1] as { model: string };
    expect(callArg.model).toBe("claude-haiku-4-5-20251001");
  });

  it("respects an explicit input.model override on the Anthropic path", async () => {
    stageSleepStudy();

    const mockClient = { send: vi.fn(), stream: vi.fn() };
    mockSelectLlmProvider.mockReturnValue({ provider: "anthropic" });
    mockGetAnthropicClient.mockReturnValue(mockClient);

    const anthropicText = JSON.stringify({ icd10: "G47.33", confidence: 0.88, rationale: "Custom model." });
    mockSendWithRetry.mockResolvedValue(anthropicOkResult(anthropicText));
    mockGetResponseText.mockReturnValue(anthropicText);

    await suggestIcd10({ sleepStudyId: STUDY_ID, model: "claude-opus-4-5" });

    const callArg = mockSendWithRetry.mock.calls[0][1] as { model: string };
    expect(callArg.model).toBe("claude-opus-4-5");
  });

  it("returns errored when sendWithRetry reports a failure", async () => {
    stageSleepStudy();

    const mockClient = { send: vi.fn(), stream: vi.fn() };
    mockSelectLlmProvider.mockReturnValue({ provider: "anthropic" });
    mockGetAnthropicClient.mockReturnValue(mockClient);

    mockSendWithRetry.mockResolvedValue({
      ok: false,
      errorCode: "rate_limit",
      httpStatus: 429,
    });

    const result = await suggestIcd10({ sleepStudyId: STUDY_ID });

    expect(result.icd10).toBeNull();
    expect(result.errorMessage).toMatch(/anthropic rate_limit/);
  });

  it("returns icd10=null when Anthropic suggests a non-allowlist code", async () => {
    stageSleepStudy();

    const mockClient = { send: vi.fn(), stream: vi.fn() };
    mockSelectLlmProvider.mockReturnValue({ provider: "anthropic" });
    mockGetAnthropicClient.mockReturnValue(mockClient);

    const anthropicText = JSON.stringify({ icd10: "Z99.89", confidence: 0.5, rationale: "Outside allowlist." });
    mockSendWithRetry.mockResolvedValue(anthropicOkResult(anthropicText));
    mockGetResponseText.mockReturnValue(anthropicText);

    const result = await suggestIcd10({ sleepStudyId: STUDY_ID });

    expect(result.icd10).toBeNull();
    expect(result.inAllowlist).toBe(false);
    expect(result.confidence).toBe(0);
  });

  it("sends a prompt-cached system block with cache_control: ephemeral", async () => {
    stageSleepStudy();

    const mockClient = { send: vi.fn(), stream: vi.fn() };
    mockSelectLlmProvider.mockReturnValue({ provider: "anthropic" });
    mockGetAnthropicClient.mockReturnValue(mockClient);

    const anthropicText = JSON.stringify({ icd10: "G47.33", confidence: 0.9, rationale: "OSA." });
    mockSendWithRetry.mockResolvedValue(anthropicOkResult(anthropicText));
    mockGetResponseText.mockReturnValue(anthropicText);

    await suggestIcd10({ sleepStudyId: STUDY_ID });

    const callArg = mockSendWithRetry.mock.calls[0][1] as {
      system: Array<{ type: string; text: string; cache_control: { type: string } }>;
    };
    expect(callArg.system).toHaveLength(1);
    expect(callArg.system[0].type).toBe("text");
    expect(callArg.system[0].cache_control).toEqual({ type: "ephemeral" });
  });

  it("passes temperature: 0 to the Anthropic call", async () => {
    stageSleepStudy();

    const mockClient = { send: vi.fn(), stream: vi.fn() };
    mockSelectLlmProvider.mockReturnValue({ provider: "anthropic" });
    mockGetAnthropicClient.mockReturnValue(mockClient);

    const anthropicText = JSON.stringify({ icd10: "G47.33", confidence: 0.9, rationale: "OSA." });
    mockSendWithRetry.mockResolvedValue(anthropicOkResult(anthropicText));
    mockGetResponseText.mockReturnValue(anthropicText);

    await suggestIcd10({ sleepStudyId: STUDY_ID });

    const callArg = mockSendWithRetry.mock.calls[0][1] as { temperature: number };
    expect(callArg.temperature).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Anthropic client null → fallback to OpenAI
// ---------------------------------------------------------------------------

describe("suggestIcd10 — Anthropic selected but client null → fallback to OpenAI", () => {
  it("falls through to OpenAI when getAnthropicClient returns null", async () => {
    stageSleepStudy();

    mockSelectLlmProvider.mockReturnValue({ provider: "anthropic" });
    mockGetAnthropicClient.mockReturnValue(null);

    const savedKey = process.env.OPENAI_API_KEY;
    process.env.OPENAI_API_KEY = "sk-openai-fallback";
    try {
      const result = await suggestIcd10({
        sleepStudyId: STUDY_ID,
        fetchImpl: async () => openAiIcd10Response("G47.33", 0.85, "Fallback OpenAI."),
      });
      expect(result.icd10).toBe("G47.33");
      expect(result.errorMessage).toBeNull();
    } finally {
      if (savedKey === undefined) {
        delete process.env.OPENAI_API_KEY;
      } else {
        process.env.OPENAI_API_KEY = savedKey;
      }
    }
  });

  it("does NOT call sendWithRetry when falling through to OpenAI", async () => {
    stageSleepStudy();

    mockSelectLlmProvider.mockReturnValue({ provider: "anthropic" });
    mockGetAnthropicClient.mockReturnValue(null);

    const savedKey = process.env.OPENAI_API_KEY;
    process.env.OPENAI_API_KEY = "sk-openai-fallback";
    try {
      await suggestIcd10({
        sleepStudyId: STUDY_ID,
        fetchImpl: async () => openAiIcd10Response("G47.33", 0.85, "Fallback."),
      });
      expect(mockSendWithRetry).not.toHaveBeenCalled();
    } finally {
      if (savedKey === undefined) {
        delete process.env.OPENAI_API_KEY;
      } else {
        process.env.OPENAI_API_KEY = savedKey;
      }
    }
  });
});

// ---------------------------------------------------------------------------
// OpenAI provider path (via selectLlmProvider)
// ---------------------------------------------------------------------------

describe("suggestIcd10 — OpenAI provider path via selectLlmProvider", () => {
  it("routes to OpenAI when selectLlmProvider returns 'openai'", async () => {
    stageSleepStudy();

    mockSelectLlmProvider.mockReturnValue({ provider: "openai" });

    const savedKey = process.env.OPENAI_API_KEY;
    process.env.OPENAI_API_KEY = "sk-openai-selected";
    try {
      const result = await suggestIcd10({
        sleepStudyId: STUDY_ID,
        fetchImpl: async () => openAiIcd10Response("G47.33", 0.9, "OpenAI path."),
      });
      expect(mockSendWithRetry).not.toHaveBeenCalled();
      expect(result.icd10).toBe("G47.33");
    } finally {
      if (savedKey === undefined) {
        delete process.env.OPENAI_API_KEY;
      } else {
        process.env.OPENAI_API_KEY = savedKey;
      }
    }
  });
});

// ---------------------------------------------------------------------------
// No provider configured
// ---------------------------------------------------------------------------

describe("suggestIcd10 — no LLM provider configured", () => {
  it("returns errored when selectLlmProvider returns 'offline'", async () => {
    stageSleepStudy();

    mockSelectLlmProvider.mockReturnValue({ provider: "offline" });

    const result = await suggestIcd10({ sleepStudyId: STUDY_ID });
    expect(result.icd10).toBeNull();
    expect(result.errorMessage).toMatch(/no LLM provider configured/);
  });

  it("returns errored when Anthropic is selected but client is null and OPENAI_API_KEY is unset", async () => {
    stageSleepStudy();

    mockSelectLlmProvider.mockReturnValue({ provider: "anthropic" });
    mockGetAnthropicClient.mockReturnValue(null);

    const savedKey = process.env.OPENAI_API_KEY;
    delete process.env.OPENAI_API_KEY;
    try {
      const result = await suggestIcd10({ sleepStudyId: STUDY_ID });
      expect(result.icd10).toBeNull();
      expect(result.errorMessage).toMatch(/no LLM provider configured/);
    } finally {
      if (savedKey !== undefined) {
        process.env.OPENAI_API_KEY = savedKey;
      }
    }
  });
});

// ---------------------------------------------------------------------------
// Output shape invariants
// ---------------------------------------------------------------------------

describe("suggestIcd10 — SuggestOutput shape", () => {
  it("always returns null latencyMs and token counts when errored", async () => {
    // Unstaged supabase → study not found
    const result = await suggestIcd10({ sleepStudyId: STUDY_ID });
    expect(result.latencyMs).toBeNull();
    expect(result.promptTokens).toBeNull();
    expect(result.completionTokens).toBeNull();
  });

  it("returns a non-negative latencyMs on a successful OpenAI call", async () => {
    stageSleepStudy();
    const result = await suggestIcd10({
      sleepStudyId: STUDY_ID,
      apiKey: "sk-test",
      fetchImpl: async () => openAiIcd10Response("G47.33", 0.9, "AHI>=15."),
    });
    expect(result.latencyMs).toBeGreaterThanOrEqual(0);
  });

  it("returns a non-negative latencyMs on a successful Anthropic call", async () => {
    stageSleepStudy();

    const mockClient = { send: vi.fn(), stream: vi.fn() };
    mockSelectLlmProvider.mockReturnValue({ provider: "anthropic" });
    mockGetAnthropicClient.mockReturnValue(mockClient);

    const anthropicText = JSON.stringify({ icd10: "G47.33", confidence: 0.9, rationale: "AHI>=15." });
    mockSendWithRetry.mockResolvedValue(anthropicOkResult(anthropicText));
    mockGetResponseText.mockReturnValue(anthropicText);

    const result = await suggestIcd10({ sleepStudyId: STUDY_ID });
    expect(result.latencyMs).toBeGreaterThanOrEqual(0);
  });

  it("trims rationale to 500 characters", async () => {
    stageSleepStudy();
    const longRationale = "R".repeat(600);
    const result = await suggestIcd10({
      sleepStudyId: STUDY_ID,
      apiKey: "sk-test",
      fetchImpl: async () => openAiIcd10Response("G47.33", 0.9, longRationale),
    });
    expect(result.rationale.length).toBeLessThanOrEqual(500);
  });

  it("returns the rationale even for a non-allowlist code", async () => {
    stageSleepStudy();
    const result = await suggestIcd10({
      sleepStudyId: STUDY_ID,
      apiKey: "sk-test",
      fetchImpl: async () => openAiIcd10Response("Z99.89", 0.4, "Not in allowlist."),
    });
    expect(result.rationale).toBe("Not in allowlist.");
  });
});

// ---------------------------------------------------------------------------
// Exported constants
// ---------------------------------------------------------------------------

describe("ai-icd10-suggester — exported constants", () => {
  it("exports ICD10_PROMPT_VERSION as icd10-1.0", async () => {
    const { ICD10_PROMPT_VERSION } = await import("./ai-icd10-suggester");
    expect(ICD10_PROMPT_VERSION).toBe("icd10-1.0");
  });

  it("exports ICD10_ALLOWLIST containing G47.33", async () => {
    const { ICD10_ALLOWLIST } = await import("./ai-icd10-suggester");
    expect(ICD10_ALLOWLIST).toContain("G47.33");
  });

  it("ICD10_ALLOWLIST does not include non-OSA codes like Z99.89", async () => {
    const { ICD10_ALLOWLIST } = await import("./ai-icd10-suggester");
    expect(ICD10_ALLOWLIST).not.toContain("Z99.89");
  });
});