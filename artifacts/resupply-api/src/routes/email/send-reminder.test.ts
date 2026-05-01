// Route tests for POST /email/send-reminder.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import express, { type Express } from "express";
import request from "supertest";

import {
  makeRequireAdminMock,
  type MockAdminCtx,
} from "../../test-helpers/auth-mocks";

const { mockAdmin } = vi.hoisted(() => ({
  mockAdmin: { current: null as MockAdminCtx | null },
}));
vi.mock("../../middlewares/requireAdmin", () =>
  makeRequireAdminMock(mockAdmin),
);

function fluent(result: unknown) {
  const obj: Record<string, unknown> = {
    from: () => obj,
    where: () => obj,
    set: () => obj,
    values: () => obj,
    orderBy: () => obj,
    leftJoin: () => obj,
    innerJoin: () => obj,
    onConflictDoUpdate: () => Promise.resolve(undefined),
    onConflictDoNothing: () => Promise.resolve(undefined),
    limit: () => Promise.resolve(result),
    returning: () => Promise.resolve(result),
    then: (resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) =>
      Promise.resolve(result).then(resolve, reject),
  };
  return obj;
}
const selectQueue: unknown[] = [];
const insertQueue: unknown[] = [];
const updateQueue: unknown[] = [];
const dbStub = {
  select: vi.fn(() => fluent(selectQueue.shift() ?? [])),
  insert: vi.fn(() => fluent(insertQueue.shift() ?? [])),
  update: vi.fn(() => fluent(updateQueue.shift() ?? undefined)),
};
vi.mock("drizzle-orm/node-postgres", () => ({
  drizzle: () => dbStub,
}));

vi.mock("@workspace/resupply-db", async () => {
  const actual =
    await vi.importActual<typeof import("@workspace/resupply-db")>(
      "@workspace/resupply-db",
    );
  return {
    ...actual,
    getDbPool: () => ({}) as never,
  };
});

const sendEmailMock = vi.fn();
vi.mock("@workspace/resupply-email", async () => {
  const actual =
    await vi.importActual<typeof import("@workspace/resupply-email")>(
      "@workspace/resupply-email",
    );
  return {
    ...actual,
    createSendgridClient: vi.fn(() => ({ sendEmail: sendEmailMock })),
  };
});

const logAuditMock = vi.fn().mockResolvedValue(undefined);
vi.mock("@workspace/resupply-audit", () => ({
  logAudit: (...a: unknown[]) => logAuditMock(...a),
}));

import sendEmailRouter from "./send-reminder";

const PATIENT_ID = "11111111-1111-4111-8111-111111111111";
const EPISODE_ID = "22222222-2222-4222-8222-222222222222";
const CONVERSATION_ID = "33333333-3333-4333-8333-333333333333";
const ALLOWED_EMAIL = "ops@penn.example.com";

function makeApp(): Express {
  const app = express();
  app.use(express.json());
  app.use("/resupply-api", sendEmailRouter);
  return app;
}

function stubVerifiedAdmin(): void {
  mockAdmin.current = {
    userId: "user_op",
    email: ALLOWED_EMAIL,
    role: "admin",
  };
}

const ENV_KEYS = [
  "TWILIO_ACCOUNT_SID",
  "TWILIO_AUTH_TOKEN",
  "TWILIO_PHONE_NUMBER",
  "SENDGRID_API_KEY",
  "SENDGRID_FROM_EMAIL",
  "SENDGRID_FROM_NAME",
  "SENDGRID_EVENT_WEBHOOK_PUBLIC_KEY",
  "RESUPPLY_PHONE_HMAC_KEY",
  "RESUPPLY_LINK_HMAC_KEY",
  "RESUPPLY_VOICE_PUBLIC_BASE_URL",
  "RESUPPLY_ADMIN_EMAILS",
  "NODE_ENV",
  "RESUPPLY_DATA_KEY",
] as const;
type EnvKey = (typeof ENV_KEYS)[number];
const originalEnv: Partial<Record<EnvKey, string | undefined>> = {};

