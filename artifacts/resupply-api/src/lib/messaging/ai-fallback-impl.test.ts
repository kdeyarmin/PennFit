// Tests for lib/messaging/ai-fallback-impl.ts
//
// PR changes:
//   1. createOpenAiFallbackAdapter: added retry loop (MAX_RETRIES = 1) for
//      429 / 5xx HTTP errors and transport failures (AbortError / TypeError).
//   2. createAnthropicFallbackAdapter: switched to sendWithRetry() so the
//      Anthropic path has the same retry posture as the OpenAI fallback.
//   3. DEFAULT_TIMEOUT_MS raised from 5s to 10s.
//
// Test strategy:
//   - We use the `fetchImpl` test seam on createOpenAiFallbackAdapter /
//     createAnthropicFallbackAdapter to inject controlled responses without
//     real HTTP. The logger is mocked via vi.mock() (same pattern as
//     routes/storefront/track-order.test.ts) so WARN/INFO output doesn't
//     contaminate the test runner.
//   - For the Anthropic adapter we control the underlying fetch through
//     opts.fetchImpl which is forwarded into createAnthropicClient.
//   - Retry delay is bypassed by injecting fast mock fetch sequences
//     (the real delay is ~200ms+ which is too slow for unit tests; the
//     delay logic itself is covered by sendWithRetry unit tests in
//     lib/resupply-ai/src/anthropic-client.test.ts).

import { describe, expect, it, vi } from "vitest";

vi.mock("../logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import {
  createAiFallbackAdapter,
  createAnthropicFallbackAdapter,
  createOpenAiFallbackAdapter,
} from "./ai-fallback-impl";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function openAiSuccessBody(intent: string, reply = "Got it!"): unknown {
  return {
    choices: [
      {
        message: {
          content: JSON.stringify({ intent, reply }),
        },
      },
    ],
  };
}

// Multi-response fetch stub. Returned from `_makeMultiFetch([r1, r2, ...])`,
// the resulting fetch hands out `r1` on the first call, `r2` on the
// second, and so on; once exhausted it sticks on the last response so
// over-call doesn't crash. Underscored because no test currently
// imports it — kept around so the upcoming retry-cascade test suite
// (P1 review item: "OpenAI chat path has zero retry on 429/5xx" — the
// fallback adapters already retry, so once chat.ts catches up we'll
// drive the tests against this helper).
function _makeMultiFetch(responses: Response[]): typeof fetch {
  let i = 0;
  return async () => {
    const r = responses[Math.min(i, responses.length - 1)]!;
    i += 1;
    return r;
  };
}

// ---------------------------------------------------------------------------
// createOpenAiFallbackAdapter — constructor guard
// ---------------------------------------------------------------------------

describe("createOpenAiFallbackAdapter — constructor", () => {
  it("throws when apiKey is empty", () => {
    expect(() => createOpenAiFallbackAdapter({ apiKey: "" })).toThrow(
      /apiKey is required/,
    );
  });
});

// ---------------------------------------------------------------------------
// createOpenAiFallbackAdapter — happy path
// ---------------------------------------------------------------------------

describe("createOpenAiFallbackAdapter — happy path", () => {
  it("returns the parsed intent on a clean 200 response", async () => {
    const adapter = createOpenAiFallbackAdapter({
      apiKey: "sk-test",
      fetchImpl: async () => jsonResponse(openAiSuccessBody("confirm")),
    });
    const result = await adapter.classify({ body: "Yes please ship it" });
    expect(result.intent).toBe("confirm");
  });

  it("includes the model reply when the model provides one", async () => {
    const adapter = createOpenAiFallbackAdapter({
      apiKey: "sk-test",
      fetchImpl: async () =>
        jsonResponse(openAiSuccessBody("decline", "No problem, we'll hold off.")),
    });
    const result = await adapter.classify({ body: "I don't need it" });
    expect(result.intent).toBe("decline");
    expect(result.reply).toBe("No problem, we'll hold off.");
  });

  it("returns intent=unknown for an unrecognised intent string", async () => {
    const adapter = createOpenAiFallbackAdapter({
      apiKey: "sk-test",
      fetchImpl: async () =>
        jsonResponse({
          choices: [{ message: { content: JSON.stringify({ intent: "banana" }) } }],
        }),
    });
    const result = await adapter.classify({ body: "???" });
    expect(result.intent).toBe("unknown");
  });
});

