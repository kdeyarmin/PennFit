import { describe, expect, it } from "vitest";

import {
  createAnthropicClient,
  DEFAULT_ANTHROPIC_MODEL_CHAT,
  DEFAULT_ANTHROPIC_MODEL_CLASSIFY,
  DEFAULT_ANTHROPIC_MODEL_REASONING,
  getResponseText,
  getResponseToolCalls,
  isRetryableAnthropicError,
  sendWithRetry,
  type AnthropicCallResult,
  type AnthropicClient,
  type AnthropicRequest,
  type AnthropicResponse,
} from "./anthropic-client";

const VALID_KEY = "sk-ant-test-fake-key";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function textResponse(body: string, status: number): Response {
  return new Response(body, { status, headers: { "content-type": "text/plain" } });
}

function sseResponse(events: string[]): Response {
  const body = events.map((e) => `${e}\n\n`).join("");
  return new Response(body, {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}

const SAMPLE_RESPONSE: AnthropicResponse = {
  id: "msg_01abc",
  type: "message",
  role: "assistant",
  model: "claude-sonnet-4-6",
  content: [{ type: "text", text: "Hi there! How can I help?" }],
  stop_reason: "end_turn",
  usage: { input_tokens: 12, output_tokens: 8 },
};

describe("createAnthropicClient", () => {
  it("throws when apiKey is missing", () => {
    expect(() => createAnthropicClient({ apiKey: "" })).toThrow(/apiKey/);
  });

  describe("send()", () => {
    it("returns the parsed response on success", async () => {
      const client = createAnthropicClient({
        apiKey: VALID_KEY,
        fetchImpl: async () => jsonResponse(SAMPLE_RESPONSE),
      });
      const result = await client.send({
        model: DEFAULT_ANTHROPIC_MODEL_CHAT,
        max_tokens: 100,
        messages: [{ role: "user", content: "hello" }],
      });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.response.id).toBe("msg_01abc");
        expect(getResponseText(result.response)).toBe("Hi there! How can I help?");
        expect(result.latencyMs).toBeGreaterThanOrEqual(0);
      }
    });

    it("sends the required x-api-key and anthropic-version headers", async () => {
      let capturedHeaders: Record<string, string> = {};
      const client = createAnthropicClient({
        apiKey: VALID_KEY,
        fetchImpl: async (_url, init) => {
          capturedHeaders = (init?.headers ?? {}) as Record<string, string>;
          return jsonResponse(SAMPLE_RESPONSE);
        },
      });
      await client.send({
        model: DEFAULT_ANTHROPIC_MODEL_CHAT,
        max_tokens: 100,
        messages: [{ role: "user", content: "hi" }],
      });
      expect(capturedHeaders["x-api-key"]).toBe(VALID_KEY);
      expect(capturedHeaders["anthropic-version"]).toBe("2023-06-01");
      expect(capturedHeaders["Content-Type"]).toBe("application/json");
    });

    it("returns a typed http error on non-2xx response", async () => {
      const client = createAnthropicClient({
        apiKey: VALID_KEY,
        fetchImpl: async () => textResponse("Rate limited", 429),
      });
      const result = await client.send({
        model: DEFAULT_ANTHROPIC_MODEL_CHAT,
        max_tokens: 100,
        messages: [{ role: "user", content: "hi" }],
      });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.errorCode).toBe("http");
        expect(result.httpStatus).toBe(429);
        expect(result.errorMessage).toContain("429");
      }
    });

    it("surfaces cache_read_input_tokens as cacheHitTokens", async () => {
      const cachedResponse: AnthropicResponse = {
        ...SAMPLE_RESPONSE,
        usage: {
          input_tokens: 12,
          output_tokens: 8,
          cache_read_input_tokens: 1234,
          cache_creation_input_tokens: 0,
        },
      };
      const client = createAnthropicClient({
        apiKey: VALID_KEY,
        fetchImpl: async () => jsonResponse(cachedResponse),
      });
      const result = await client.send({
        model: DEFAULT_ANTHROPIC_MODEL_CHAT,
        max_tokens: 100,
        messages: [{ role: "user", content: "hi" }],
      });
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.cacheHitTokens).toBe(1234);
    });

    it("defaults cacheHitTokens to 0 when usage omits the field", async () => {
      const client = createAnthropicClient({
        apiKey: VALID_KEY,
        fetchImpl: async () => jsonResponse(SAMPLE_RESPONSE),
      });
      const result = await client.send({
        model: DEFAULT_ANTHROPIC_MODEL_CHAT,
        max_tokens: 100,
        messages: [{ role: "user", content: "hi" }],
      });
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.cacheHitTokens).toBe(0);
    });

    it("returns transport error on fetch rejection", async () => {
      const client = createAnthropicClient({
        apiKey: VALID_KEY,
        fetchImpl: async () => {
          throw new Error("network down");
        },
      });
      const result = await client.send({
        model: DEFAULT_ANTHROPIC_MODEL_CHAT,
        max_tokens: 100,
        messages: [{ role: "user", content: "hi" }],
      });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.errorCode).toBe("transport");
        expect(result.errorMessage).toContain("network down");
      }
    });

    it("returns empty when content blocks are missing", async () => {
      const client = createAnthropicClient({
        apiKey: VALID_KEY,
        fetchImpl: async () => jsonResponse({ ...SAMPLE_RESPONSE, content: [] }),
      });
      const result = await client.send({
        model: DEFAULT_ANTHROPIC_MODEL_CHAT,
        max_tokens: 100,
        messages: [{ role: "user", content: "hi" }],
      });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.errorCode).toBe("empty");
      }
    });

    it("sends cache_control on system block when provided", async () => {
      let capturedBody: string | null = null;
      const client = createAnthropicClient({
        apiKey: VALID_KEY,
        fetchImpl: async (_url, init) => {
          capturedBody =
            typeof init?.body === "string" ? init.body : String(init?.body);
          return jsonResponse(SAMPLE_RESPONSE);
        },
      });
      await client.send({
        model: DEFAULT_ANTHROPIC_MODEL_CHAT,
        max_tokens: 100,
        system: [
          {
            type: "text",
            text: "big stable prompt",
            cache_control: { type: "ephemeral" },
          },
        ],
        messages: [{ role: "user", content: "hi" }],
      });
      expect(capturedBody).toContain("cache_control");
      expect(capturedBody).toContain("ephemeral");
    });
  });

  describe("stream()", () => {
    it("emits text deltas via the callback and assembles final response", async () => {
      const events = [
        `data: ${JSON.stringify({
          type: "message_start",
          message: { id: "msg_99", model: "claude-sonnet-4-6", usage: { input_tokens: 5, output_tokens: 0 } },
        })}`,
        `data: ${JSON.stringify({
          type: "content_block_start",
          index: 0,
          content_block: { type: "text", text: "" },
        })}`,
        `data: ${JSON.stringify({
          type: "content_block_delta",
          index: 0,
          delta: { type: "text_delta", text: "Hello " },
        })}`,
        `data: ${JSON.stringify({
          type: "content_block_delta",
          index: 0,
          delta: { type: "text_delta", text: "world!" },
        })}`,
        `data: ${JSON.stringify({ type: "content_block_stop", index: 0 })}`,
        `data: ${JSON.stringify({
          type: "message_delta",
          delta: { stop_reason: "end_turn" },
          usage: { input_tokens: 5, output_tokens: 3 },
        })}`,
        `data: ${JSON.stringify({ type: "message_stop" })}`,
      ];
      const client = createAnthropicClient({
        apiKey: VALID_KEY,
        fetchImpl: async () => sseResponse(events),
      });
      const deltas: string[] = [];
      const result = await client.stream(
        {
          model: DEFAULT_ANTHROPIC_MODEL_CHAT,
          max_tokens: 100,
          messages: [{ role: "user", content: "hi" }],
        },
        (t) => deltas.push(t),
      );
      expect(deltas).toEqual(["Hello ", "world!"]);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(getResponseText(result.response)).toBe("Hello world!");
        expect(result.response.stop_reason).toBe("end_turn");
        expect(result.response.usage.output_tokens).toBe(3);
      }
    });

    it("captures tool_use blocks from the stream", async () => {
      const events = [
        `data: ${JSON.stringify({
          type: "content_block_start",
          index: 0,
          content_block: { type: "tool_use", id: "toolu_1", name: "find_masks" },
        })}`,
        `data: ${JSON.stringify({
          type: "content_block_delta",
          index: 0,
          delta: { type: "input_json_delta", partial_json: '{"type":"nas' },
        })}`,
        `data: ${JSON.stringify({
          type: "content_block_delta",
          index: 0,
          delta: { type: "input_json_delta", partial_json: 'al"}' },
        })}`,
        `data: ${JSON.stringify({ type: "content_block_stop", index: 0 })}`,
        `data: ${JSON.stringify({
          type: "message_delta",
          delta: { stop_reason: "tool_use" },
        })}`,
      ];
      const client = createAnthropicClient({
        apiKey: VALID_KEY,
        fetchImpl: async () => sseResponse(events),
      });
      const result = await client.stream(
        {
          model: DEFAULT_ANTHROPIC_MODEL_CHAT,
          max_tokens: 100,
          messages: [{ role: "user", content: "find a nasal mask" }],
        },
        () => undefined,
      );
      expect(result.ok).toBe(true);
      if (result.ok) {
        const calls = getResponseToolCalls(result.response);
        expect(calls).toHaveLength(1);
        expect(calls[0]?.name).toBe("find_masks");
        expect(calls[0]?.input).toEqual({ type: "nasal" });
        expect(result.response.stop_reason).toBe("tool_use");
      }
    });
  });
});

