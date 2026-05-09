// Route tests for POST /email/send-reminder.
//
// Migration note: this file was previously mocking `drizzle-orm/node-postgres`
// and the Drizzle fluent builder. After the Drizzle → Supabase migration,
// `sendReminderEmail` now goes through the Supabase service-role client, so
// we mock `@workspace/resupply-reminders` directly and return staged outcomes.
// The route's job is thin orchestration (auth gate → config check → body
// parse → delegate → translate outcome to HTTP), so mocking the helper layer
// is the right boundary to test at.

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

// Mock @workspace/resupply-db so getSupabaseServiceRoleClient() returns a
// dummy — the route only holds the reference and passes it straight into the
// reminders helper, which we mock out entirely below.
vi.mock("@workspace/resupply-db", async () => {
  const actual = await vi.importActual<typeof import("@workspace/resupply-db")>(
    "@workspace/resupply-db",
  );
  return {
    ...actual,
    getSupabaseServiceRoleClient: () => ({}) as never,
  };
});

// Mock sendReminderEmail so we can stage outcomes without needing a live
// Supabase or SendGrid connection.
const sendReminderEmailMock = vi.fn();
vi.mock("@workspace/resupply-reminders", async () => {
  const actual = await vi.importActual<
    typeof import("@workspace/resupply-reminders")
  >("@workspace/resupply-reminders");
  return {
    ...actual,
    sendReminderEmail: (...a: unknown[]) => sendReminderEmailMock(...a),
  };
});

// Mock readMessagingConfigOrNull so we don't need to set 11 env vars per test.
const readMessagingConfigMock = vi.fn();
vi.mock("../../lib/messaging/messaging-config", () => ({
  readMessagingConfigOrNull: () => readMessagingConfigMock(),
}));

import sendEmailRouter from "./send-reminder";

const PATIENT_ID = "11111111-1111-4111-8111-111111111111";
const EPISODE_ID = "22222222-2222-4222-8222-222222222222";
const CONVERSATION_ID = "33333333-3333-4333-8333-333333333333";
const ALLOWED_EMAIL = "ops@penn.example.com";

const BASE_CFG = {
  sms: {
    twilioAccountSid: "AC_x",
    twilioAuthToken: "tok",
    twilioPhoneNumber: "+15555550100",
    twilioMessagingServiceSid: undefined,
    publicBaseUrl: "https://x.example",
  },
  email: {
    sendgridApiKey: "SG.x",
    sendgridFromEmail: "noreply@x.example",
    sendgridFromName: "Test",
    sendgridEventWebhookPublicKey: undefined,
    publicBaseUrl: "https://x.example",
  },
  hasLinkHmacKey: true,
  practiceName: "Test Practice",
};

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

beforeEach(() => {
  vi.clearAllMocks();
  mockAdmin.current = null;
  readMessagingConfigMock.mockReturnValue(BASE_CFG);
  sendReminderEmailMock.mockReset();
});

const ORIGINAL_ADMIN_EMAILS = process.env.RESUPPLY_ADMIN_EMAILS;
afterEach(() => {
  if (ORIGINAL_ADMIN_EMAILS === undefined) {
    delete process.env.RESUPPLY_ADMIN_EMAILS;
  } else {
    process.env.RESUPPLY_ADMIN_EMAILS = ORIGINAL_ADMIN_EMAILS;
  }
});

