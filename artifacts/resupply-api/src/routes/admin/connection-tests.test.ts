// Route tests for /admin/connection-tests — focuses on the HTTP
// contract (gating, validation, response shape). The runner logic is
// covered by lib/connection-tests/runners.test.ts and mocked here.

import { describe, it, expect, vi, beforeEach } from "vitest";
import express, { type Express } from "express";
import request from "supertest";

import {
  makeRequireAdminMock,
  type MockAdminCtx,
} from "../../test-helpers/auth-mocks";

const { mockAdmin } = vi.hoisted(() => ({
  mockAdmin: { current: null as MockAdminCtx | null },
}));
vi.mock("../../middlewares/requireAdmin", () => makeRequireAdminMock(mockAdmin));

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

import connectionTestsRouter from "./connection-tests";

function makeApp(): Express {
  const app = express();
  app.use(express.json());
  app.use(connectionTestsRouter);
  return app;
}

function asSuperAdmin() {
  // granularRole "admin" → super_admin → holds system.config.manage.
  mockAdmin.current = {
    userId: "u1",
    email: "boss@pennpaps.com",
    role: "admin",
    granularRole: "admin",
  };
}

beforeEach(() => {
  mockAdmin.current = null;
  for (const fn of Object.values(runners)) fn.mockReset();
});

describe("auth gating", () => {
  it("401 when not signed in", async () => {
    const res = await request(makeApp())
      .post("/admin/connection-tests/email")
      .send({ to: "a@b.com" });
    expect(res.status).toBe(401);
  });

  it("403 for a non-super-admin (CSR)", async () => {
    mockAdmin.current = {
      userId: "u2",
      email: "csr@pennpaps.com",
      role: "agent",
      granularRole: "csr",
    };
    const res = await request(makeApp())
      .post("/admin/connection-tests/email")
      .send({ to: "a@b.com" });
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({
      error: "permission_denied",
      requiredPermission: "system.config.manage",
    });
    expect(runners.runEmailTest).not.toHaveBeenCalled();
  });
});

describe("validation", () => {
  beforeEach(asSuperAdmin);

  it("400 on a malformed email", async () => {
    const res = await request(makeApp())
      .post("/admin/connection-tests/email")
      .send({ to: "not-an-email" });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_body");
    expect(runners.runEmailTest).not.toHaveBeenCalled();
  });

  it("400 on a non-E.164 phone for sms", async () => {
    const res = await request(makeApp())
      .post("/admin/connection-tests/sms")
      .send({ to: "2155551212" });
    expect(res.status).toBe(400);
    expect(runners.runSmsTest).not.toHaveBeenCalled();
  });
});

describe("happy paths", () => {
  beforeEach(asSuperAdmin);

  it("returns the email runner result as 200", async () => {
    runners.runEmailTest.mockResolvedValue({
      ok: true,
      channel: "email",
      detail: { messageId: "msg_1" },
    });
    const res = await request(makeApp())
      .post("/admin/connection-tests/email")
      .send({ to: "ops@pennpaps.com" });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, channel: "email" });
    // Runs against the effective env (saved overlay + process.env).
    expect(runners.runEmailTest).toHaveBeenCalledWith(
      { MARK: "effective" },
      { to: "ops@pennpaps.com" },
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
      .post("/admin/connection-tests/sms")
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
    const res = await request(makeApp()).post("/admin/connection-tests/chat").send({});
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, detail: { provider: "anthropic" } });
    expect(runners.runChatTest).toHaveBeenCalledWith({ MARK: "effective" });
  });

  it("status endpoint returns the computed status", async () => {
    runners.computeConnectionTestStatus.mockReturnValue({
      email: { configured: true },
      sms: { configured: false },
      voice: { configured: false },
      chat: { configured: true, provider: "anthropic" },
    });
    const res = await request(makeApp()).get("/admin/connection-tests/status");
    expect(res.status).toBe(200);
    expect(res.body.email.configured).toBe(true);
    expect(res.body.chat.provider).toBe("anthropic");
  });
});
