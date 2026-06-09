// Route tests for /admin/bot-playground.
//
// Coverage:
//   * 401 without an admin session
//   * 403 when the caller lacks admin.tools.manage
//   * GET /info returns provider + scenario catalog
//   * GET /prompt renders a system prompt
//   * POST /run validates the body (400s) and returns the offline
//     result when no LLM key is configured (no network needed)

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import express, { type Express } from "express";
import request from "supertest";

import {
  makeRequireAdminMock,
  type MockAdminCtx,
} from "../../test-helpers/auth-mocks";
import { __resetLlmProviderCacheForTests } from "../../lib/llm-provider";

const { mockAdmin } = vi.hoisted(() => ({
  mockAdmin: { current: null as MockAdminCtx | null },
}));
vi.mock("../../middlewares/requireAdmin", () =>
  makeRequireAdminMock(mockAdmin),
);

// Control the voice.agent feature flag the voice-call route checks
// before dialing. Defaults to enabled; the disabled test flips it.
const { voiceAgentEnabled } = vi.hoisted(() => ({
  voiceAgentEnabled: { value: true },
}));
vi.mock("../../lib/feature-flags", () => ({
  isFeatureEnabled: vi.fn(async () => voiceAgentEnabled.value),
}));

const placeCallMock = vi.fn();
vi.mock("@workspace/resupply-telecom", async () => {
  const actual = await vi.importActual<
    typeof import("@workspace/resupply-telecom")
  >("@workspace/resupply-telecom");
  return {
    ...actual,
    createTwilioClient: vi.fn(() => ({ placeCall: placeCallMock })),
  };
});

import botPlaygroundRouter from "./bot-playground";
import { __resetPendingSessionsForTests } from "../../lib/voice/pending-sessions";

function makeApp(): Express {
  const app = express();
  app.use(express.json());
  app.use(botPlaygroundRouter);
  return app;
}

const ADMIN: MockAdminCtx = {
  userId: "u_admin",
  email: "admin@pennpaps.com",
  role: "admin",
};

const VOICE_ENV_KEYS = [
  "OPENAI_API_KEY",
  "ANTHROPIC_API_KEY",
  "TWILIO_ACCOUNT_SID",
  "TWILIO_AUTH_TOKEN",
  "TWILIO_PHONE_NUMBER",
  "RESUPPLY_VOICE_PUBLIC_BASE_URL",
] as const;
const savedEnv: Record<string, string | undefined> = {};
for (const k of VOICE_ENV_KEYS) savedEnv[k] = process.env[k];

function setVoiceConfigured(): void {
  process.env.OPENAI_API_KEY = "sk-test";
  process.env.TWILIO_ACCOUNT_SID = "AC_test";
  process.env.TWILIO_AUTH_TOKEN = "tok_test";
  process.env.TWILIO_PHONE_NUMBER = "+18145550000";
  process.env.RESUPPLY_VOICE_PUBLIC_BASE_URL = "https://test.pennpaps.com";
}

beforeEach(() => {
  mockAdmin.current = null;
  voiceAgentEnabled.value = true;
  for (const k of VOICE_ENV_KEYS) delete process.env[k];
  placeCallMock.mockReset();
  __resetLlmProviderCacheForTests();
  __resetPendingSessionsForTests();
});

afterEach(() => {
  for (const k of VOICE_ENV_KEYS) {
    if (savedEnv[k] !== undefined) process.env[k] = savedEnv[k];
    else delete process.env[k];
  }
  __resetLlmProviderCacheForTests();
  __resetPendingSessionsForTests();
});

