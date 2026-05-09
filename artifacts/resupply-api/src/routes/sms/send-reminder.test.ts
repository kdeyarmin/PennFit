// Route tests for POST /sms/send-reminder.
//
// Migration note: this file was previously mocking `drizzle-orm/node-postgres`
// and the Drizzle fluent builder. After the Drizzle → Supabase migration,
// `sendReminderSms` now goes through the Supabase service-role client, so
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

// Mock sendReminderSms so we can stage outcomes without needing a live
// Supabase or Twilio connection.
const sendReminderSmsMock = vi.fn();
vi.mock("@workspace/resupply-reminders", async () => {
  const actual = await vi.importActual<
    typeof import("@workspace/resupply-reminders")
  >("@workspace/resupply-reminders");
  return {
    ...actual,
    sendReminderSms: (...a: unknown[]) => sendReminderSmsMock(...a),
  };
});

// Mock readMessagingConfigOrNull so we don't need to set 11 env vars per test.
const readMessagingConfigMock = vi.fn();
vi.mock("../../lib/messaging/messaging-config", () => ({
  readMessagingConfigOrNull: () => readMessagingConfigMock(),
}));

import sendReminderRouter from "./send-reminder";

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
  app.use("/resupply-api", sendReminderRouter);
  return app;
}

function stubVerifiedAdmin(): void {
  mockAdmin.current = {
    userId: "user_op",
    email: ALLOWED_EMAIL,
    role: "admin",
  };
}

const ORIGINAL_ADMIN_EMAILS = process.env.RESUPPLY_ADMIN_EMAILS;

beforeEach(() => {
  vi.clearAllMocks();
  mockAdmin.current = null;
  readMessagingConfigMock.mockReturnValue(BASE_CFG);
  sendReminderSmsMock.mockReset();
});

afterEach(() => {
  if (ORIGINAL_ADMIN_EMAILS === undefined) {
    delete process.env.RESUPPLY_ADMIN_EMAILS;
  } else {
    process.env.RESUPPLY_ADMIN_EMAILS = ORIGINAL_ADMIN_EMAILS;
  }
});