function setMessagingEnv(): void {
  process.env.TWILIO_ACCOUNT_SID = "ACtest";
  process.env.TWILIO_AUTH_TOKEN = "test-twilio-token";
  process.env.TWILIO_PHONE_NUMBER = "+12158675309";
  process.env.SENDGRID_API_KEY = "SG.testkey";
  process.env.SENDGRID_FROM_EMAIL = "no-reply@penn.example";
  process.env.SENDGRID_FROM_NAME = "Penn Sleep";
  process.env.SENDGRID_EVENT_WEBHOOK_PUBLIC_KEY = "fake-pubkey";
  process.env.RESUPPLY_PHONE_HMAC_KEY = "phone-hmac-test-key-32bytesXXXXXX";
  process.env.RESUPPLY_LINK_HMAC_KEY = "link-hmac-test-key-32bytesXXXXXXX";
  process.env.RESUPPLY_VOICE_PUBLIC_BASE_URL = "https://test.example.com";
  process.env.RESUPPLY_ADMIN_EMAILS = ALLOWED_EMAIL;
  process.env.RESUPPLY_DATA_KEY = "00".repeat(32);

  process.env.NODE_ENV = "test";
}

describe("POST /email/send-reminder", () => {
  beforeEach(() => {
    for (const k of ENV_KEYS) originalEnv[k] = process.env[k];
    for (const k of ENV_KEYS) delete process.env[k];
    process.env.NODE_ENV = "test";
    selectQueue.length = 0;
    insertQueue.length = 0;
    updateQueue.length = 0;
    mockAdmin.current = null;
    sendEmailMock.mockReset();
    logAuditMock.mockReset().mockResolvedValue(undefined);
    dbStub.select.mockClear();
    dbStub.insert.mockClear();
    dbStub.update.mockClear();
  });
  afterEach(() => {
    for (const k of ENV_KEYS) {
      if (originalEnv[k] === undefined) delete process.env[k];
      else process.env[k] = originalEnv[k];
    }
  });

  it("returns 503 messaging_not_configured when env is missing", async () => {
    stubVerifiedAdmin();
    process.env.RESUPPLY_ADMIN_EMAILS = ALLOWED_EMAIL;
    const res = await request(makeApp())
      .post("/resupply-api/email/send-reminder")
      .send({ patientId: PATIENT_ID, episodeId: EPISODE_ID });
    expect(res.status).toBe(503);
    expect(res.body.error).toBe("messaging_not_configured");
  });

  it("returns 400 on invalid body", async () => {
    setMessagingEnv();
    stubVerifiedAdmin();
    const res = await request(makeApp())
      .post("/resupply-api/email/send-reminder")
      .send({ patientId: "not-a-uuid" });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_body");
  });

  it("returns 422 when patient has no email", async () => {
    setMessagingEnv();
    stubVerifiedAdmin();
    selectQueue.push([
      {
        id: PATIENT_ID,
        status: "active",
        email: null,
        legalFirstName: "Joan",
      },
    ]);
    const res = await request(makeApp())
      .post("/resupply-api/email/send-reminder")
      .send({ patientId: PATIENT_ID, episodeId: EPISODE_ID });
    expect(res.status).toBe(422);
    expect(res.body.error).toBe("patient_missing_email");
  });

  it("sends, opens conversation, audits, returns 201, scrubs email PHI", async () => {
    setMessagingEnv();
    stubVerifiedAdmin();
    selectQueue.push([
      {
        id: PATIENT_ID,
        status: "active",
        email: "joan@example.com",
        legalFirstName: "Joan",
      },
    ]);
    selectQueue.push([{ id: EPISODE_ID, patientId: PATIENT_ID }]);
    insertQueue.push([{ id: CONVERSATION_ID }]);
    updateQueue.push(undefined);
    sendEmailMock.mockResolvedValue({ messageId: "SG_TEST_999" });

    const res = await request(makeApp())
      .post("/resupply-api/email/send-reminder")
      .send({ patientId: PATIENT_ID, episodeId: EPISODE_ID });

    expect(res.status).toBe(201);
    expect(res.body).toEqual({
      conversationId: CONVERSATION_ID,
      messageId: "SG_TEST_999",
    });
    expect(sendEmailMock).toHaveBeenCalledTimes(1);
    const call = sendEmailMock.mock.calls[0][0];
    expect(call.to).toBe("joan@example.com");
    // Three signed link tokens were embedded.
    expect(call.html).toMatch(/email\/click\?t=[A-Za-z0-9_.-]+/);

    expect(logAuditMock).toHaveBeenCalledTimes(1);
    const audit = logAuditMock.mock.calls[0][0];
    expect(audit.action).toBe("messaging.reminder.sent");
    expect(audit.metadata.channel).toBe("email");
    expect(audit.metadata.status).toBe("ok");
    const meta = JSON.stringify(audit.metadata);
    expect(meta).not.toContain("joan@example.com");
    expect(meta).not.toContain("Joan");
  });
});
