// Route tests for POST /sms/send-reminder.
//
// Same mocking strategy as voice/place-call.test.ts:
//   - Mock the auth-deps module so requireAdmin is exercisable.
//   - Mock drizzle so we stage row results per assertion.
//   - Mock @workspace/resupply-telecom's createTwilioSmsClient so we
//     never hit Twilio.
//   - Mock @workspace/resupply-audit so audit calls are observable.

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
    leftJoin: () => obj,
    orderBy: () => obj,
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
  const actual = await vi.importActual<typeof import("@workspace/resupply-db")>(
    "@workspace/resupply-db",
  );
  return {
    ...actual,
    getDbPool: () => ({}) as never,
  };
});

const sendSmsMock = vi.fn();
vi.mock("@workspace/resupply-telecom", async () => {
  const actual = await vi.importActual<
    typeof import("@workspace/resupply-telecom")
  >("@workspace/resupply-telecom");
  return {
    ...actual,
    createTwilioSmsClient: vi.fn(() => ({ sendSms: sendSmsMock })),
  };
});

const logAuditMock = vi.fn().mockResolvedValue(undefined);
vi.mock("@workspace/resupply-audit", () => ({
  logAudit: (...a: unknown[]) => logAuditMock(...a),
}));

import sendReminderRouter from "./send-reminder";

const PATIENT_ID = "11111111-1111-4111-8111-111111111111";
const EPISODE_ID = "22222222-2222-4222-8222-222222222222";
const CONVERSATION_ID = "33333333-3333-4333-8333-333333333333";
const ALLOWED_EMAIL = "ops@penn.example.com";

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

const ENV_KEYS = [
  "TWILIO_ACCOUNT_SID",
  "TWILIO_AUTH_TOKEN",
  "TWILIO_PHONE_NUMBER",
  "TWILIO_MESSAGING_SERVICE_SID",
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
  process.env.RESUPPLY_LINK_HMAC_KEY = "link-hmac-test-key-32bytesXXXXXXX";
  process.env.RESUPPLY_VOICE_PUBLIC_BASE_URL = "https://test.example.com";
  process.env.RESUPPLY_ADMIN_EMAILS = ALLOWED_EMAIL;
  process.env.NODE_ENV = "test";
}

