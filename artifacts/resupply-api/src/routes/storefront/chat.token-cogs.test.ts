import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import express from "express";
import request from "supertest";

// Spy on the metering chokepoint so we can assert the chat route folds each
// LLM call's token usage into the per-tenant AI-COGS rollup. Both exports are
// replaced (the route also records the interaction counter via
// recordTenantUsage) so the mocked module is import-complete. vi.hoisted lets
// the spies exist before the hoisted vi.mock factory runs.
const { recordAiTokenUsage, recordTenantUsage } = vi.hoisted(() => ({
  recordAiTokenUsage: vi.fn(),
  recordTenantUsage: vi.fn(),
}));
vi.mock("../../lib/metering/usage.js", () => ({
  recordAiTokenUsage,
  recordTenantUsage,
}));

import chatRouter, { __setChatFetchForTests } from "./chat";
import { __resetLlmBreakersForTests } from "../../lib/llm-circuit-breaker";
import { resetChatBudgetForTests } from "../../lib/storefront/chat-budget";
import { __resetRateLimitsForTests } from "../../middlewares/rate-limit";

function makeApp(): express.Express {
  const app = express();
  app.use(express.json());
  app.use(chatRouter);
  return app;
}

function makeStreamBody(chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  let i = 0;
  return new ReadableStream({
    pull(controller) {
      if (i < chunks.length) {
        controller.enqueue(encoder.encode(chunks[i]!));
        i += 1;
      } else {
        controller.close();
      }
    },
  });
}

describe("chat route — AI token COGS capture", () => {
  const originalKey = process.env.OPENAI_API_KEY;

  beforeEach(() => {
    process.env.OPENAI_API_KEY = "test-openai-key";
    __resetLlmBreakersForTests();
    __resetRateLimitsForTests();
    resetChatBudgetForTests();
    recordAiTokenUsage.mockClear();
    recordTenantUsage.mockClear();
  });

  afterEach(() => {
    if (originalKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = originalKey;
    __setChatFetchForTests(undefined);
    vi.restoreAllMocks();
  });

  it("records token usage from the non-streaming OpenAI response", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        choices: [{ message: { content: "We carry several styles." } }],
        usage: { prompt_tokens: 80, completion_tokens: 20 },
      }),
      text: async () => "",
    });
    __setChatFetchForTests(fetchMock as unknown as typeof fetch);

    const res = await request(makeApp())
      .post("/chat")
      .send({ messages: [{ role: "user", content: "What styles?" }] });

    expect(res.status).toBe(200);
    expect(recordAiTokenUsage).toHaveBeenCalledWith(
      expect.objectContaining({
        inputTokens: 80,
        outputTokens: 20,
        source: "storefront.chat",
      }),
    );
  });

  it("records token usage from the streaming include_usage final chunk", async () => {
    const sseBody = [
      'data: {"choices":[{"delta":{"content":"Hi "}}]}\n\n',
      'data: {"choices":[{"delta":{"content":"there."}}]}\n\n',
      // include_usage emits a final usage-only chunk with empty choices.
      'data: {"choices":[],"usage":{"prompt_tokens":120,"completion_tokens":45}}\n\n',
      "data: [DONE]\n\n",
    ];
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      body: makeStreamBody(sseBody),
      text: async () => "",
    });
    __setChatFetchForTests(fetchMock as unknown as typeof fetch);

    const res = await request(makeApp())
      .post("/chat")
      .set("Accept", "text/event-stream")
      .send({ messages: [{ role: "user", content: "What styles?" }] });

    expect(res.status).toBe(200);
    // The request must opt into the usage-only final chunk.
    const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
    const payload = JSON.parse(init.body as string);
    expect(payload.stream_options).toEqual({ include_usage: true });
    expect(recordAiTokenUsage).toHaveBeenCalledWith(
      expect.objectContaining({
        inputTokens: 120,
        outputTokens: 45,
        source: "storefront.chat",
      }),
    );
  });
});