describe("getResponseText", () => {
  it("concatenates text blocks and skips tool_use blocks", () => {
    const text = getResponseText({
      id: "x",
      type: "message",
      role: "assistant",
      model: "m",
      content: [
        { type: "text", text: "Hi " },
        { type: "tool_use", id: "t1", name: "foo", input: {} },
        { type: "text", text: "there" },
      ],
      stop_reason: "end_turn",
      usage: { input_tokens: 1, output_tokens: 1 },
    });
    expect(text).toBe("Hi there");
  });

  it("returns empty string when no text blocks present", () => {
    const text = getResponseText({
      id: "x",
      type: "message",
      role: "assistant",
      model: "m",
      content: [{ type: "tool_use", id: "t1", name: "foo", input: {} }],
      stop_reason: "tool_use",
      usage: { input_tokens: 1, output_tokens: 1 },
    });
    expect(text).toBe("");
  });
});

describe("isRetryableAnthropicError", () => {
  it("flags timeout as retryable", () => {
    expect(
      isRetryableAnthropicError({
        ok: false,
        errorCode: "timeout",
        errorMessage: "aborted",
        latencyMs: 30_000,
      }),
    ).toBe(true);
  });

  it("flags transport errors as retryable", () => {
    expect(
      isRetryableAnthropicError({
        ok: false,
        errorCode: "transport",
        errorMessage: "ECONNRESET",
        latencyMs: 12,
      }),
    ).toBe(true);
  });

  it("flags 429 rate-limit as retryable", () => {
    expect(
      isRetryableAnthropicError({
        ok: false,
        errorCode: "http",
        errorMessage: "rate limited",
        httpStatus: 429,
        latencyMs: 80,
      }),
    ).toBe(true);
  });

  it("flags 5xx as retryable", () => {
    for (const status of [500, 502, 503, 529]) {
      expect(
        isRetryableAnthropicError({
          ok: false,
          errorCode: "http",
          errorMessage: `server ${status}`,
          httpStatus: status,
          latencyMs: 40,
        }),
      ).toBe(true);
    }
  });

  it("does NOT flag 4xx (other than 429) as retryable", () => {
    for (const status of [400, 401, 403, 404, 422]) {
      expect(
        isRetryableAnthropicError({
          ok: false,
          errorCode: "http",
          errorMessage: `client ${status}`,
          httpStatus: status,
          latencyMs: 40,
        }),
      ).toBe(false);
    }
  });

  it("does NOT flag empty/parse/config as retryable", () => {
    for (const code of ["empty", "parse", "config"] as const) {
      expect(
        isRetryableAnthropicError({
          ok: false,
          errorCode: code,
          errorMessage: "x",
          latencyMs: 5,
        }),
      ).toBe(false);
    }
  });
});