// TODO(migration:drizzle-to-supabase): this suite mocks
// `drizzle-orm/node-postgres` and exercises a fluent stub that the
// reminders package no longer touches — `sendReminderSms` now reads
// and writes through the Supabase service-role client. Rewrite the
// per-test stubs against `getSupabaseServiceRoleClient()` (mock the
// `.schema().from().select/insert/update()...` chain returning the
// same staged rows) before re-enabling. The unit-level safe-audit
// + sanitize coverage in lib/resupply-{reminders,audit} stays green
// in the meantime.
describe.skip("POST /sms/send-reminder", () => {
  beforeEach(() => {
    for (const k of ENV_KEYS) originalEnv[k] = process.env[k];
    for (const k of ENV_KEYS) delete process.env[k];
    process.env.NODE_ENV = "test";
    selectQueue.length = 0;
    insertQueue.length = 0;
    updateQueue.length = 0;
    mockAdmin.current = null;
    sendSmsMock.mockReset();
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
      .post("/resupply-api/sms/send-reminder")
      .send({ patientId: PATIENT_ID, episodeId: EPISODE_ID });
    expect(res.status).toBe(503);
    expect(res.body.error).toBe("messaging_not_configured");
  });

  it("returns 401 when there is no session", async () => {
    setMessagingEnv();
    const res = await request(makeApp())
      .post("/resupply-api/sms/send-reminder")
      .send({ patientId: PATIENT_ID, episodeId: EPISODE_ID });
    expect(res.status).toBe(401);
  });

  it("returns 400 on invalid body (missing patientId)", async () => {
    setMessagingEnv();
    stubVerifiedAdmin();
    const res = await request(makeApp())
      .post("/resupply-api/sms/send-reminder")
      .send({});
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_body");
  });

  it("returns 404 when patient does not exist", async () => {
    setMessagingEnv();
    stubVerifiedAdmin();
    selectQueue.push([]);
    const res = await request(makeApp())
      .post("/resupply-api/sms/send-reminder")
      .send({ patientId: PATIENT_ID, episodeId: EPISODE_ID });
    expect(res.status).toBe(404);
    expect(res.body.error).toBe("patient_not_found");
  });

  it("returns 409 when patient is not active", async () => {
    setMessagingEnv();
    stubVerifiedAdmin();
    selectQueue.push([
      {
        id: PATIENT_ID,
        status: "paused",
        phoneE164: "+12155551212",
        legalFirstName: "Joan",
      },
    ]);
    const res = await request(makeApp())
      .post("/resupply-api/sms/send-reminder")
      .send({ patientId: PATIENT_ID, episodeId: EPISODE_ID });
    expect(res.status).toBe(409);
    expect(res.body.error).toBe("patient_not_active");
  });

  it("returns 422 when patient has no phone", async () => {
    setMessagingEnv();
    stubVerifiedAdmin();
    selectQueue.push([
      {
        id: PATIENT_ID,
        status: "active",
        phoneE164: null,
        legalFirstName: "Joan",
      },
    ]);
    const res = await request(makeApp())
      .post("/resupply-api/sms/send-reminder")
      .send({ patientId: PATIENT_ID, episodeId: EPISODE_ID });
    expect(res.status).toBe(422);
    expect(res.body.error).toBe("patient_missing_phone");
  });

  it("returns 422 on episode/patient mismatch", async () => {
    setMessagingEnv();
    stubVerifiedAdmin();
    selectQueue.push([
      {
        id: PATIENT_ID,
        status: "active",
        phoneE164: "+12155551212",
        legalFirstName: "Joan",
      },
    ]);
    selectQueue.push([
      { id: EPISODE_ID, patientId: "44444444-4444-4444-8444-444444444444" },
    ]);
    const res = await request(makeApp())
      .post("/resupply-api/sms/send-reminder")
      .send({ patientId: PATIENT_ID, episodeId: EPISODE_ID });
    expect(res.status).toBe(422);
    expect(res.body.error).toBe("episode_patient_mismatch");
  });

  it("sends, opens conversation, audits, returns 201", async () => {
    setMessagingEnv();
    stubVerifiedAdmin();
    selectQueue.push([
      {
        id: PATIENT_ID,
        status: "active",
        phoneE164: "+12155551212",
        legalFirstName: "Joan",
      },
    ]);
    selectQueue.push([{ id: EPISODE_ID, patientId: PATIENT_ID }]);
    // otherOwners ambiguity check — empty (no conflict).
    selectQueue.push([]);
    // insert order: conversations (returning), messages (no returning),
    // update conversations. The latest-message projection upsert is
    // best-effort and warns on missing mocks rather than failing the
    // request.
    insertQueue.push([{ id: CONVERSATION_ID }]);
    insertQueue.push(undefined);
    updateQueue.push(undefined);
    sendSmsMock.mockResolvedValue({ messageSid: "SM_TEST_123" });

    const res = await request(makeApp())
      .post("/resupply-api/sms/send-reminder")
      .send({ patientId: PATIENT_ID, episodeId: EPISODE_ID });

    expect(res.status).toBe(201);
    expect(res.body).toEqual({
      conversationId: CONVERSATION_ID,
      messageSid: "SM_TEST_123",
    });
    expect(sendSmsMock).toHaveBeenCalledTimes(1);
    const call = sendSmsMock.mock.calls[0][0];
    expect(call.to).toBe("+12155551212");
    expect(call.body).toContain("PennPaps");
    expect(call.statusCallbackUrl).toContain(
      `/resupply-api/sms/status-callback?conversationId=${CONVERSATION_ID}`,
    );

    expect(logAuditMock).toHaveBeenCalledTimes(1);
    const audit = logAuditMock.mock.calls[0][0];
    expect(audit.action).toBe("messaging.reminder.sent");
    expect(audit.metadata.status).toBe("ok");
    expect(audit.metadata.channel).toBe("sms");
    // PHI scrub: phone + name not in metadata.
    const meta = JSON.stringify(audit.metadata);
    expect(meta).not.toContain("+12155551212");
    expect(meta).not.toContain("Joan");
  });

  it("returns 502 + audits twilio_error when Twilio API rejects", async () => {
    setMessagingEnv();
    stubVerifiedAdmin();
    selectQueue.push([
      {
        id: PATIENT_ID,
        status: "active",
        phoneE164: "+12155551212",
        legalFirstName: "Joan",
      },
    ]);
    selectQueue.push([{ id: EPISODE_ID, patientId: PATIENT_ID }]);
    // otherOwners ambiguity check — empty (no conflict).
    selectQueue.push([]);
    // insert order on the failure path: conversations (returning).
    // Twilio failure short-circuits before the messages insert.
    insertQueue.push([{ id: CONVERSATION_ID }]);
    const { TwilioApiError } = await import("@workspace/resupply-telecom");
    sendSmsMock.mockRejectedValue(new TwilioApiError("rejected", 400, "21610"));

    const res = await request(makeApp())
      .post("/resupply-api/sms/send-reminder")
      .send({ patientId: PATIENT_ID, episodeId: EPISODE_ID });

    expect(res.status).toBe(502);
    expect(res.body.error).toBe("twilio_api_error");
    expect(logAuditMock).toHaveBeenCalledTimes(1);
    expect(logAuditMock.mock.calls[0][0].metadata.status).toBe("twilio_error");
  });

  it("returns 409 + audits messaging.phone_lookup.conflict when another patient owns the hmac", async () => {
    // Defends against the silent cross-patient phone_lookup
    // reassignment that an `ON CONFLICT (hmac_phone) DO UPDATE
    // SET patient_id = …` upsert would have allowed. The lib
    // detects the conflict, audits it, and refuses to send;
    // the route surfaces it as 409 (no PHI in body).
    setMessagingEnv();
    stubVerifiedAdmin();
    const OTHER_PATIENT_ID = "55555555-5555-4555-8555-555555555555";
    selectQueue.push([
      {
        id: PATIENT_ID,
        status: "active",
        phoneE164: "+12155551212",
        legalFirstName: "Joan",
      },
    ]);
    selectQueue.push([{ id: EPISODE_ID, patientId: PATIENT_ID }]);
    // otherOwners ambiguity check → returns a *different* patient
    // who owns the same phone number ⇒ conflict.
    selectQueue.push([{ id: OTHER_PATIENT_ID }]);

    const res = await request(makeApp())
      .post("/resupply-api/sms/send-reminder")
      .send({ patientId: PATIENT_ID, episodeId: EPISODE_ID });

    expect(res.status).toBe(409);
    expect(res.body.error).toBe("phone_in_use_by_other_patient");
    // Defense in depth: do not leak the other patient_id over the
    // wire — admins retrieve it via the audit row.
    expect(JSON.stringify(res.body)).not.toContain(OTHER_PATIENT_ID);
    // No outbound SMS, no conversation insert.
    expect(sendSmsMock).not.toHaveBeenCalled();

    // Two audit calls fire on this path: the conflict (from the lib)
    // and the admin-facing reminder.sent outcome (status=
    // phone_in_use_by_other_patient). Both carry the right shape.
    expect(logAuditMock).toHaveBeenCalled();
    const calls = logAuditMock.mock.calls.map((c) => c[0]);
    const conflict = calls.find(
      (c) => c.action === "messaging.phone_lookup.conflict",
    );
    expect(conflict).toBeDefined();
    expect(conflict?.metadata.channel).toBe("sms");
    expect(conflict?.metadata.patient_id).toBe(PATIENT_ID);
    expect(conflict?.metadata.existing_patient_id).toBe(OTHER_PATIENT_ID);
    expect(conflict?.metadata.reason).toBe("phone_in_use_by_other_patient");
    // PHI scrub: phone is never echoed into audit metadata.
    expect(JSON.stringify(conflict?.metadata)).not.toContain("+12155551212");
  });
});