describe("/admin/bot-playground", () => {
  it("401s without an admin session", async () => {
    const res = await request(makeApp()).get("/admin/bot-playground/info");
    expect(res.status).toBe(401);
  });

  it("403s when the caller lacks admin.tools.manage", async () => {
    mockAdmin.current = { ...ADMIN, role: "agent", granularRole: "csr" };
    const res = await request(makeApp()).get("/admin/bot-playground/info");
    expect(res.status).toBe(403);
    expect(res.body.requiredPermission).toBe("admin.tools.manage");
  });

  it("GET /info returns the provider and scenario catalog", async () => {
    mockAdmin.current = ADMIN;
    const res = await request(makeApp()).get("/admin/bot-playground/info");
    expect(res.status).toBe(200);
    expect(res.body.provider).toBe("offline");
    expect(Array.isArray(res.body.scenarios)).toBe(true);
    expect(res.body.scenarios.length).toBeGreaterThan(0);
    const bots = new Set(
      (res.body.scenarios as Array<{ bot: string }>).map((s) => s.bot),
    );
    expect(bots.has("storefront")).toBe(true);
    expect(bots.has("account")).toBe(true);
    expect(bots.has("voice")).toBe(true);
  });

  it("GET /prompt renders a system prompt", async () => {
    mockAdmin.current = ADMIN;
    const res = await request(makeApp()).get(
      "/admin/bot-playground/prompt?bot=storefront",
    );
    expect(res.status).toBe(200);
    expect(res.body.bot).toBe("storefront");
    expect(typeof res.body.systemPrompt).toBe("string");
    expect(res.body.chars).toBeGreaterThan(0);
  });

  it("GET /prompt 400s on an unknown bot", async () => {
    mockAdmin.current = ADMIN;
    const res = await request(makeApp()).get(
      "/admin/bot-playground/prompt?bot=nope",
    );
    expect(res.status).toBe(400);
  });

  it("POST /run 400s on an empty messages array", async () => {
    mockAdmin.current = ADMIN;
    const res = await request(makeApp())
      .post("/admin/bot-playground/run")
      .send({ bot: "storefront", messages: [] });
    expect(res.status).toBe(400);
  });

  it("POST /run 400s when the last message is not from the user", async () => {
    mockAdmin.current = ADMIN;
    const res = await request(makeApp())
      .post("/admin/bot-playground/run")
      .send({
        bot: "account",
        messages: [
          { role: "user", content: "hi" },
          { role: "assistant", content: "hello" },
        ],
      });
    expect(res.status).toBe(400);
  });

  it("POST /run returns the offline result when no LLM key is set", async () => {
    mockAdmin.current = ADMIN;
    const res = await request(makeApp())
      .post("/admin/bot-playground/run")
      .send({ bot: "voice", messages: [{ role: "user", content: "hello?" }] });
    expect(res.status).toBe(200);
    expect(res.body.offline).toBe(true);
    expect(res.body.provider).toBe("offline");
    expect(typeof res.body.reply).toBe("string");
  });

  describe("POST /voice-call", () => {
    it("503s when voice is not configured", async () => {
      mockAdmin.current = ADMIN;
      const res = await request(makeApp())
        .post("/admin/bot-playground/voice-call")
        .send({ to: "+18145551212" });
      expect(res.status).toBe(503);
      expect(res.body.error).toBe("voice_not_configured");
      expect(placeCallMock).not.toHaveBeenCalled();
    });

    it("400s on an invalid phone number", async () => {
      mockAdmin.current = ADMIN;
      setVoiceConfigured();
      const res = await request(makeApp())
        .post("/admin/bot-playground/voice-call")
        .send({ to: "12" });
      expect(res.status).toBe(400);
      expect(placeCallMock).not.toHaveBeenCalled();
    });

    it("403s without admin.tools.manage", async () => {
      mockAdmin.current = { ...ADMIN, role: "agent", granularRole: "csr" };
      setVoiceConfigured();
      const res = await request(makeApp())
        .post("/admin/bot-playground/voice-call")
        .send({ to: "+18145551212" });
      expect(res.status).toBe(403);
      expect(placeCallMock).not.toHaveBeenCalled();
    });

    it("503s when the voice agent is disabled in Control Center", async () => {
      mockAdmin.current = ADMIN;
      setVoiceConfigured();
      voiceAgentEnabled.value = false;
      const res = await request(makeApp())
        .post("/admin/bot-playground/voice-call")
        .send({ to: "+18145551212" });
      expect(res.status).toBe(503);
      expect(res.body.error).toBe("voice_agent_disabled");
      // Must NOT place (and bill) a call when the agent is off.
      expect(placeCallMock).not.toHaveBeenCalled();
    });

    it("places a diagnostic call and returns the call sid", async () => {
      mockAdmin.current = ADMIN;
      setVoiceConfigured();
      placeCallMock.mockResolvedValueOnce({ sid: "CA_test_123" });

      const res = await request(makeApp())
        .post("/admin/bot-playground/voice-call")
        .send({ to: "(814) 555-1212", scenarioId: "voice-shop" });

      expect(res.status).toBe(201);
      expect(res.body.callSid).toBe("CA_test_123");
      expect(res.body.callerKind).toBe("shop_customer");
      expect(typeof res.body.conversationId).toBe("string");
      expect(placeCallMock).toHaveBeenCalledTimes(1);
      const arg = placeCallMock.mock.calls[0][0] as {
        to: string;
        from: string;
        url: string;
        statusCallbackUrl?: string;
      };
      // Phone normalized to E.164.
      expect(arg.to).toBe("+18145551212");
      // TwiML points at the existing connect webhook with our conversationId.
      expect(arg.url).toContain("/voice/twiml-connect?conversationId=");
      // No status callback on a diagnostic call (no conversations row → FK).
      expect(arg.statusCallbackUrl).toBeUndefined();
    });

    it("502s when Twilio rejects the call", async () => {
      mockAdmin.current = ADMIN;
      setVoiceConfigured();
      const { TwilioApiError } = await import("@workspace/resupply-telecom");
      placeCallMock.mockRejectedValueOnce(
        new TwilioApiError("rejected", 400, 21211),
      );
      const res = await request(makeApp())
        .post("/admin/bot-playground/voice-call")
        .send({ to: "+18145551212" });
      expect(res.status).toBe(502);
      expect(res.body.error).toBe("twilio_api_error");
    });
  });
});