describe("POST /sms/send-reminder", () => {
  it("returns 503 messaging_not_configured when config is missing", async () => {
    stubVerifiedAdmin();
    readMessagingConfigMock.mockReturnValue(null);

    const res = await request(makeApp())
      .post("/resupply-api/sms/send-reminder")
      .send({ patientId: PATIENT_ID, episodeId: EPISODE_ID });

    expect(res.status).toBe(503);
    expect(res.body.error).toBe("messaging_not_configured");
    expect(sendReminderSmsMock).not.toHaveBeenCalled();
  });

  it("returns 401 when there is no session", async () => {
    const res = await request(makeApp())
      .post("/resupply-api/sms/send-reminder")
      .send({ patientId: PATIENT_ID, episodeId: EPISODE_ID });
    expect(res.status).toBe(401);
    expect(sendReminderSmsMock).not.toHaveBeenCalled();
  });

  it("returns 400 on invalid body (missing patientId)", async () => {
    stubVerifiedAdmin();
    const res = await request(makeApp())
      .post("/resupply-api/sms/send-reminder")
      .send({});

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_body");
    expect(sendReminderSmsMock).not.toHaveBeenCalled();
  });

  it("returns 400 on invalid body (non-UUID patientId)", async () => {
    stubVerifiedAdmin();
    const res = await request(makeApp())
      .post("/resupply-api/sms/send-reminder")
      .send({ patientId: "not-a-uuid" });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_body");
  });

  it("returns 400 on invalid body (body too long)", async () => {
    stubVerifiedAdmin();
    const res = await request(makeApp())
      .post("/resupply-api/sms/send-reminder")
      .send({ patientId: PATIENT_ID, body: "x".repeat(1601) });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_body");
  });

  it("returns 404 when patient does not exist", async () => {
    stubVerifiedAdmin();
    sendReminderSmsMock.mockResolvedValue({ status: "patient_not_found" });

    const res = await request(makeApp())
      .post("/resupply-api/sms/send-reminder")
      .send({ patientId: PATIENT_ID, episodeId: EPISODE_ID });

    expect(res.status).toBe(404);
    expect(res.body.error).toBe("patient_not_found");
  });

  it("returns 409 when patient is not active", async () => {
    stubVerifiedAdmin();
    sendReminderSmsMock.mockResolvedValue({
      status: "patient_not_active",
      patientStatus: "paused",
    });

    const res = await request(makeApp())
      .post("/resupply-api/sms/send-reminder")
      .send({ patientId: PATIENT_ID, episodeId: EPISODE_ID });

    expect(res.status).toBe(409);
    expect(res.body.error).toBe("patient_not_active");
    expect(res.body.message).toContain("paused");
  });

  it("returns 422 when patient has no phone", async () => {
    stubVerifiedAdmin();
    sendReminderSmsMock.mockResolvedValue({ status: "patient_missing_phone" });

    const res = await request(makeApp())
      .post("/resupply-api/sms/send-reminder")
      .send({ patientId: PATIENT_ID, episodeId: EPISODE_ID });

    expect(res.status).toBe(422);
    expect(res.body.error).toBe("patient_missing_phone");
  });

  it("returns 422 when patient phone is not normalizable to E.164", async () => {
    stubVerifiedAdmin();
    sendReminderSmsMock.mockResolvedValue({
      status: "patient_phone_unnormalizable",
    });

    const res = await request(makeApp())
      .post("/resupply-api/sms/send-reminder")
      .send({ patientId: PATIENT_ID });

    expect(res.status).toBe(422);
    expect(res.body.error).toBe("patient_phone_unnormalizable");
  });

  it("returns 422 on episode/patient mismatch", async () => {
    stubVerifiedAdmin();
    sendReminderSmsMock.mockResolvedValue({
      status: "episode_patient_mismatch",
    });

    const res = await request(makeApp())
      .post("/resupply-api/sms/send-reminder")
      .send({ patientId: PATIENT_ID, episodeId: EPISODE_ID });

    expect(res.status).toBe(422);
    expect(res.body.error).toBe("episode_patient_mismatch");
  });

  it("returns 404 when no episode exists for patient", async () => {
    stubVerifiedAdmin();
    sendReminderSmsMock.mockResolvedValue({ status: "no_episode_for_patient" });

    const res = await request(makeApp())
      .post("/resupply-api/sms/send-reminder")
      .send({ patientId: PATIENT_ID });

    expect(res.status).toBe(404);
    expect(res.body.error).toBe("no_episode_for_patient");
  });

  it("returns 404 when episode does not exist", async () => {
    stubVerifiedAdmin();
    sendReminderSmsMock.mockResolvedValue({ status: "episode_not_found" });

    const res = await request(makeApp())
      .post("/resupply-api/sms/send-reminder")
      .send({ patientId: PATIENT_ID, episodeId: EPISODE_ID });

    expect(res.status).toBe(404);
    expect(res.body.error).toBe("episode_not_found");
  });

  it("returns 409 when phone is in use by another patient (no PHI leak)", async () => {
    stubVerifiedAdmin();
    sendReminderSmsMock.mockResolvedValue({
      status: "phone_in_use_by_other_patient",
    });

    const res = await request(makeApp())
      .post("/resupply-api/sms/send-reminder")
      .send({ patientId: PATIENT_ID, episodeId: EPISODE_ID });

    expect(res.status).toBe(409);
    expect(res.body.error).toBe("phone_in_use_by_other_patient");
    // The route must NOT echo the conflicting patient_id or any
    // phone number in the response body.
    const OTHER_PATIENT_ID = "55555555-5555-4555-8555-555555555555";
    expect(JSON.stringify(res.body)).not.toContain(OTHER_PATIENT_ID);
    expect(JSON.stringify(res.body)).not.toContain("+12155551212");
    expect(sendReminderSmsMock).toHaveBeenCalledTimes(1);
  });

  it("returns 500 when conversation creation fails", async () => {
    stubVerifiedAdmin();
    sendReminderSmsMock.mockResolvedValue({
      status: "conversation_create_failed",
    });

    const res = await request(makeApp())
      .post("/resupply-api/sms/send-reminder")
      .send({ patientId: PATIENT_ID, episodeId: EPISODE_ID });

    expect(res.status).toBe(500);
    expect(res.body.error).toBe("conversation_create_failed");
  });

  it("returns 502 when Twilio API rejects with vendorStatus and vendorCode", async () => {
    stubVerifiedAdmin();
    sendReminderSmsMock.mockResolvedValue({
      status: "vendor_api_error",
      vendorStatus: 400,
      vendorCode: "21610",
    });

    const res = await request(makeApp())
      .post("/resupply-api/sms/send-reminder")
      .send({ patientId: PATIENT_ID, episodeId: EPISODE_ID });

    expect(res.status).toBe(502);
    expect(res.body.error).toBe("twilio_api_error");
    expect(res.body.twilioStatus).toBe(400);
    expect(res.body.twilioCode).toBe("21610");
  });

  it("returns 503 when Twilio config is missing (TwilioConfigError thrown)", async () => {
    stubVerifiedAdmin();
    const { TwilioConfigError } = await import("@workspace/resupply-telecom");
    sendReminderSmsMock.mockRejectedValue(
      new TwilioConfigError("missing TWILIO_ACCOUNT_SID"),
    );

    const res = await request(makeApp())
      .post("/resupply-api/sms/send-reminder")
      .send({ patientId: PATIENT_ID, episodeId: EPISODE_ID });

    expect(res.status).toBe(503);
    expect(res.body.error).toBe("twilio_config_error");
  });

  it("returns 201 with conversationId and messageSid on success", async () => {
    stubVerifiedAdmin();
    sendReminderSmsMock.mockResolvedValue({
      status: "ok",
      conversationId: CONVERSATION_ID,
      vendorRef: "SM_TEST_123",
    });

    const res = await request(makeApp())
      .post("/resupply-api/sms/send-reminder")
      .send({ patientId: PATIENT_ID, episodeId: EPISODE_ID });

    expect(res.status).toBe(201);
    expect(res.body).toEqual({
      conversationId: CONVERSATION_ID,
      messageSid: "SM_TEST_123",
    });
    expect(sendReminderSmsMock).toHaveBeenCalledTimes(1);

    // Verify the helper was invoked with the right patientId and episodeId.
    const callArgs = sendReminderSmsMock.mock.calls[0][0];
    expect(callArgs.patientId).toBe(PATIENT_ID);
    expect(callArgs.episodeId).toBe(EPISODE_ID);
    expect(callArgs.supabase).toBeDefined();
  });

  it("passes an optional body override through to the helper", async () => {
    stubVerifiedAdmin();
    const CUSTOM_BODY = "Hello from your clinic, reply YES to confirm.";
    sendReminderSmsMock.mockResolvedValue({
      status: "ok",
      conversationId: CONVERSATION_ID,
      vendorRef: "SM_CUSTOM",
    });

    await request(makeApp())
      .post("/resupply-api/sms/send-reminder")
      .send({ patientId: PATIENT_ID, body: CUSTOM_BODY });

    const callArgs = sendReminderSmsMock.mock.calls[0][0];
    expect(callArgs.body).toBe(CUSTOM_BODY);
  });

  it("passes actor fields from the admin session to the helper", async () => {
    stubVerifiedAdmin();
    sendReminderSmsMock.mockResolvedValue({
      status: "ok",
      conversationId: CONVERSATION_ID,
      vendorRef: "SM_ACTOR_TEST",
    });

    await request(makeApp())
      .post("/resupply-api/sms/send-reminder")
      .send({ patientId: PATIENT_ID });

    const callArgs = sendReminderSmsMock.mock.calls[0][0];
    expect(callArgs.actor.kind).toBe("admin");
    expect(callArgs.actor.adminEmail).toBe(ALLOWED_EMAIL);
    expect(callArgs.actor.adminUserId).toBe("user_op");
  });

  it("propagates unexpected errors to Express error handler", async () => {
    stubVerifiedAdmin();
    sendReminderSmsMock.mockRejectedValue(new Error("Unexpected DB error"));

    await expect(
      request(makeApp())
        .post("/resupply-api/sms/send-reminder")
        .send({ patientId: PATIENT_ID }),
    ).resolves.toHaveProperty("status", 500);
  });
});
