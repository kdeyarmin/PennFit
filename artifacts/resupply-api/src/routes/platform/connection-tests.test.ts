// Route tests for /platform/connection-tests — HTTP contract (gating,
// validation, response shape). The runner logic is covered by
// lib/connection-tests/runners.test.ts and mocked here.

import { describe, it, expect, vi, beforeEach } from "vitest";
import express, { type Express } from "express";
import request from "supertest";

import {
  makeRequirePlatformAdminMock,
  type MockPlatformAdminRef,
} from "../../test-helpers/auth-mocks";

const { mockPlatformAdmin } = vi.hoisted(() => ({
  mockPlatformAdmin: { current: null } as MockPlatformAdminRef,
}));
vi.mock("../../middlewares/requirePlatformAdmin", () =>
  makeRequirePlatformAdminMock(mockPlatformAdmin),
);

// getEffectiveEnv would otherwise hit Supabase; pin it to a fixed env.
vi.mock("../../lib/app-config/store", () => ({
  getEffectiveEnv: vi.fn().mockResolvedValue({ MARK: "effective" }),
}));

const runners = vi.hoisted(() => ({
  runEmailTest: vi.fn(),
  runSmsTest: vi.fn(),
  runVoiceTest: vi.fn(),
  runChatTest: vi.fn(),
  computeConnectionTestStatus: vi.fn(),
}));
vi.mock("../../lib/connection-tests/runners", () => runners);

import platformConnectionTestsRouter from "./connection-tests";

function makeApp(): Express {
  const app = express();
  app.use(express.json());
  app.use(platformConnectionTestsRouter);
  return app;
}

function asPlatformAdmin() {
  mockPlatformAdmin.current = { userId: "u_platform", email: "ops@cm" };
}

beforeEach(() => {
  mockPlatformAdmin.current = null;
  for (const fn of Object.values(runners)) fn.mockReset();
});

describe("auth gating", () => {
  it("401 when the caller is not a platform admin", async () => {
    const res = await request(makeApp())
      .post("/platform/connection-tests/email")
      .send({ to: "a@b.com" });
    expect(res.status).toBe(401);
    expect(runners.runEmailTest).not.toHaveBeenCalled();
  });
});

describe("validation", () => {
  beforeEach(asPlatformAdmin);

  it("400 on a malformed email", async () => {
    const res = await request(makeApp())
      .post("/platform/connection-tests/email")
      .send({ to: "not-an-email" });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_body");
    expect(runners.runEmailTest).not.toHaveBeenCalled();
  });

  it("400 with an issue message on an unparseable phone for sms", async () => {
    const res = await request(makeApp())
      .post("/platform/connection-tests/sms")
      .send({ to: "not-a-number" });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_body");
    expect(res.body.issues?.[0]?.message).toMatch(/valid phone number/i);
    expect(runners.runSmsTest).not.toHaveBeenCalled();
  });

  it("normalizes a bare NANP number to E.164 before running the sms test", async () => {
    runners.runSmsTest.mockResolvedValue({
      ok: true,
      channel: "sms",
      detail: { messageSid: "sm_1" },
    });
    const res = await request(makeApp())
      .post("/platform/connection-tests/sms")
      .send({ to: "8142418865" });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, channel: "sms" });
    expect(runners.runSmsTest).toHaveBeenCalledWith(
      { MARK: "effective" },
      { to: "+18142418865" },
    );
  });

  it("normalizes a punctuated number to E.164 for the voice test", async () => {
    runners.runVoiceTest.mockResolvedValue({
      ok: true,
      channel: "voice",
      detail: { callSid: "ca_1" },
    });
    const res = await request(makeApp())
      .post("/platform/connection-tests/voice")
      .send({ to: "(215) 555-1212" });
    expect(res.status).toBe(200);
    expect(runners.runVoiceTest).toHaveBeenCalledWith(
      { MARK: "effective" },
      { to: "+12155551212" },
    );
  });
});

describe("happy paths", () => {
  beforeEach(asPlatformAdmin);

  it("returns the email runner result as 200 against the effective env", async () => {
    runners.runEmailTest.mockResolvedValue({
      ok: true,
      channel: "email",
      detail: { messageId: "msg_1" },
    });
    const res = await request(makeApp())
      .post("/platform/connection-tests/email")
      .send({ to: "ops@example.com" });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, channel: "email" });
    expect(runners.runEmailTest).toHaveBeenCalledWith(
      { MARK: "effective" },
      { to: "ops@example.com" },
    );
  });

  it("returns a failed test as 200 with ok:false (not an HTTP error)", async () => {
    runners.runSmsTest.mockResolvedValue({
      ok: false,
      channel: "sms",
      code: "upstream_error",
      message: "bad number",
    });
    const res = await request(makeApp())
      .post("/platform/connection-tests/sms")
      .send({ to: "+12155551212" });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: false, code: "upstream_error" });
  });

  it("chat takes no body and pings the provider", async () => {
    runners.runChatTest.mockResolvedValue({
      ok: true,
      channel: "chat",
      detail: { provider: "anthropic", reply: "OK" },
    });
    const res = await request(makeApp())
      .post("/platform/connection-tests/chat")
      .send({});
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      ok: true,
      detail: { provider: "anthropic" },
    });
    expect(runners.runChatTest).toHaveBeenCalledWith({ MARK: "effective" });
  });

  it("status endpoint returns the computed status", async () => {
    runners.computeConnectionTestStatus.mockReturnValue({
      email: { configured: true },
      sms: { configured: false },
      voice: { configured: false },
      chat: { configured: true, provider: "anthropic" },
    });
    const res = await request(makeApp()).get(
      "/platform/connection-tests/status",
    );
    expect(res.status).toBe(200);
    expect(res.body.email.configured).toBe(true);
    expect(res.body.chat.provider).toBe("anthropic");
  });
});
