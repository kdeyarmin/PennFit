// Route tests for POST /episodes/bulk-send.
//
// We mock the helper layer (`@workspace/resupply-reminders`) directly
// rather than the deep telecom/email/db stack, because bulk-send's
// responsibility is ORCHESTRATION only:
//   - parse + dedupe the id slate
//   - look up patient_id per id in one round-trip (Supabase)
//   - serial fan-out to the helpers
//   - aggregate per-id outcomes into summary + results[]
//   - short-circuit on vendor config errors
//
// The helpers themselves are exhaustively tested in
// lib/resupply-reminders/. Repeating those scenarios here would
// inflate test runtime without catching anything new.

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

const sendReminderSmsMock = vi.fn();
const sendReminderEmailMock = vi.fn();
vi.mock("@workspace/resupply-reminders", async () => {
  const actual = await vi.importActual<
    typeof import("@workspace/resupply-reminders")
  >("@workspace/resupply-reminders");
  return {
    ...actual,
    sendReminderSms: (...a: unknown[]) => sendReminderSmsMock(...a),
    sendReminderEmail: (...a: unknown[]) => sendReminderEmailMock(...a),
  };
});

// readMessagingConfigOrNull is the gate for the 503 path. We mock
// this module so we don't have to set 11 env vars per test.
const readMessagingConfigMock = vi.fn();
vi.mock("../../lib/messaging/messaging-config", () => ({
  readMessagingConfigOrNull: () => readMessagingConfigMock(),
}));

// Bypass the rate limiter so its closure-scoped bucket state doesn't
// bleed between test cases and cause 429s on later tests.
vi.mock("express-rate-limit", () => ({
  default: () => (_req: unknown, _res: unknown, next: () => void) => next(),
  ipKeyGenerator: (ip: string) => ip,
}));

import { TwilioConfigError } from "@workspace/resupply-telecom";
import { EmailConfigError } from "@workspace/resupply-email";

import bulkSendRouter from "./bulk-send";

const ALLOWED_EMAIL = "ops@penn.example.com";
const EP1 = "11111111-1111-4111-8111-111111111111";
const EP2 = "22222222-2222-4222-8222-222222222222";
const EP3 = "33333333-3333-4333-8333-333333333333";
const PT1 = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const PT2 = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const PT3 = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";

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
  app.use("/resupply-api", bulkSendRouter);
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
  supabaseMock.reset();
  process.env.RESUPPLY_ADMIN_EMAILS = ALLOWED_EMAIL;
  readMessagingConfigMock.mockReturnValue(BASE_CFG);
});

afterEach(() => {
  if (ORIGINAL_ADMIN_EMAILS === undefined) {
    delete process.env.RESUPPLY_ADMIN_EMAILS;
  } else {
    process.env.RESUPPLY_ADMIN_EMAILS = ORIGINAL_ADMIN_EMAILS;
  }
});

