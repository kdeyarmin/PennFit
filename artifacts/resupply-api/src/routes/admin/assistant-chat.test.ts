// Route tests for POST /admin/assistant/chat (PennPilot).
//
// Coverage:
//   * 401 without an admin session
//   * 400 on invalid body / base64 blob / non-user last message
//   * Offline fallback (JSON + SSE) when no LLM key is set
//   * Feature-flag OFF returns an "offline" reply, no model call
//   * Claude path (JSON) when ANTHROPIC_API_KEY is set
//   * OpenAI JSON path via the test fetch override

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import express, { type Express } from "express";
import request from "supertest";

import { makeRequireAdminMock } from "../../test-helpers/auth-mocks";
import { installSupabaseMock } from "../../test-helpers/supabase-mock";
import { __resetLlmProviderCacheForTests } from "../../lib/llm-provider";

installSupabaseMock();

const { mockAdmin } = vi.hoisted(() => ({
  mockAdmin: {
    current: null as null | {
      userId: string;
      email: string;
      role: "admin" | "agent";
    },
  },
}));
vi.mock("../../middlewares/requireAdmin", () =>
  makeRequireAdminMock(mockAdmin),
);

const { flagEnabled } = vi.hoisted(() => ({
  flagEnabled: { value: true },
}));
vi.mock("../../lib/feature-flags", () => ({
  isFeatureEnabled: vi.fn(async () => flagEnabled.value),
}));

import chatRouter, { __setAdminAssistantFetchForTests } from "./assistant-chat";

function makeApp(): Express {
  const app = express();
  app.use(express.json());
  app.use(chatRouter);
  return app;
}

const originalOpenAiKey = process.env.OPENAI_API_KEY;
const originalAnthropicKey = process.env.ANTHROPIC_API_KEY;

beforeEach(() => {
  mockAdmin.current = null;
  flagEnabled.value = true;
  delete process.env.OPENAI_API_KEY;
  delete process.env.ANTHROPIC_API_KEY;
  __resetLlmProviderCacheForTests();
  __setAdminAssistantFetchForTests(undefined);
  vi.unstubAllGlobals();
});

afterEach(() => {
  if (originalOpenAiKey !== undefined)
    process.env.OPENAI_API_KEY = originalOpenAiKey;
  if (originalAnthropicKey !== undefined)
    process.env.ANTHROPIC_API_KEY = originalAnthropicKey;
  else delete process.env.ANTHROPIC_API_KEY;
  __resetLlmProviderCacheForTests();
  __setAdminAssistantFetchForTests(undefined);
  vi.unstubAllGlobals();
});

describe("POST /admin/assistant/chat", () => {
  it("401s without an admin session", async () => {
    const res = await request(makeApp())
      .post("/admin/assistant/chat")
      .send({ messages: [{ role: "user", content: "hi" }] });
    expect(res.status).toBe(401);
  });

  it("400s on empty messages", async () => {
    mockAdmin.current = {
      userId: "u1",
      email: "a@pennpaps.com",
      role: "admin",
    };
    const res = await request(makeApp())
      .post("/admin/assistant/chat")
      .send({ messages: [] });
    expect(res.status).toBe(400);
  });

  it("400s on a base64 data URL in the body", async () => {
    mockAdmin.current = {
      userId: "u1",
      email: "a@pennpaps.com",
      role: "admin",
    };
    process.env.OPENAI_API_KEY = "sk-test";
    const res = await request(makeApp())
      .post("/admin/assistant/chat")
      .send({
        messages: [
          { role: "user", content: "look data:image/png;base64,iVBORw0KGgo" },
        ],
      });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/binary|encoded/);
  });

  it("400s when the last message is not from the user", async () => {
    mockAdmin.current = {
      userId: "u1",
      email: "a@pennpaps.com",
      role: "admin",
    };
    process.env.OPENAI_API_KEY = "sk-test";
    const res = await request(makeApp())
      .post("/admin/assistant/chat")
      .send({
        messages: [
          { role: "user", content: "hi" },
          { role: "assistant", content: "hello" },
        ],
      });
    expect(res.status).toBe(400);
  });

  it("returns an offline JSON fallback when no LLM key is set", async () => {
    mockAdmin.current = {
      userId: "u1",
      email: "a@pennpaps.com",
      role: "admin",
    };
    const res = await request(makeApp())
      .post("/admin/assistant/chat")
      .send({
        messages: [{ role: "user", content: "how do I work a claim?" }],
      });
    expect(res.status).toBe(200);
    expect(res.body.offline).toBe(true);
    expect(typeof res.body.reply).toBe("string");
    expect(res.body.reply.length).toBeGreaterThan(0);
  });

  it("returns an offline SSE fallback for Accept: event-stream", async () => {
    mockAdmin.current = {
      userId: "u1",
      email: "a@pennpaps.com",
      role: "admin",
    };
    const res = await request(makeApp())
      .post("/admin/assistant/chat")
      .set("Accept", "text/event-stream")
      .send({ messages: [{ role: "user", content: "hi" }] });
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toContain("text/event-stream");
    expect(res.text).toContain('"offline":true');
  });

  it("returns an 'offline' reply (no model call) when the flag is OFF", async () => {
    mockAdmin.current = {
      userId: "u1",
      email: "a@pennpaps.com",
      role: "admin",
    };
    process.env.OPENAI_API_KEY = "sk-test";
    flagEnabled.value = false;
    const fetchMock = vi.fn();
    __setAdminAssistantFetchForTests(fetchMock as unknown as typeof fetch);

    const res = await request(makeApp())
      .post("/admin/assistant/chat")
      .send({ messages: [{ role: "user", content: "hi" }] });

    expect(res.status).toBe(200);
    expect(res.body.offline).toBe(true);
    expect(res.body.reply).toMatch(/turned off|Control Center/i);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("uses the Claude path (JSON) when ANTHROPIC_API_KEY is set", async () => {
    mockAdmin.current = {
      userId: "u1",
      email: "a@pennpaps.com",
      role: "admin",
    };
    process.env.ANTHROPIC_API_KEY = "sk-ant-test";
    __resetLlmProviderCacheForTests();

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
            { type: "text", text: "Patients live under /admin/patients." },
          ],
          stop_reason: "end_turn",
          usage: { input_tokens: 10, output_tokens: 6 },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    });
    vi.stubGlobal("fetch", fetchMock);

    const res = await request(makeApp())
      .post("/admin/assistant/chat")
      .send({ messages: [{ role: "user", content: "where are patients?" }] });

    expect(res.status).toBe(200);
    expect(res.body.offline).toBeUndefined();
    expect(res.body.degraded).toBeUndefined();
    expect(res.body.reply).toBe("Patients live under /admin/patients.");
    expect(fetchMock).toHaveBeenCalled();
  });

  it("answers via the OpenAI JSON path using the fetch override", async () => {
    mockAdmin.current = {
      userId: "u1",
      email: "a@pennpaps.com",
      role: "admin",
    };
    process.env.OPENAI_API_KEY = "sk-test";
    __resetLlmProviderCacheForTests();

    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            choices: [
              {
                message: { content: "Feature flags live in Control Center." },
                finish_reason: "stop",
              },
            ],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
    );
    __setAdminAssistantFetchForTests(fetchMock as unknown as typeof fetch);

    const res = await request(makeApp())
      .post("/admin/assistant/chat")
      .send({
        messages: [{ role: "user", content: "where are feature flags?" }],
      });

    expect(res.status).toBe(200);
    expect(res.body.reply).toBe("Feature flags live in Control Center.");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