describe("sendWithRetry", () => {
  const baseReq: AnthropicRequest = {
    model: DEFAULT_ANTHROPIC_MODEL_CHAT,
    max_tokens: 50,
    messages: [{ role: "user", content: "hi" }],
  };
  const noSleep = async (_ms: number): Promise<void> => undefined;

  function clientOf(
    results: AnthropicCallResult[],
    onSend?: (req: AnthropicRequest, attempt: number) => void,
  ): AnthropicClient {
    let i = 0;
    return {
      async send(req: AnthropicRequest): Promise<AnthropicCallResult> {
        if (onSend) onSend(req, i);
        const r = results[Math.min(i, results.length - 1)]!;
        i += 1;
        return r;
      },
      async stream(): Promise<AnthropicCallResult> {
        throw new Error("not used");
      },
    };
  }

  it("returns first success without retrying", async () => {
    let calls = 0;
    const client = clientOf(
      [
        {
          ok: true,
          response: SAMPLE_RESPONSE,
          latencyMs: 10,
          cacheHitTokens: 0,
        },
      ],
      () => calls++,
    );
    const result = await sendWithRetry(client, baseReq, { sleep: noSleep });
    expect(result.ok).toBe(true);
    expect(calls).toBe(1);
  });

  it("retries once on 429 and returns the eventual success", async () => {
    let calls = 0;
    const client = clientOf(
      [
        {
          ok: false,
          errorCode: "http",
          errorMessage: "rate limit",
          httpStatus: 429,
          latencyMs: 10,
        },
        {
          ok: true,
          response: SAMPLE_RESPONSE,
          latencyMs: 12,
          cacheHitTokens: 0,
        },
      ],
      () => calls++,
    );
    const result = await sendWithRetry(client, baseReq, { sleep: noSleep });
    expect(result.ok).toBe(true);
    expect(calls).toBe(2);
  });

  it("retries once on timeout and surfaces the final failure if it persists", async () => {
    let calls = 0;
    const client = clientOf(
      [
        {
          ok: false,
          errorCode: "timeout",
          errorMessage: "aborted",
          latencyMs: 30_000,
        },
        {
          ok: false,
          errorCode: "timeout",
          errorMessage: "aborted",
          latencyMs: 30_000,
        },
      ],
      () => calls++,
    );
    const result = await sendWithRetry(client, baseReq, { sleep: noSleep });
    expect(result.ok).toBe(false);
    expect(calls).toBe(2);
  });

  it("does NOT retry on 400 (non-retryable)", async () => {
    let calls = 0;
    const client = clientOf(
      [
        {
          ok: false,
          errorCode: "http",
          errorMessage: "bad request",
          httpStatus: 400,
          latencyMs: 5,
        },
      ],
      () => calls++,
    );
    const result = await sendWithRetry(client, baseReq, { sleep: noSleep });
    expect(result.ok).toBe(false);
    expect(calls).toBe(1);
  });

  it("respects maxRetries=0 (no retries)", async () => {
    let calls = 0;
    const client = clientOf(
      [
        {
          ok: false,
          errorCode: "timeout",
          errorMessage: "aborted",
          latencyMs: 30_000,
        },
        {
          ok: true,
          response: SAMPLE_RESPONSE,
          latencyMs: 12,
          cacheHitTokens: 0,
        },
      ],
      () => calls++,
    );
    const result = await sendWithRetry(client, baseReq, {
      sleep: noSleep,
      maxRetries: 0,
    });
    expect(result.ok).toBe(false);
    expect(calls).toBe(1);
  });

  it("does NOT retry on empty/parse responses", async () => {
    let calls = 0;
    const client = clientOf(
      [
        {
          ok: false,
          errorCode: "empty",
          errorMessage: "no content",
          latencyMs: 12,
        },
      ],
      () => calls++,
    );
    const result = await sendWithRetry(client, baseReq, { sleep: noSleep });
    expect(result.ok).toBe(false);
    expect(calls).toBe(1);
  });

  it("uses the sleep hook between attempts with backoff", async () => {
    const sleeps: number[] = [];
    const client = clientOf([
      {
        ok: false,
        errorCode: "transport",
        errorMessage: "blip",
        latencyMs: 5,
      },
      {
        ok: false,
        errorCode: "transport",
        errorMessage: "blip",
        latencyMs: 5,
      },
      {
        ok: true,
        response: SAMPLE_RESPONSE,
        latencyMs: 12,
        cacheHitTokens: 0,
      },
    ]);
    await sendWithRetry(client, baseReq, {
      sleep: async (ms) => {
        sleeps.push(ms);
      },
      maxRetries: 2,
      baseDelayMs: 100,
    });
    expect(sleeps.length).toBe(2);
    // 100 * 2^0 = 100 (+0..49 jitter); 100 * 2^1 = 200 (+0..49 jitter).
    expect(sleeps[0]).toBeGreaterThanOrEqual(100);
    expect(sleeps[0]).toBeLessThan(150);
    expect(sleeps[1]).toBeGreaterThanOrEqual(200);
    expect(sleeps[1]).toBeLessThan(250);
  });
});

