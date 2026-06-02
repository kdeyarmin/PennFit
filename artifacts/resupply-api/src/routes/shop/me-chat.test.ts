// Route tests for POST /shop/me/chat.
//
// Coverage:
//   * 401 without sign-in
//   * 400 on invalid body (empty messages)
//   * 400 on body with base64 image data URL (defence-in-depth)
//   * 400 when last message is not from the user
//   * Offline fallback (200) when no LLM key is set, JSON mode
//   * Offline fallback (SSE) when no LLM key is set and Accept: event-stream
//   * Claude path (JSON) when ANTHROPIC_API_KEY is set — the account
//     assistant now goes Claude-first like the storefront chatbot.
//
// We don't exercise the live OpenAI streaming path here — the offline
// fallback paths cover the critical "no key, don't crash" surface,
// and the streaming flow is large enough to deserve its own suite.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import express, { type Express } from "express";
import request from "supertest";

import { makeRequireSignedInMock } from "../../test-helpers/auth-mocks";
import { installSupabaseMock } from "../../test-helpers/supabase-mock";
import { __resetLlmProviderCacheForTests } from "../../lib/llm-provider";

installSupabaseMock();

const { mockSignedIn } = vi.hoisted(() => ({
  mockSignedIn: { current: null as string | null },
}));
vi.mock("../../middlewares/requireSignedIn", () =>
  makeRequireSignedInMock(mockSignedIn),
);

import chatRouter from "./me-chat";

function makeApp(): Express {
  const app = express();
  app.use(express.json());
  app.use(chatRouter);
  return app;
}

const originalOpenAiKey = process.env.OPENAI_API_KEY;
const originalAnthropicKey = process.env.ANTHROPIC_API_KEY;

beforeEach(() => {
  mockSignedIn.current = null;
  // Both keys cleared so the "offline" branch is deterministic
  // regardless of what the CI environment exports. Individual tests
  // opt back into a provider by setting its key.
  delete process.env.OPENAI_API_KEY;
  delete process.env.ANTHROPIC_API_KEY;
  __resetLlmProviderCacheForTests();
  vi.unstubAllGlobals();
});

afterEach(() => {
  if (originalOpenAiKey !== undefined) {
    process.env.OPENAI_API_KEY = originalOpenAiKey;
  }
  if (originalAnthropicKey !== undefined) {
    process.env.ANTHROPIC_API_KEY = originalAnthropicKey;
  } else {
    delete process.env.ANTHROPIC_API_KEY;
  }
  __resetLlmProviderCacheForTests();
  vi.unstubAllGlobals();
});

describe("POST /shop/me/chat", () => {
  it("401s without sign-in", async () => {
    const res = await request(makeApp())
      .post("/shop/me/chat")
      .send({ messages: [{ role: "user", content: "hi" }] });
    expect(res.status).toBe(401);
  });

  it("400s on empty messages", async () => {
    mockSignedIn.current = "cust_1";
    const res = await request(makeApp())
      .post("/shop/me/chat")
      .send({ messages: [] });
    expect(res.status).toBe(400);
  });

  it("400s on body containing a base64 data URL", async () => {
    mockSignedIn.current = "cust_1";
    process.env.OPENAI_API_KEY = "sk-test";
    const res = await request(makeApp())
      .post("/shop/me/chat")
      .send({
        messages: [
          {
            role: "user",
            content: "Look at this data:image/png;base64,iVBORw0KGgo",
          },
        ],
      });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/binary|encoded/);
  });

  it("400s when the last message is not from the user", async () => {
    mockSignedIn.current = "cust_1";
    process.env.OPENAI_API_KEY = "sk-test";
    const res = await request(makeApp())
      .post("/shop/me/chat")
      .send({
        messages: [
          { role: "user", content: "hi" },
          { role: "assistant", content: "hello" },
        ],
      });
    expect(res.status).toBe(400);
  });

  it("returns offline JSON fallback when OPENAI_API_KEY unset", async () => {
    mockSignedIn.current = "cust_1";
    const res = await request(makeApp())
      .post("/shop/me/chat")
      .send({ messages: [{ role: "user", content: "hi" }] });
    expect(res.status).toBe(200);
    expect(res.body.offline).toBe(true);
    expect(typeof res.body.reply).toBe("string");
    expect(res.body.reply.length).toBeGreaterThan(0);
  });

  it("returns offline SSE fallback when no LLM key set and Accept: event-stream", async () => {
    mockSignedIn.current = "cust_1";
    const res = await request(makeApp())
      .post("/shop/me/chat")
      .set("Accept", "text/event-stream")
      .send({ messages: [{ role: "user", content: "hi" }] });
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toContain("text/event-stream");
    expect(res.text).toContain("data:");
    expect(res.text).toContain('"offline":true');
  });

  it("uses the Claude path (JSON) when ANTHROPIC_API_KEY is set", async () => {
    mockSignedIn.current = "cust_1";
    process.env.ANTHROPIC_API_KEY = "sk-ant-test";
    __resetLlmProviderCacheForTests();

    // Stub global fetch so the Anthropic Messages client returns a
    // single text block with no tool_use (one round, immediate reply).
    const fetchMock = vi.fn(async (url: string | URL | Request) => {
      const target = typeof url === "string" ? url : url.toString();
      expect(target).toContain("api.anthropic.com");
      return new Response(
        JSON.stringify({
          id: "msg_test",
          type: "message",
          role: "assistant",
          model: "claude-sonnet-4-6",
          content: [
            { type: "text", text: "Your most recent order has shipped." },
          ],
          stop_reason: "end_turn",
          usage: { input_tokens: 12, output_tokens: 8 },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    });
    vi.stubGlobal("fetch", fetchMock);

    const res = await request(makeApp())
      .post("/shop/me/chat")
      .send({ messages: [{ role: "user", content: "where is my order?" }] });

    expect(res.status).toBe(200);
    expect(res.body.offline).toBeUndefined();
    expect(res.body.degraded).toBeUndefined();
    expect(res.body.reply).toBe("Your most recent order has shipped.");
    expect(fetchMock).toHaveBeenCalled();
  });
});