describe("POST /email/send-reminder", () => {
  it("returns 503 messaging_not_configured when config is missing", async () => {
    stubVerifiedAdmin();
    readMessagingConfigMock.mockReturnValue(null);

    const res = await request(makeApp())
      .post("/resupply-api/email/send-reminder")
      .send({ patientId: PATIENT_ID, episodeId: EPISODE_ID });

    expect(res.status).toBe(503);
    expect(res.body.error).toBe("messaging_not_configured");
    expect(sendReminderEmailMock).not.toHaveBeenCalled();
  });

  it("returns 401 when there is no session", async () => {
    const res = await request(makeApp())
      .post("/resupply-api/email/send-reminder")
      .send({ patientId: PATIENT_ID });
    expect(res.status).toBe(401);
    expect(sendReminderEmailMock).not.toHaveBeenCalled();
  });

  it("returns 400 on invalid body (not a UUID)", async () => {
    stubVerifiedAdmin();
    const res = await request(makeApp())
      .post("/resupply-api/email/send-reminder")
      .send({ patientId: "not-a-uuid" });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_body");
    expect(sendReminderEmailMock).not.toHaveBeenCalled();
  });

  it("returns 400 on invalid body (missing patientId)", async () => {
    stubVerifiedAdmin();
    const res = await request(makeApp())
      .post("/resupply-api/email/send-reminder")
      .send({});

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_body");
  });

  it("returns 404 when patient does not exist", async () => {
    stubVerifiedAdmin();
    sendReminderEmailMock.mockResolvedValue({ status: "patient_not_found" });

    const res = await request(makeApp())
      .post("/resupply-api/email/send-reminder")
      .send({ patientId: PATIENT_ID });

    expect(res.status).toBe(404);
    expect(res.body.error).toBe("patient_not_found");
  });

  it("returns 409 when patient is not active", async () => {
    stubVerifiedAdmin();
    sendReminderEmailMock.mockResolvedValue({
      status: "patient_not_active",
      patientStatus: "paused",
    });

    const res = await request(makeApp())
      .post("/resupply-api/email/send-reminder")
      .send({ patientId: PATIENT_ID });

    expect(res.status).toBe(409);
    expect(res.body.error).toBe("patient_not_active");
    expect(res.body.message).toContain("paused");
  });

  it("returns 422 when patient has no email", async () => {
    stubVerifiedAdmin();
    sendReminderEmailMock.mockResolvedValue({ status: "patient_missing_email" });

    const res = await request(makeApp())
      .post("/resupply-api/email/send-reminder")
      .send({ patientId: PATIENT_ID, episodeId: EPISODE_ID });

    expect(res.status).toBe(422);
    expect(res.body.error).toBe("patient_missing_email");
  });

  it("returns 404 when no episode exists for patient", async () => {
    stubVerifiedAdmin();
    sendReminderEmailMock.mockResolvedValue({ status: "no_episode_for_patient" });

    const res = await request(makeApp())
      .post("/resupply-api/email/send-reminder")
      .send({ patientId: PATIENT_ID });

    expect(res.status).toBe(404);
    expect(res.body.error).toBe("no_episode_for_patient");
  });

  it("returns 404 when episode does not exist", async () => {
    stubVerifiedAdmin();
    sendReminderEmailMock.mockResolvedValue({ status: "episode_not_found" });

    const res = await request(makeApp())
      .post("/resupply-api/email/send-reminder")
      .send({ patientId: PATIENT_ID, episodeId: EPISODE_ID });

    expect(res.status).toBe(404);
    expect(res.body.error).toBe("episode_not_found");
  });

  it("returns 422 on episode/patient mismatch", async () => {
    stubVerifiedAdmin();
    sendReminderEmailMock.mockResolvedValue({ status: "episode_patient_mismatch" });

    const res = await request(makeApp())
      .post("/resupply-api/email/send-reminder")
      .send({ patientId: PATIENT_ID, episodeId: EPISODE_ID });

    expect(res.status).toBe(422);
    expect(res.body.error).toBe("episode_patient_mismatch");
  });

  it("returns 500 when conversation creation fails", async () => {
    stubVerifiedAdmin();
    sendReminderEmailMock.mockResolvedValue({
      status: "conversation_create_failed",
    });

    const res = await request(makeApp())
      .post("/resupply-api/email/send-reminder")
      .send({ patientId: PATIENT_ID, episodeId: EPISODE_ID });

    expect(res.status).toBe(500);
    expect(res.body.error).toBe("conversation_create_failed");
  });

  it("returns 502 when SendGrid API rejects", async () => {
    stubVerifiedAdmin();
    sendReminderEmailMock.mockResolvedValue({
      status: "vendor_api_error",
      vendorStatus: 400,
    });

    const res = await request(makeApp())
      .post("/resupply-api/email/send-reminder")
      .send({ patientId: PATIENT_ID, episodeId: EPISODE_ID });

    expect(res.status).toBe(502);
    expect(res.body.error).toBe("sendgrid_api_error");
    expect(res.body.sendgridStatus).toBe(400);
  });

  it("returns 503 when SendGrid config is missing (EmailConfigError thrown)", async () => {
    stubVerifiedAdmin();
    const { EmailConfigError } = await import("@workspace/resupply-email");
    sendReminderEmailMock.mockRejectedValue(
      new EmailConfigError("missing SENDGRID_API_KEY"),
    );

    const res = await request(makeApp())
      .post("/resupply-api/email/send-reminder")
      .send({ patientId: PATIENT_ID, episodeId: EPISODE_ID });

    expect(res.status).toBe(503);
    expect(res.body.error).toBe("sendgrid_config_error");
  });

  it("returns 201 with conversationId and messageId on success", async () => {
    stubVerifiedAdmin();
    sendReminderEmailMock.mockResolvedValue({
      status: "ok",
      conversationId: CONVERSATION_ID,
      vendorRef: "SG_TEST_999",
    });

    const res = await request(makeApp())
      .post("/resupply-api/email/send-reminder")
      .send({ patientId: PATIENT_ID, episodeId: EPISODE_ID });

    expect(res.status).toBe(201);
    expect(res.body).toEqual({
      conversationId: CONVERSATION_ID,
      messageId: "SG_TEST_999",
    });
    expect(sendReminderEmailMock).toHaveBeenCalledTimes(1);

    // Verify the helper was invoked with the right patientId and episodeId.
    const callArgs = sendReminderEmailMock.mock.calls[0][0];
    expect(callArgs.patientId).toBe(PATIENT_ID);
    expect(callArgs.episodeId).toBe(EPISODE_ID);
    // supabase client is wired through
    expect(callArgs.supabase).toBeDefined();
  });

  it("passes actor fields from the admin session to the helper", async () => {
    stubVerifiedAdmin();
    sendReminderEmailMock.mockResolvedValue({
      status: "ok",
      conversationId: CONVERSATION_ID,
      vendorRef: "SG_ACTOR_TEST",
    });

    await request(makeApp())
      .post("/resupply-api/email/send-reminder")
      .send({ patientId: PATIENT_ID });

    const callArgs = sendReminderEmailMock.mock.calls[0][0];
    expect(callArgs.actor.kind).toBe("admin");
    expect(callArgs.actor.adminEmail).toBe(ALLOWED_EMAIL);
    expect(callArgs.actor.adminUserId).toBe("user_op");
  });

  it("propagates unexpected errors to Express error handler", async () => {
    stubVerifiedAdmin();
    sendReminderEmailMock.mockRejectedValue(new Error("DB exploded"));

    await expect(
      request(makeApp())
        .post("/resupply-api/email/send-reminder")
        .send({ patientId: PATIENT_ID }),
    ).resolves.toHaveProperty("status", 500);
  });
});