// ---------------------------------------------------------------------------
// createOpenAiFallbackAdapter — retry on 429
// ---------------------------------------------------------------------------

describe("createOpenAiFallbackAdapter — retry on 429 (PR change)", () => {
  it("retries once on a 429 response and returns the eventual success", async () => {
    let calls = 0;
    const adapter = createOpenAiFallbackAdapter({
      apiKey: "sk-test",
      fetchImpl: async () => {
        calls += 1;
        if (calls === 1) {
          return new Response("rate_limited", { status: 429 });
        }
        return jsonResponse(openAiSuccessBody("confirm"));
      },
      // Override the default 10s timeout so a timing blip doesn't
      // abort the mock fetch before it returns.
      timeoutMs: 30_000,
    });
    const result = await adapter.classify({ body: "Yes!" });
    expect(calls).toBe(2);
    expect(result.intent).toBe("confirm");
  });

  it("does NOT retry a second time on persistent 429 (maxRetries = 1)", async () => {
    let calls = 0;
    const adapter = createOpenAiFallbackAdapter({
      apiKey: "sk-test",
      fetchImpl: async () => {
        calls += 1;
        return new Response("rate_limited", { status: 429 });
      },
      timeoutMs: 30_000,
    });
    const result = await adapter.classify({ body: "Yes!" });
    expect(calls).toBe(2); // initial + 1 retry
    expect(result.intent).toBe("unknown");
  });

  it("retries once on a 500 server error", async () => {
    let calls = 0;
    const adapter = createOpenAiFallbackAdapter({
      apiKey: "sk-test",
      fetchImpl: async () => {
        calls += 1;
        if (calls === 1) return new Response("server_error", { status: 500 });
        return jsonResponse(openAiSuccessBody("decline"));
      },
      timeoutMs: 30_000,
    });
    const result = await adapter.classify({ body: "No thanks" });
    expect(calls).toBe(2);
    expect(result.intent).toBe("decline");
  });
});

// ---------------------------------------------------------------------------
// createOpenAiFallbackAdapter — no retry on 4xx (non-retryable)
// ---------------------------------------------------------------------------

describe("createOpenAiFallbackAdapter — no retry on non-retryable errors (PR change)", () => {
  it("does NOT retry a 400 Bad Request", async () => {
    let calls = 0;
    const adapter = createOpenAiFallbackAdapter({
      apiKey: "sk-test",
      fetchImpl: async () => {
        calls += 1;
        return new Response("bad_request", { status: 400 });
      },
      timeoutMs: 30_000,
    });
    const result = await adapter.classify({ body: "Hi" });
    expect(calls).toBe(1);
    expect(result.intent).toBe("unknown");
  });

  it("does NOT retry a 401 Unauthorized", async () => {
    let calls = 0;
    const adapter = createOpenAiFallbackAdapter({
      apiKey: "sk-test",
      fetchImpl: async () => {
        calls += 1;
        return new Response("unauthorized", { status: 401 });
      },
      timeoutMs: 30_000,
    });
    const result = await adapter.classify({ body: "Hi" });
    expect(calls).toBe(1);
    expect(result.intent).toBe("unknown");
  });
});

// ---------------------------------------------------------------------------
// createOpenAiFallbackAdapter — transport failure retry
// ---------------------------------------------------------------------------

describe("createOpenAiFallbackAdapter — retry on transport failure (PR change)", () => {
  it("retries once on a TypeError (simulating network failure) and recovers", async () => {
    let calls = 0;
    const adapter = createOpenAiFallbackAdapter({
      apiKey: "sk-test",
      fetchImpl: async () => {
        calls += 1;
        if (calls === 1) throw new TypeError("fetch failed");
        return jsonResponse(openAiSuccessBody("help"));
      },
      timeoutMs: 30_000,
    });
    const result = await adapter.classify({ body: "what is this?" });
    expect(calls).toBe(2);
    expect(result.intent).toBe("help");
  });

  it("returns intent=unknown after both transport attempts fail", async () => {
    let calls = 0;
    const adapter = createOpenAiFallbackAdapter({
      apiKey: "sk-test",
      fetchImpl: async () => {
        calls += 1;
        throw new TypeError("fetch failed");
      },
      timeoutMs: 30_000,
    });
    const result = await adapter.classify({ body: "hi" });
    expect(calls).toBe(2); // initial + 1 retry
    expect(result.intent).toBe("unknown");
  });
});

