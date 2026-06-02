// Tests for lib/resupply-ai/src/index.ts
//
// The ElevenLabs client is now re-exported from the public surface: it
// is wired into the live voice path as the agent's voice (with OpenAI's
// cedar voice as the fallback when ELEVENLABS_API_KEY is unset).
//
// These tests verify:
//   1. The ElevenLabs exports are present with the right shapes.
//   2. Core exports that ship on the public surface are still present and
//      have the correct shapes.

import { describe, expect, it } from "vitest";

import * as resupplyAi from "./index";

// ---------------------------------------------------------------------------
// ElevenLabs exports — now wired into the live voice path
// ---------------------------------------------------------------------------

describe("resupply-ai index — ElevenLabs exports present", () => {
  it("exports createElevenLabsClient as a function", () => {
    expect(typeof resupplyAi.createElevenLabsClient).toBe("function");
  });

  it("exports DEFAULT_ELEVENLABS_MODEL as a non-empty string", () => {
    expect(typeof resupplyAi.DEFAULT_ELEVENLABS_MODEL).toBe("string");
    expect(resupplyAi.DEFAULT_ELEVENLABS_MODEL.length).toBeGreaterThan(0);
  });

  it("exports DEFAULT_ELEVENLABS_VOICE_ID as a non-empty string", () => {
    expect(typeof resupplyAi.DEFAULT_ELEVENLABS_VOICE_ID).toBe("string");
    expect(resupplyAi.DEFAULT_ELEVENLABS_VOICE_ID.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Anthropic client exports — still present
// ---------------------------------------------------------------------------

describe("resupply-ai index — Anthropic exports still present", () => {
  it("exports createAnthropicClient as a function", () => {
    expect(typeof resupplyAi.createAnthropicClient).toBe("function");
  });

  it("exports sendWithRetry as a function", () => {
    expect(typeof resupplyAi.sendWithRetry).toBe("function");
  });

  it("exports getResponseText as a function", () => {
    expect(typeof resupplyAi.getResponseText).toBe("function");
  });

  it("exports getResponseToolCalls as a function", () => {
    expect(typeof resupplyAi.getResponseToolCalls).toBe("function");
  });

  it("exports isRetryableAnthropicError as a function", () => {
    expect(typeof resupplyAi.isRetryableAnthropicError).toBe("function");
  });

  it("exports DEFAULT_ANTHROPIC_MODEL_CHAT as a non-empty string", () => {
    expect(typeof resupplyAi.DEFAULT_ANTHROPIC_MODEL_CHAT).toBe("string");
    expect(resupplyAi.DEFAULT_ANTHROPIC_MODEL_CHAT.length).toBeGreaterThan(0);
  });

  it("exports DEFAULT_ANTHROPIC_MODEL_CLASSIFY as a non-empty string", () => {
    expect(typeof resupplyAi.DEFAULT_ANTHROPIC_MODEL_CLASSIFY).toBe("string");
    expect(resupplyAi.DEFAULT_ANTHROPIC_MODEL_CLASSIFY.length).toBeGreaterThan(
      0,
    );
  });

  it("exports DEFAULT_ANTHROPIC_MODEL_REASONING as a non-empty string", () => {
    expect(typeof resupplyAi.DEFAULT_ANTHROPIC_MODEL_REASONING).toBe("string");
    expect(resupplyAi.DEFAULT_ANTHROPIC_MODEL_REASONING.length).toBeGreaterThan(
      0,
    );
  });
});

// ---------------------------------------------------------------------------
// Deepgram exports — still present
// ---------------------------------------------------------------------------

describe("resupply-ai index — Deepgram exports still present", () => {
  it("exports createDeepgramClient as a function", () => {
    expect(typeof resupplyAi.createDeepgramClient).toBe("function");
  });

  it("exports DEFAULT_DEEPGRAM_MODEL as a non-empty string", () => {
    expect(typeof resupplyAi.DEFAULT_DEEPGRAM_MODEL).toBe("string");
    expect(resupplyAi.DEFAULT_DEEPGRAM_MODEL.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Realtime / Voice bridge exports — still present
// ---------------------------------------------------------------------------

describe("resupply-ai index — Realtime exports still present", () => {
  it("exports RealtimeClient as a constructor", () => {
    expect(typeof resupplyAi.RealtimeClient).toBe("function");
  });

  it("exports VoiceBridge as a constructor", () => {
    expect(typeof resupplyAi.VoiceBridge).toBe("function");
  });

  it("exports DEFAULT_REALTIME_MODEL as a non-empty string", () => {
    expect(typeof resupplyAi.DEFAULT_REALTIME_MODEL).toBe("string");
    expect(resupplyAi.DEFAULT_REALTIME_MODEL.length).toBeGreaterThan(0);
  });

  it("exports DEFAULT_REALTIME_VOICE as a non-empty string", () => {
    expect(typeof resupplyAi.DEFAULT_REALTIME_VOICE).toBe("string");
    expect(resupplyAi.DEFAULT_REALTIME_VOICE.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Tools exports — still present
// ---------------------------------------------------------------------------

describe("resupply-ai index — Tools exports still present", () => {
  it("exports TOOL_NAMES as an object", () => {
    expect(typeof resupplyAi.TOOL_NAMES).toBe("object");
    expect(resupplyAi.TOOL_NAMES).not.toBeNull();
  });

  it("exports OPENAI_TOOL_DESCRIPTORS as an array", () => {
    expect(Array.isArray(resupplyAi.OPENAI_TOOL_DESCRIPTORS)).toBe(true);
  });

  it("exports summarizeToolArgsForAudit as a function", () => {
    expect(typeof resupplyAi.summarizeToolArgsForAudit).toBe("function");
  });
});

// ---------------------------------------------------------------------------
// Prompts exports — still present
// ---------------------------------------------------------------------------

describe("resupply-ai index — Prompts exports still present", () => {
  it("exports PROMPT_VERSION as a non-empty string", () => {
    expect(typeof resupplyAi.PROMPT_VERSION).toBe("string");
    expect(resupplyAi.PROMPT_VERSION.length).toBeGreaterThan(0);
  });

  it("exports buildSystemPrompt as a function", () => {
    expect(typeof resupplyAi.buildSystemPrompt).toBe("function");
  });
});

// ---------------------------------------------------------------------------
// Functional smoke tests for retained exports
// ---------------------------------------------------------------------------

describe("resupply-ai index — functional smoke tests", () => {
  it("getResponseText extracts text from an Anthropic response content block", () => {
    const fakeResponse = {
      id: "msg_test",
      type: "message",
      role: "assistant",
      model: "claude-haiku",
      content: [{ type: "text", text: "Hello world" }],
      stop_reason: "end_turn",
      usage: { input_tokens: 5, output_tokens: 2 },
    };
    // Cast to the expected type to call the function
    const text = resupplyAi.getResponseText(
      fakeResponse as Parameters<typeof resupplyAi.getResponseText>[0],
    );
    expect(text).toBe("Hello world");
  });

  it("isRetryableAnthropicError returns true for a timeout error result", () => {
    const result = {
      ok: false as const,
      errorCode: "timeout" as const,
      errorMessage: "timed out",
      latencyMs: 15000,
    };
    expect(resupplyAi.isRetryableAnthropicError(result)).toBe(true);
  });

  it("isRetryableAnthropicError returns false for a config error result", () => {
    const result = {
      ok: false as const,
      errorCode: "config" as const,
      errorMessage: "missing api key",
      latencyMs: 0,
    };
    expect(resupplyAi.isRetryableAnthropicError(result)).toBe(false);
  });

  it("isRetryableAnthropicError returns true for an HTTP 429 error", () => {
    const result = {
      ok: false as const,
      errorCode: "http" as const,
      errorMessage: "rate limited",
      httpStatus: 429,
      latencyMs: 100,
    };
    expect(resupplyAi.isRetryableAnthropicError(result)).toBe(true);
  });
});