describe("POST /episodes/bulk-send", () => {
  it("requires admin auth", async () => {
    const res = await request(makeApp())
      .post("/resupply-api/episodes/bulk-send")
      .send({ episodeIds: [EP1], channel: "sms" });

    expect(res.status).toBe(401);
    expect(sendReminderSmsMock).not.toHaveBeenCalled();
  });

  it("returns 503 when messaging config is missing", async () => {
    stubVerifiedAdmin();
    readMessagingConfigMock.mockReturnValue(null);

    const res = await request(makeApp())
      .post("/resupply-api/episodes/bulk-send")
      .send({ episodeIds: [EP1], channel: "sms" });

    expect(res.status).toBe(503);
    expect(res.body.error).toBe("messaging_not_configured");
    expect(sendReminderSmsMock).not.toHaveBeenCalled();
  });

  it("rejects invalid bodies", async () => {
    stubVerifiedAdmin();

    const noIds = await request(makeApp())
      .post("/resupply-api/episodes/bulk-send")
      .send({ episodeIds: [], channel: "sms" });
    expect(noIds.status).toBe(400);

    const badChannel = await request(makeApp())
      .post("/resupply-api/episodes/bulk-send")
      .send({ episodeIds: [EP1], channel: "voice" });
    expect(badChannel.status).toBe(400);

    const tooMany = await request(makeApp())
      .post("/resupply-api/episodes/bulk-send")
      .send({
        episodeIds: Array.from(
          { length: 51 },
          (_, i) =>
            `${(i + 10).toString().padStart(8, "0")}-1111-4111-8111-111111111111`,
        ),
        channel: "sms",
      });
    expect(tooMany.status).toBe(400);
  });

  it("happy path — three SMS sends all succeed", async () => {
    stubVerifiedAdmin();
    stageSupabaseResponse("episodes", "select", {
      data: [
        { id: EP1, patient_id: PT1 },
        { id: EP2, patient_id: PT2 },
        { id: EP3, patient_id: PT3 },
      ],
    });
    sendReminderSmsMock.mockImplementation(
      async (args: { episodeId: string; patientId: string }) => ({
        status: "ok",
        conversationId: `conv-${args.episodeId.slice(0, 4)}`,
        vendorRef: `SM_${args.episodeId.slice(0, 4)}`,
      }),
    );

    const res = await request(makeApp())
      .post("/resupply-api/episodes/bulk-send")
      .send({ episodeIds: [EP1, EP2, EP3], channel: "sms" });

    expect(res.status).toBe(200);
    expect(res.body.summary).toEqual({ total: 3, sent: 3, failed: 0 });
    expect(res.body.results).toHaveLength(3);
    expect(
      res.body.results.every((r: { status: string }) => r.status === "ok"),
    ).toBe(true);
    expect(sendReminderSmsMock).toHaveBeenCalledTimes(3);
    expect(sendReminderEmailMock).not.toHaveBeenCalled();
  });

  it("partial failure — mixed outcomes are reported per-id", async () => {
    stubVerifiedAdmin();
    stageSupabaseResponse("episodes", "select", {
      data: [
        { id: EP1, patient_id: PT1 },
        { id: EP2, patient_id: PT2 },
        { id: EP3, patient_id: PT3 },
      ],
    });
    sendReminderSmsMock
      .mockResolvedValueOnce({
        status: "ok",
        conversationId: "conv-1",
        vendorRef: "SM_1",
      })
      .mockResolvedValueOnce({ status: "patient_missing_phone" })
      .mockResolvedValueOnce({ status: "vendor_api_error" });

    const res = await request(makeApp())
      .post("/resupply-api/episodes/bulk-send")
      .send({ episodeIds: [EP1, EP2, EP3], channel: "sms" });

    expect(res.status).toBe(200);
    expect(res.body.summary).toEqual({ total: 3, sent: 1, failed: 2 });
    expect(res.body.results[0]).toMatchObject({
      episodeId: EP1,
      status: "ok",
      conversationId: "conv-1",
      vendorRef: "SM_1",
    });
    expect(res.body.results[1]).toMatchObject({
      episodeId: EP2,
      status: "error",
      error: "patient_missing_phone",
    });
    expect(res.body.results[2]).toMatchObject({
      episodeId: EP3,
      status: "error",
      error: "vendor_api_error",
    });
  });

  it("reports episode_not_found for ids missing from the lookup", async () => {
    stubVerifiedAdmin();
    stageSupabaseResponse("episodes", "select", {
      data: [{ id: EP1, patient_id: PT1 }],
    });
    sendReminderSmsMock.mockResolvedValue({
      status: "ok",
      conversationId: "c",
      vendorRef: "v",
    });

    const res = await request(makeApp())
      .post("/resupply-api/episodes/bulk-send")
      .send({ episodeIds: [EP1, EP2], channel: "sms" });

    expect(res.status).toBe(200);
    expect(res.body.summary).toEqual({ total: 2, sent: 1, failed: 1 });
    expect(
      res.body.results.find((r: { episodeId: string }) => r.episodeId === EP2),
    ).toMatchObject({
      status: "error",
      error: "episode_not_found",
    });
    expect(sendReminderSmsMock).toHaveBeenCalledTimes(1);
  });

  it("short-circuits on TwilioConfigError, marking remainder as twilio_config_error", async () => {
    stubVerifiedAdmin();
    stageSupabaseResponse("episodes", "select", {
      data: [
        { id: EP1, patient_id: PT1 },
        { id: EP2, patient_id: PT2 },
        { id: EP3, patient_id: PT3 },
      ],
    });
    sendReminderSmsMock
      .mockResolvedValueOnce({
        status: "ok",
        conversationId: "c",
        vendorRef: "v",
      })
      .mockRejectedValueOnce(new TwilioConfigError("missing creds"))
      .mockImplementation(() => {
        throw new Error("should not reach third id");
      });

    const res = await request(makeApp())
      .post("/resupply-api/episodes/bulk-send")
      .send({ episodeIds: [EP1, EP2, EP3], channel: "sms" });

    expect(res.status).toBe(200);
    expect(res.body.summary).toEqual({ total: 3, sent: 1, failed: 2 });
    expect(res.body.results[0].status).toBe("ok");
    expect(res.body.results[1]).toMatchObject({
      episodeId: EP2,
      status: "error",
      error: "twilio_config_error",
    });
    expect(res.body.results[2]).toMatchObject({
      episodeId: EP3,
      status: "error",
      error: "twilio_config_error",
    });
    // helper called for ids 1 and 2 only — NOT for 3.
    expect(sendReminderSmsMock).toHaveBeenCalledTimes(2);
  });

  it("short-circuits on EmailConfigError when channel=email", async () => {
    stubVerifiedAdmin();
    stageSupabaseResponse("episodes", "select", {
      data: [
        { id: EP1, patient_id: PT1 },
        { id: EP2, patient_id: PT2 },
      ],
    });
    sendReminderEmailMock.mockRejectedValueOnce(
      new EmailConfigError("missing api key"),
    );

    const res = await request(makeApp())
      .post("/resupply-api/episodes/bulk-send")
      .send({ episodeIds: [EP1, EP2], channel: "email" });

    expect(res.status).toBe(200);
    expect(res.body.summary).toEqual({ total: 2, sent: 0, failed: 2 });
    expect(res.body.results[0].error).toBe("sendgrid_config_error");
    expect(res.body.results[1].error).toBe("sendgrid_config_error");
    expect(sendReminderEmailMock).toHaveBeenCalledTimes(1);
    expect(sendReminderSmsMock).not.toHaveBeenCalled();
  });

  it("de-duplicates input ids while preserving first-seen order", async () => {
    stubVerifiedAdmin();
    stageSupabaseResponse("episodes", "select", {
      data: [
        { id: EP1, patient_id: PT1 },
        { id: EP2, patient_id: PT2 },
      ],
    });
    sendReminderSmsMock.mockResolvedValue({
      status: "ok",
      conversationId: "c",
      vendorRef: "v",
    });

    const res = await request(makeApp())
      .post("/resupply-api/episodes/bulk-send")
      .send({ episodeIds: [EP1, EP2, EP1, EP2, EP1], channel: "sms" });

    expect(res.status).toBe(200);
    expect(res.body.summary.total).toBe(2);
    expect(
      res.body.results.map((r: { episodeId: string }) => r.episodeId),
    ).toEqual([EP1, EP2]);
    expect(sendReminderSmsMock).toHaveBeenCalledTimes(2);
  });

  it("routes to email helper when channel=email", async () => {
    stubVerifiedAdmin();
    stageSupabaseResponse("episodes", "select", {
      data: [{ id: EP1, patient_id: PT1 }],
    });
    sendReminderEmailMock.mockResolvedValue({
      status: "ok",
      conversationId: "c",
      vendorRef: "msg-id",
    });

    const res = await request(makeApp())
      .post("/resupply-api/episodes/bulk-send")
      .send({ episodeIds: [EP1], channel: "email" });

    expect(res.status).toBe(200);
    expect(res.body.summary.sent).toBe(1);
    expect(sendReminderEmailMock).toHaveBeenCalledTimes(1);
    expect(sendReminderSmsMock).not.toHaveBeenCalled();
  });
});