// ── Model constant pin (PR change: DEFAULT_ANTHROPIC_MODEL_CLASSIFY) ─────────
//
// PR pinned the Haiku classification model to a date-stamped snapshot
// ("claude-haiku-4-5-20251001") so deployments aren't silently rolled
// forward if Anthropic deprecates the generic "claude-haiku-4-5" alias.
describe("model constant pins", () => {
  it("DEFAULT_ANTHROPIC_MODEL_CLASSIFY is pinned to a date-stamped snapshot", () => {
    // Must include a date stamp (YYYYMMDD suffix) — generic aliases
    // like "claude-haiku-4-5" are not acceptable.
    expect(DEFAULT_ANTHROPIC_MODEL_CLASSIFY).toMatch(/-\d{8}$/);
  });

  it("DEFAULT_ANTHROPIC_MODEL_CLASSIFY starts with 'claude-haiku'", () => {
    expect(DEFAULT_ANTHROPIC_MODEL_CLASSIFY).toMatch(/^claude-haiku/);
  });

  it("DEFAULT_ANTHROPIC_MODEL_CLASSIFY equals the pinned snapshot value", () => {
    // Regression guard: changing this requires an intentional code edit.
    expect(DEFAULT_ANTHROPIC_MODEL_CLASSIFY).toBe("claude-haiku-4-5-20251001");
  });

  it("DEFAULT_ANTHROPIC_MODEL_CLASSIFY differs from the unpinned alias", () => {
    // The unpinned alias would roll forward silently on Anthropic deprecation.
    expect(DEFAULT_ANTHROPIC_MODEL_CLASSIFY).not.toBe("claude-haiku-4-5");
  });

  it("DEFAULT_ANTHROPIC_MODEL_CHAT is defined and non-empty", () => {
    expect(typeof DEFAULT_ANTHROPIC_MODEL_CHAT).toBe("string");
    expect(DEFAULT_ANTHROPIC_MODEL_CHAT.length).toBeGreaterThan(0);
  });

  it("DEFAULT_ANTHROPIC_MODEL_REASONING is defined and non-empty", () => {
    expect(typeof DEFAULT_ANTHROPIC_MODEL_REASONING).toBe("string");
    expect(DEFAULT_ANTHROPIC_MODEL_REASONING.length).toBeGreaterThan(0);
  });
});
