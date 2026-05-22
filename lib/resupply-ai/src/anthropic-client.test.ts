import { describe, expect, it } from "vitest";

import {
  createAnthropicClient,
  DEFAULT_ANTHROPIC_MODEL_CHAT,
  getResponseText,
  getResponseToolCalls,
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