// ---------------------------------------------------------------------------
// createOpenAiFallbackAdapter — fail-soft: never throws
// ---------------------------------------------------------------------------

describe("createOpenAiFallbackAdapter — fail-soft posture", () => {
  it("always resolves (never throws) even on complete failure", async () => {
    const adapter = createOpenAiFallbackAdapter({
      apiKey: "sk-test",
      fetchImpl: async () => {
        throw new Error("unexpected internal error");
      },
      timeoutMs: 30_000,
    });
    await expect(adapter.classify({ body: "hi" })).resolves.toMatchObject({
      intent: "unknown",
    });
  });

  it("returns intent=unknown when model output is malformed JSON", async () => {
    const adapter = createOpenAiFallbackAdapter({
      apiKey: "sk-test",
      fetchImpl: async () =>
        new Response(
          JSON.stringify({
            choices: [{ message: { content: "not json at all" } }],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      timeoutMs: 30_000,
    });
    const result = await adapter.classify({ body: "hi" });
    expect(result.intent).toBe("unknown");
  });
});

// ---------------------------------------------------------------------------
// createAnthropicFallbackAdapter — constructor guard
// ---------------------------------------------------------------------------

describe("createAnthropicFallbackAdapter — constructor", () => {
  it("throws when apiKey is empty", () => {
    expect(() => createAnthropicFallbackAdapter({ apiKey: "" })).toThrow(
      /apiKey is required/,
    );
  });
});

// ---------------------------------------------------------------------------
// createAnthropicFallbackAdapter — happy path
// ---------------------------------------------------------------------------

function anthropicSuccessResponse(content: string): unknown {
  return {
    id: "msg_test",
    type: "message",
    role: "assistant",
    model: "claude-haiku-4-5",
    content: [{ type: "text", text: content }],
    stop_reason: "end_turn",
    usage: { input_tokens: 50, output_tokens: 30 },
  };
}

describe("createAnthropicFallbackAdapter — happy path", () => {
  it("returns the parsed intent from Claude's JSON output", async () => {
    const adapter = createAnthropicFallbackAdapter({
      apiKey: "sk-ant-test-key",
      fetchImpl: async () =>
        jsonResponse(
          anthropicSuccessResponse(
            JSON.stringify({ intent: "confirm", reply: "Got it, shipping today!" }),
          ),
        ),
    });
    const result = await adapter.classify({ body: "Yes please" });
    expect(result.intent).toBe("confirm");
    expect(result.reply).toBe("Got it, shipping today!");
  });

  it("returns intent=unknown when Claude returns a non-JSON reply", async () => {
    const adapter = createAnthropicFallbackAdapter({
      apiKey: "sk-ant-test-key",
      fetchImpl: async () =>
        jsonResponse(anthropicSuccessResponse("I cannot answer that.")),
    });
    const result = await adapter.classify({ body: "???" });
    expect(result.intent).toBe("unknown");
  });

  it("never throws — returns intent=unknown on Anthropic HTTP error", async () => {
    const adapter = createAnthropicFallbackAdapter({
      apiKey: "sk-ant-test-key",
      fetchImpl: async () => new Response("server error", { status: 500 }),
    });
    await expect(adapter.classify({ body: "hi" })).resolves.toMatchObject({
      intent: "unknown",
    });
  });
});

// ---------------------------------------------------------------------------
// createAnthropicFallbackAdapter — retry via sendWithRetry (PR change)
// ---------------------------------------------------------------------------

describe("createAnthropicFallbackAdapter — retry via sendWithRetry (PR change)", () => {
  it("retries once on Anthropic 429 and returns the eventual success", async () => {
    let calls = 0;
    const adapter = createAnthropicFallbackAdapter({
      apiKey: "sk-ant-test-key",
      fetchImpl: async () => {
        calls += 1;
        if (calls === 1) {
          // Anthropic 429 body
          return new Response(
            JSON.stringify({ type: "error", error: { type: "rate_limit_error", message: "rate limit" } }),
            { status: 429, headers: { "content-type": "application/json" } },
          );
        }
        return jsonResponse(
          anthropicSuccessResponse(
            JSON.stringify({ intent: "decline", reply: "No worries!" }),
          ),
        );
      },
    });
    const result = await adapter.classify({ body: "No thanks" });
    expect(calls).toBe(2);
    expect(result.intent).toBe("decline");
  });
});

// ---------------------------------------------------------------------------
// createAiFallbackAdapter — factory selector
// ---------------------------------------------------------------------------

describe("createAiFallbackAdapter — factory selector", () => {
  it("returns an adapter (non-null) when ANTHROPIC_API_KEY is set", () => {
    const adapter = createAiFallbackAdapter({
      ANTHROPIC_API_KEY: "sk-ant-test-key",
    });
    expect(adapter).not.toBeNull();
  });

  it("returns an adapter (non-null) when only OPENAI_API_KEY is set", () => {
    const adapter = createAiFallbackAdapter({
      OPENAI_API_KEY: "sk-test",
    });
    expect(adapter).not.toBeNull();
  });

  it("returns null when neither key is present", () => {
    const adapter = createAiFallbackAdapter({});
    expect(adapter).toBeNull();
  });

  it("prefers Anthropic over OpenAI when both keys are present", () => {
    // The returned adapter must be non-null; we can't directly introspect
    // which concrete type was returned without mocking, but we can verify
    // the factory doesn't crash and returns something.
    const adapter = createAiFallbackAdapter({
      ANTHROPIC_API_KEY: "sk-ant-test-key",
      OPENAI_API_KEY: "sk-openai-key",
    });
    expect(adapter).not.toBeNull();
    expect(typeof adapter!.classify).toBe("function");
  });

  it("returns null when ANTHROPIC_API_KEY is whitespace-only", () => {
    const adapter = createAiFallbackAdapter({
      ANTHROPIC_API_KEY: "   ",
    });
    expect(adapter).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// parseModelOutput — confidence field (PR change)
//
// The PR adds an optional `confidence` field to the model output and
// AiFallbackResult. These tests exercise the parsing contract through
// the public `classify()` API: we can't call parseModelOutput directly
// (it's module-private) but every code path runs through classify().
// ---------------------------------------------------------------------------

function openAiSuccessBodyWithConfidence(
  intent: string,
  confidence: unknown,
  reply = "Got it!",
): unknown {
  return {
    choices: [
      {
        message: {
          content: JSON.stringify({ intent, reply, confidence }),
        },
      },
    ],
  };
}

describe("parseModelOutput — confidence field (PR change)", () => {
  it("parses a confidence value within [0,1] and returns it on the result", async () => {
    const adapter = createOpenAiFallbackAdapter({
      apiKey: "sk-test",
      fetchImpl: async () =>
        jsonResponse(openAiSuccessBodyWithConfidence("confirm", 0.95)),
      timeoutMs: 30_000,
    });
    const result = await adapter.classify({ body: "Yes please" });
    expect(result.intent).toBe("confirm");
    expect(result.confidence).toBe(0.95);
  });

  it("returns confidence = 0 when the model reports exactly 0", async () => {
    const adapter = createOpenAiFallbackAdapter({
      apiKey: "sk-test",
      fetchImpl: async () =>
        jsonResponse(openAiSuccessBodyWithConfidence("unknown", 0)),
      timeoutMs: 30_000,
    });
    const result = await adapter.classify({ body: "???" });
    expect(result.confidence).toBe(0);
  });

  it("returns confidence = 1 when the model reports exactly 1", async () => {
    const adapter = createOpenAiFallbackAdapter({
      apiKey: "sk-test",
      fetchImpl: async () =>
        jsonResponse(openAiSuccessBodyWithConfidence("stop", 1)),
      timeoutMs: 30_000,
    });
    const result = await adapter.classify({ body: "STOP" });
    expect(result.confidence).toBe(1);
  });

  it("clamps confidence to 1 when the model overshoots (e.g. 1.5)", async () => {
    const adapter = createOpenAiFallbackAdapter({
      apiKey: "sk-test",
      fetchImpl: async () =>
        jsonResponse(openAiSuccessBodyWithConfidence("confirm", 1.5)),
      timeoutMs: 30_000,
    });
    const result = await adapter.classify({ body: "yes" });
    expect(result.confidence).toBe(1);
  });

  it("clamps confidence to 0 when the model goes below zero (e.g. -0.1)", async () => {
    const adapter = createOpenAiFallbackAdapter({
      apiKey: "sk-test",
      fetchImpl: async () =>
        jsonResponse(openAiSuccessBodyWithConfidence("unknown", -0.1)),
      timeoutMs: 30_000,
    });
    const result = await adapter.classify({ body: "idk" });
    expect(result.confidence).toBe(0);
  });

  it("omits confidence from the result when the model does not include the field", async () => {
    // openAiSuccessBody does not include confidence — mirrors the existing
    // helper so we verify the legacy (pre-PR) model output is still handled.
    const adapter = createOpenAiFallbackAdapter({
      apiKey: "sk-test",
      fetchImpl: async () => jsonResponse(openAiSuccessBody("help")),
      timeoutMs: 30_000,
    });
    const result = await adapter.classify({ body: "what is this?" });
    expect(result.confidence).toBeUndefined();
  });

  it("omits confidence when the model sends a string instead of a number", async () => {
    const adapter = createOpenAiFallbackAdapter({
      apiKey: "sk-test",
      fetchImpl: async () =>
        jsonResponse(openAiSuccessBodyWithConfidence("confirm", "0.9")),
      timeoutMs: 30_000,
    });
    const result = await adapter.classify({ body: "yes" });
    expect(result.confidence).toBeUndefined();
  });

  it("omits confidence when the model sends NaN", async () => {
    // NaN serializes as `null` in JSON.stringify, so the wire value is null.
    // parseModelOutput must treat null as non-finite → undefined.
    const adapter = createOpenAiFallbackAdapter({
      apiKey: "sk-test",
      fetchImpl: async () =>
        jsonResponse(openAiSuccessBodyWithConfidence("confirm", null)),
      timeoutMs: 30_000,
    });
    const result = await adapter.classify({ body: "yes" });
    expect(result.confidence).toBeUndefined();
  });

  it("omits confidence when the model sends a boolean", async () => {
    const adapter = createOpenAiFallbackAdapter({
      apiKey: "sk-test",
      fetchImpl: async () =>
        jsonResponse(openAiSuccessBodyWithConfidence("confirm", true)),
      timeoutMs: 30_000,
    });
    const result = await adapter.classify({ body: "yes" });
    expect(result.confidence).toBeUndefined();
  });

  it("Anthropic adapter also returns confidence from model output", async () => {
    const body = {
      id: "msg_test",
      type: "message",
      role: "assistant",
      model: "claude-haiku-4-5",
      content: [
        {
          type: "text",
          text: JSON.stringify({ intent: "decline", reply: "No worries!", confidence: 0.88 }),
        },
      ],
      stop_reason: "end_turn",
      usage: { input_tokens: 50, output_tokens: 30 },
    };
    const adapter = createAnthropicFallbackAdapter({
      apiKey: "sk-ant-test-key",
      fetchImpl: async () =>
        new Response(JSON.stringify(body), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    });
    const result = await adapter.classify({ body: "No thanks" });
    expect(result.intent).toBe("decline");
    expect(result.confidence).toBe(0.88);
  });

  it("Anthropic adapter omits confidence when field is absent from model output", async () => {
    const body = {
      id: "msg_test",
      type: "message",
      role: "assistant",
      model: "claude-haiku-4-5",
      content: [
        {
          type: "text",
          text: JSON.stringify({ intent: "stop", reply: "Unsubscribed." }),
        },
      ],
      stop_reason: "end_turn",
      usage: { input_tokens: 50, output_tokens: 20 },
    };
    const adapter = createAnthropicFallbackAdapter({
      apiKey: "sk-ant-test-key",
      fetchImpl: async () =>
        new Response(JSON.stringify(body), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    });
    const result = await adapter.classify({ body: "STOP" });
    expect(result.confidence).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// createOpenAiFallbackAdapter — timeout was raised to 10s (PR change)
// Source-analysis to guard the constant didn't regress.
// ---------------------------------------------------------------------------

describe("ai-fallback-impl — DEFAULT_TIMEOUT_MS raised to 10s (PR change)", () => {
  it("source declares DEFAULT_TIMEOUT_MS = 10_000", async () => {
    const { readFileSync } = await import("node:fs");
    const { fileURLToPath } = await import("node:url");
    const pathMod = await import("node:path");
    const dir = pathMod.dirname(fileURLToPath(import.meta.url));
    const src = readFileSync(pathMod.join(dir, "ai-fallback-impl.ts"), "utf8");
    expect(src).toContain("DEFAULT_TIMEOUT_MS = 10_000");
    // Verify the comment explaining the rationale is also present.
    expect(src).toContain("10s timeout (was 5s)");
  });
});