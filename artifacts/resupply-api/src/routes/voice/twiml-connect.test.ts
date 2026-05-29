// Route tests for POST /voice/twiml-connect.
//
// We replace the signature middleware with a passthrough — the
// signature algorithm is exhaustively tested in
// `lib/resupply-telecom/src/signature.test.ts`. These tests focus on
// the route's TwiML output and pending-session lookup behaviour.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import express, { type Express } from "express";
import request from "supertest";

vi.mock("@workspace/resupply-telecom", async () => {
  const actual = await vi.importActual<
    typeof import("@workspace/resupply-telecom")
  >("@workspace/resupply-telecom");
  return {
    ...actual,
    requireTwilioSignature:
      () =>
      (_req: unknown, _res: unknown, next: (err?: unknown) => void): void => {
        next();
      },
  };
});

import twimlConnectRouter from "./twiml-connect";
import {
  __resetPendingSessionsForTests,
  getPendingSessions,
} from "../../lib/voice/pending-sessions";

const ENV_KEYS = [
  "OPENAI_API_KEY",
  "TWILIO_ACCOUNT_SID",
  "TWILIO_AUTH_TOKEN",
  "RESUPPLY_VOICE_PUBLIC_BASE_URL",
] as const;
type EnvKey = (typeof ENV_KEYS)[number];
const originalEnv: Partial<Record<EnvKey, string | undefined>> = {};

function setVoiceEnv(): void {
  process.env.OPENAI_API_KEY = "test-openai-key";
  process.env.TWILIO_ACCOUNT_SID = "ACtest";
  process.env.TWILIO_AUTH_TOKEN = "test-twilio-token";
  process.env.RESUPPLY_VOICE_PUBLIC_BASE_URL = "https://test.example.com";
}

function makeApp(): Express {
  const app = express();
  app.use(express.urlencoded({ extended: false }));
  app.use("/resupply-api", twimlConnectRouter);
  return app;
}

describe("POST /voice/twiml-connect", () => {
  beforeEach(() => {
    for (const k of ENV_KEYS) originalEnv[k] = process.env[k];
    for (const k of ENV_KEYS) delete process.env[k];
    __resetPendingSessionsForTests();
  });
  afterEach(() => {
    for (const k of ENV_KEYS) {
      if (originalEnv[k] === undefined) delete process.env[k];
      else process.env[k] = originalEnv[k];
    }
    __resetPendingSessionsForTests();
  });

  it("returns hangup TwiML 200 when voice config is missing", async () => {
    // Don't set env. Signature middleware is mocked-out, so the route
    // body runs and short-circuits. The route deliberately returns 200
    // (not 503) with hangup TwiML so Twilio sees a clean disposition and
    // does NOT enter its 5xx exponential retry storm — see
    // twiml-connect.ts and the CodeRabbit fix on PR #409.
    const res = await request(makeApp())
      .post("/resupply-api/voice/twiml-connect?conversationId=c1")
      .type("form")
      .send({});
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toContain("text/xml");
    expect(res.text).toContain("<Hangup/>");
  });

  it("returns 400 hangup TwiML when conversationId is missing", async () => {
    setVoiceEnv();
    const res = await request(makeApp())
      .post("/resupply-api/voice/twiml-connect")
      .type("form")
      .send({});
    expect(res.status).toBe(400);
    expect(res.text).toContain("<Hangup/>");
  });

  it("returns 404 hangup TwiML when no pending session for the id", async () => {
    setVoiceEnv();
    const res = await request(makeApp())
      .post("/resupply-api/voice/twiml-connect?conversationId=c-unknown")
      .type("form")
      .send({});
    expect(res.status).toBe(404);
    expect(res.text).toContain("<Hangup/>");
  });

  it("returns Connect/Stream TwiML with wss URL + customParameter on success", async () => {
    setVoiceEnv();
    getPendingSessions().register({
      conversationId: "conv-1",
      patientId: "pat-1",
      episodeId: "ep-1",
    });
    const res = await request(makeApp())
      .post("/resupply-api/voice/twiml-connect?conversationId=conv-1")
      .type("form")
      .send({ CallSid: "CA1" });
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toContain("text/xml");
    expect(res.text).toContain("<Connect>");
    expect(res.text).toContain(
      'url="wss://test.example.com/resupply-api/voice/stream?conversationId=conv-1"',
    );
    expect(res.text).toContain('name="conversationId"');
    expect(res.text).toContain('value="conv-1"');

    // PEEK semantics — entry must STILL be present after the webhook
    // so the WS upgrade can claim it next.
    expect(getPendingSessions().peek("conv-1")).not.toBeNull();
  });
});
