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

import botPlaygroundRouter from "./bot-playground";

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

const originalOpenAi = process.env.OPENAI_API_KEY;
const originalAnthropic = process.env.ANTHROPIC_API_KEY;

beforeEach(() => {
  mockAdmin.current = null;
  delete process.env.OPENAI_API_KEY;
  delete process.env.ANTHROPIC_API_KEY;
  __resetLlmProviderCacheForTests();
});

afterEach(() => {
  if (originalOpenAi !== undefined) process.env.OPENAI_API_KEY = originalOpenAi;
  if (originalAnthropic !== undefined)
    process.env.ANTHROPIC_API_KEY = originalAnthropic;
  __resetLlmProviderCacheForTests();
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
});
