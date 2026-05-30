// Route tests for POST /email/send-reminder.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import express, { type Express } from "express";
import request from "supertest";

import {
  makeRequireAdminMock,
  type MockAdminCtx,
} from "../../test-helpers/auth-mocks";
import {
  installSupabaseMock,
  stageSupabaseResponse,
} from "../../test-helpers/supabase-mock";

const { mockAdmin } = vi.hoisted(() => ({
  mockAdmin: { current: null as MockAdminCtx | null },
}));
vi.mock("../../middlewares/requireAdmin", () =>
  makeRequireAdminMock(mockAdmin),
);

const supabaseMock = installSupabaseMock();

const sendEmailMock = vi.fn();
vi.mock("@workspace/resupply-email", async () => {
  const actual = await vi.importActual<
    typeof import("@workspace/resupply-email")
  >("@workspace/resupply-email");
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
const PRESCRIPTION_ID = "44444444-4444-4444-8444-444444444444";
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
  "RESUPPLY_LINK_HMAC_KEY",
  "RESUPPLY_VOICE_PUBLIC_BASE_URL",
  "RESUPPLY_ADMIN_EMAILS",
  "NODE_ENV",
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
  process.env.RESUPPLY_LINK_HMAC_KEY =
    "QkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkI=";
  process.env.RESUPPLY_VOICE_PUBLIC_BASE_URL = "https://test.example.com";
  process.env.RESUPPLY_ADMIN_EMAILS = ALLOWED_EMAIL;

  process.env.NODE_ENV = "test";
}

const ACTIVE_PATIENT = {
  id: PATIENT_ID,
  status: "active",
  email: "joan@example.com",
  legal_first_name: "Joan",
};

describe("POST /email/send-reminder", () => {
  beforeEach(() => {
    for (const k of ENV_KEYS) originalEnv[k] = process.env[k];
    for (const k of ENV_KEYS) delete process.env[k];
    process.env.NODE_ENV = "test";
    supabaseMock.reset();
    mockAdmin.current = null;
    sendEmailMock.mockReset();
    logAuditMock.mockReset().mockResolvedValue(undefined);
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
    stageSupabaseResponse("patients", "select", {
      data: { ...ACTIVE_PATIENT, email: null },
    });
    const res = await request(makeApp())
      .post("/resupply-api/email/send-reminder")
      .send({ patientId: PATIENT_ID, episodeId: EPISODE_ID });
    expect(res.status).toBe(422);
    expect(res.body.error).toBe("patient_missing_email");
  });

  it("sends, opens conversation, audits, returns 201, scrubs email PHI", async () => {
    setMessagingEnv();
    stubVerifiedAdmin();
    // Step 1: patient lookup.
    stageSupabaseResponse("patients", "select", { data: ACTIVE_PATIENT });
    // Step 2: episode lookup by id (caller passed episodeId).
    stageSupabaseResponse("episodes", "select", {
      data: {
        id: EPISODE_ID,
        patient_id: PATIENT_ID,
        prescription_id: PRESCRIPTION_ID,
      },
    });
    // Step 3: prescription lookup for items[].
    stageSupabaseResponse("prescriptions", "select", {
      data: { item_sku: "PAP-CUSHION-S" },
    });
    // Step 4: open conversation (insert ... returning).
    stageSupabaseResponse("conversations", "insert", {
      data: { id: CONVERSATION_ID },
    });
    // Step 5: persist message + stamp conversation.
    stageSupabaseResponse("messages", "insert", { error: null });
    stageSupabaseResponse("conversations", "update", { error: null });
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
