// Route tests for POST /voice/place-call.
//
// Mocking strategy:
//   - Mock @clerk/express so requireOperator can be exercised without
//     a real Clerk lookup.
//   - Mock drizzle so we can stage row results per assertion.
//   - Mock @workspace/resupply-telecom's createTwilioClient so we
//     never try to dial a real number.
//   - Mock @workspace/resupply-audit so audit calls are observable
//     without touching the audit_log table.
//
// We deliberately do NOT mock the full `@workspace/resupply-db`
// surface — only `getDbPool()` — because the route still needs the
// schema imports (patients/episodes/conversations) and the encrypt/
// decrypt helpers to evaluate at module load time. Replacing only
// `getDbPool` keeps the type contracts honest.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import express, { type Express } from "express";
import request from "supertest";

const getAuthMock = vi.fn();
const getUserMock = vi.fn();
vi.mock("@clerk/express", () => ({
  getAuth: (...a: unknown[]) => getAuthMock(...a),
  clerkClient: {
    users: { getUser: (...a: unknown[]) => getUserMock(...a) },
  },
}));

// Drizzle stub. Each terminal method (limit / returning / awaited
// where) resolves with the value at the front of `selectResults` /
// `insertResults` / `updateResults`.
function fluent(result: unknown) {
  const obj: Record<string, unknown> = {
    from: () => obj,
    where: () => obj,
    set: () => obj,
    values: () => obj,
    leftJoin: () => obj,
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

const logAuditMock = vi.fn().mockResolvedValue(undefined);
vi.mock("@workspace/resupply-audit", () => ({
  logAudit: (...a: unknown[]) => logAuditMock(...a),
}));

const placeCallMock = vi.fn();
vi.mock("@workspace/resupply-telecom", async () => {
  const actual =
    await vi.importActual<typeof import("@workspace/resupply-telecom")>(
      "@workspace/resupply-telecom",
    );
  return {
    ...actual,
    createTwilioClient: vi.fn(() => ({ placeCall: placeCallMock })),
  };
});

import placeCallRouter from "./place-call";
import {
  __resetPendingSessionsForTests,
  getPendingSessions,
} from "../../lib/voice/pending-sessions";

const PATIENT_ID = "11111111-1111-4111-8111-111111111111";
const EPISODE_ID = "22222222-2222-4222-8222-222222222222";
const CONVERSATION_ID = "33333333-3333-4333-8333-333333333333";
const ALLOWED_EMAIL = "ops@penn.example.com";

function makeApp(): Express {
  const app = express();
  app.use(express.json());
  app.use("/resupply-api", placeCallRouter);
  return app;
}

function stubVerifiedOperator(email = ALLOWED_EMAIL): void {
  getAuthMock.mockReturnValue({ userId: "user_op" });
  getUserMock.mockResolvedValue({
    primaryEmailAddressId: "eml_1",
    emailAddresses: [
      {
        id: "eml_1",
        emailAddress: email,
        verification: { status: "verified" },
      },
    ],
  });
}

const ENV_KEYS = [
  "OPENAI_API_KEY",
  "TWILIO_ACCOUNT_SID",
  "TWILIO_AUTH_TOKEN",
  "TWILIO_PHONE_NUMBER",
  "RESUPPLY_VOICE_PUBLIC_BASE_URL",
  "RESUPPLY_OPERATOR_EMAILS",
  "NODE_ENV",
] as const;
type EnvKey = (typeof ENV_KEYS)[number];
const originalEnv: Partial<Record<EnvKey, string | undefined>> = {};

function setVoiceEnv(): void {
  process.env.OPENAI_API_KEY = "test-openai-key";
  process.env.TWILIO_ACCOUNT_SID = "ACtest";
  process.env.TWILIO_AUTH_TOKEN = "test-twilio-token";
  process.env.TWILIO_PHONE_NUMBER = "+12158675309";
  process.env.RESUPPLY_VOICE_PUBLIC_BASE_URL = "https://test.example.com";
  process.env.RESUPPLY_OPERATOR_EMAILS = ALLOWED_EMAIL;
  process.env.NODE_ENV = "test";
}

describe("POST /voice/place-call", () => {
  beforeEach(() => {
    for (const k of ENV_KEYS) originalEnv[k] = process.env[k];
    for (const k of ENV_KEYS) delete process.env[k];
    process.env.NODE_ENV = "test";
    selectQueue.length = 0;
    insertQueue.length = 0;
    updateQueue.length = 0;
    getAuthMock.mockReset();
    getUserMock.mockReset();
    placeCallMock.mockReset();
    logAuditMock.mockReset().mockResolvedValue(undefined);
    dbStub.select.mockClear();
    dbStub.insert.mockClear();
    dbStub.update.mockClear();
    __resetPendingSessionsForTests();
  });
  afterEach(() => {
    for (const k of ENV_KEYS) {
      if (originalEnv[k] === undefined) delete process.env[k];
      else process.env[k] = originalEnv[k];
    }
    __resetPendingSessionsForTests();
  });

  it("returns 503 voice_not_configured when env is missing", async () => {
    stubVerifiedOperator();
    process.env.RESUPPLY_OPERATOR_EMAILS = ALLOWED_EMAIL;
    const res = await request(makeApp())
      .post("/resupply-api/voice/place-call")
      .send({ patientId: PATIENT_ID, episodeId: EPISODE_ID });
    expect(res.status).toBe(503);
    expect(res.body.error).toBe("voice_not_configured");
  });

  it("returns 401 when there is no Clerk session", async () => {
    setVoiceEnv();
    getAuthMock.mockReturnValue({ userId: null });
    const res = await request(makeApp())
      .post("/resupply-api/voice/place-call")
      .send({ patientId: PATIENT_ID, episodeId: EPISODE_ID });
    expect(res.status).toBe(401);
  });

  it("returns 400 on invalid body", async () => {
    setVoiceEnv();
    stubVerifiedOperator();
    const res = await request(makeApp())
      .post("/resupply-api/voice/place-call")
      .send({ patientId: "not-a-uuid" });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_body");
  });

  it("returns 404 when patient does not exist", async () => {
    setVoiceEnv();
    stubVerifiedOperator();
    selectQueue.push([]); // patient lookup → empty
    const res = await request(makeApp())
      .post("/resupply-api/voice/place-call")
      .send({ patientId: PATIENT_ID, episodeId: EPISODE_ID });
    expect(res.status).toBe(404);
    expect(res.body.error).toBe("patient_not_found");
  });

  it("returns 422 when patient has no phone", async () => {
    setVoiceEnv();
    stubVerifiedOperator();
    selectQueue.push([
      { id: PATIENT_ID, phoneE164: null, status: "active" },
    ]);
    const res = await request(makeApp())
      .post("/resupply-api/voice/place-call")
      .send({ patientId: PATIENT_ID, episodeId: EPISODE_ID });
    expect(res.status).toBe(422);
    expect(res.body.error).toBe("patient_missing_phone");
  });

  it("returns 422 on episode/patient mismatch", async () => {
    setVoiceEnv();
    stubVerifiedOperator();
    selectQueue.push([
      { id: PATIENT_ID, phoneE164: "+12155551212", status: "active" },
    ]);
    selectQueue.push([
      { id: EPISODE_ID, patientId: "44444444-4444-4444-8444-444444444444" },
    ]);
    const res = await request(makeApp())
      .post("/resupply-api/voice/place-call")
      .send({ patientId: PATIENT_ID, episodeId: EPISODE_ID });
    expect(res.status).toBe(422);
    expect(res.body.error).toBe("episode_patient_mismatch");
  });

  it("dials Twilio, creates conversation, registers pending session, audits, returns 201", async () => {
    setVoiceEnv();
    stubVerifiedOperator();
    selectQueue.push([
      { id: PATIENT_ID, phoneE164: "+12155551212", status: "active" },
    ]);
    selectQueue.push([{ id: EPISODE_ID, patientId: PATIENT_ID }]);
    insertQueue.push([{ id: CONVERSATION_ID }]);
    updateQueue.push(undefined);
    placeCallMock.mockResolvedValue({ sid: "CA_TEST_123" });

    const res = await request(makeApp())
      .post("/resupply-api/voice/place-call")
      .send({ patientId: PATIENT_ID, episodeId: EPISODE_ID });

    expect(res.status).toBe(201);
    expect(res.body).toEqual({
      conversationId: CONVERSATION_ID,
      callSid: "CA_TEST_123",
    });

    // Twilio was called with the expected URL shape.
    expect(placeCallMock).toHaveBeenCalledTimes(1);
    const call = placeCallMock.mock.calls[0][0];
    expect(call.to).toBe("+12155551212");
    expect(call.from).toBe("+12158675309");
    expect(call.url).toBe(
      `https://test.example.com/resupply-api/voice/twiml-connect?conversationId=${CONVERSATION_ID}`,
    );
    expect(call.statusCallbackUrl).toBe(
      `https://test.example.com/resupply-api/voice/status-callback?conversationId=${CONVERSATION_ID}`,
    );

    // Pending-session entry is registered AND stamped with the CallSid.
    const entry = getPendingSessions().peek(CONVERSATION_ID);
    expect(entry?.patientId).toBe(PATIENT_ID);
    expect(entry?.episodeId).toBe(EPISODE_ID);
    expect(entry?.twilioCallSid).toBe("CA_TEST_123");

    // Audit row emitted with status=ok and PHI-free metadata.
    expect(logAuditMock).toHaveBeenCalledTimes(1);
    const audit = logAuditMock.mock.calls[0][0];
    expect(audit.action).toBe("voice.call.placed");
    expect(audit.targetTable).toBe("conversations");
    expect(audit.targetId).toBe(CONVERSATION_ID);
    expect(audit.metadata.status).toBe("ok");
    expect(audit.metadata.twilio_call_sid).toBe("CA_TEST_123");
    // Should NOT carry the phone number (PHI).
    expect(JSON.stringify(audit.metadata)).not.toContain("+12155551212");
  });

  it("returns 502 + audits twilio_error when Twilio API rejects", async () => {
    setVoiceEnv();
    stubVerifiedOperator();
    selectQueue.push([
      { id: PATIENT_ID, phoneE164: "+12155551212", status: "active" },
    ]);
    selectQueue.push([{ id: EPISODE_ID, patientId: PATIENT_ID }]);
    insertQueue.push([{ id: CONVERSATION_ID }]);
    const { TwilioApiError } = await import("@workspace/resupply-telecom");
    placeCallMock.mockRejectedValue(
      new TwilioApiError("rejected by upstream", 400, 21211),
    );

    const res = await request(makeApp())
      .post("/resupply-api/voice/place-call")
      .send({ patientId: PATIENT_ID, episodeId: EPISODE_ID });

    expect(res.status).toBe(502);
    expect(res.body.error).toBe("twilio_api_error");
    expect(res.body.twilioStatus).toBe(400);

    // We DO audit the failed attempt — operator initiated the call,
    // the dashboard timeline must show that.
    expect(logAuditMock).toHaveBeenCalledTimes(1);
    expect(logAuditMock.mock.calls[0][0].metadata.status).toBe("twilio_error");
  });
});
