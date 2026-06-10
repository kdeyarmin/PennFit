// Route tests for POST /voice/realtime-diagnostic — the no-patient
// "connection test" entrypoint. Focus: the two gates (env flag + voice
// config) and that an ENABLED call registers a `diagnostic` pending
// session pointing the WS upgrade at the isolated bridge.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import express, { type Express } from "express";
import request from "supertest";

// ── Twilio signature: passthrough; capture the Connect/Stream args ───────────
const { capture } = vi.hoisted(() => ({
  capture: {
    connect: null as null | {
      wsUrl: string;
      customParameters?: Record<string, string>;
    },
  },
}));
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
    buildHangupTwiml: (msg: string) =>
      `<?xml version="1.0" encoding="UTF-8"?><Response><Say>${msg}</Say><Hangup/></Response>`,
    buildConnectStreamTwiml: (args: {
      wsUrl: string;
      customParameters?: Record<string, string>;
    }) => {
      capture.connect = args;
      return `<?xml version="1.0" encoding="UTF-8"?><Response><Connect><Stream url="${args.wsUrl}"/></Connect></Response>`;
    },
  };
});

const { loggerMock } = vi.hoisted(() => ({
  loggerMock: { error: vi.fn(), warn: vi.fn(), info: vi.fn() },
}));
vi.mock("../../lib/logger", () => ({ logger: loggerMock }));

import realtimeDiagnosticRouter from "./realtime-diagnostic";
import {
  getPendingSessions,
  __resetPendingSessionsForTests,
} from "../../lib/voice/pending-sessions";

const ENV_KEYS = [
  "OPENAI_API_KEY",
  "TWILIO_ACCOUNT_SID",
  "TWILIO_AUTH_TOKEN",
  "RESUPPLY_VOICE_PUBLIC_BASE_URL",
  "OPENAI_REALTIME_DIAGNOSTIC_ENABLED",
] as const;
type EnvKey = (typeof ENV_KEYS)[number];
const saved: Partial<Record<EnvKey, string | undefined>> = {};

function buildApp(): Express {
  const app = express();
  app.use(express.urlencoded({ extended: false }));
  app.use(express.json());
  app.use(realtimeDiagnosticRouter);
  return app;
}

function setVoiceEnv(): void {
  process.env.OPENAI_API_KEY = "sk-test";
  process.env.TWILIO_ACCOUNT_SID = "AC_test";
  process.env.TWILIO_AUTH_TOKEN = "tok_test";
  process.env.RESUPPLY_VOICE_PUBLIC_BASE_URL = "https://preview.example.com";
}

describe("POST /voice/realtime-diagnostic", () => {
  beforeEach(() => {
    for (const k of ENV_KEYS) saved[k] = process.env[k];
    capture.connect = null;
    __resetPendingSessionsForTests();
    vi.clearAllMocks();
  });
  afterEach(() => {
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    __resetPendingSessionsForTests();
  });

  it("503s with a hangup when voice config is missing", async () => {
    setVoiceEnv();
    delete process.env.OPENAI_API_KEY; // break the config
    process.env.OPENAI_REALTIME_DIAGNOSTIC_ENABLED = "1";
    const res = await request(buildApp())
      .post("/voice/realtime-diagnostic")
      .send("CallSid=CA123");
    expect(res.status).toBe(503);
    expect(getPendingSessions().size()).toBe(0);
  });

  it("is OFF by default — hangs up and registers NO session when the flag is unset", async () => {
    setVoiceEnv();
    delete process.env.OPENAI_REALTIME_DIAGNOSTIC_ENABLED;
    const res = await request(buildApp())
      .post("/voice/realtime-diagnostic")
      .send("CallSid=CA123");
    expect(res.status).toBe(200);
    expect(res.text).toContain("not enabled");
    expect(res.text).toContain("<Hangup/>");
    expect(getPendingSessions().size()).toBe(0);
  });

  it("when ENABLED: registers a no-patient diagnostic pending session and returns Connect/Stream TwiML", async () => {
    setVoiceEnv();
    process.env.OPENAI_REALTIME_DIAGNOSTIC_ENABLED = "true";
    const res = await request(buildApp())
      .post("/voice/realtime-diagnostic")
      .send("CallSid=CA456");
    expect(res.status).toBe(200);
    expect(res.text).toContain("<Connect><Stream");

    // Exactly one pending session, flagged diagnostic, with no patient.
    expect(getPendingSessions().size()).toBe(1);
    const conversationId = capture.connect?.customParameters?.conversationId;
    expect(conversationId).toBeTruthy();
    const entry = getPendingSessions().peek(conversationId!);
    expect(entry).not.toBeNull();
    expect(entry!.diagnostic).toBe(true);
    expect(entry!.patientId).toBe("");
    expect(entry!.episodeId).toBe("");
    // The WS URL routes back to the in-process voice-stream upgrade.
    expect(capture.connect?.wsUrl).toContain(
      "/resupply-api/voice/stream?conversationId=",
    );
  });

  it("the registered diagnostic context builds a valid system prompt (and the agent speaks first)", async () => {
    // Regression guard: buildSystemPrompt caps callContext at 250 chars
    // and THROWS over it. The previous diagnostic context ran 392 chars,
    // so the WS handler crashed on connect and every dial-in test call
    // was hung up the moment it was answered.
    const { buildSystemPrompt } = await import("@workspace/resupply-ai");
    setVoiceEnv();
    process.env.OPENAI_REALTIME_DIAGNOSTIC_ENABLED = "1";
    await request(buildApp())
      .post("/voice/realtime-diagnostic")
      .send("CallSid=CA789");
    const conversationId = capture.connect?.customParameters?.conversationId;
    const entry = getPendingSessions().peek(conversationId!);
    expect(entry).not.toBeNull();
    expect(entry!.callContext).toBeTruthy();
    expect(entry!.callContext!.length).toBeLessThanOrEqual(250);
    expect(() =>
      buildSystemPrompt({
        practiceName: "PennPaps",
        callContext: entry!.callContext!,
        ...(entry!.greeting ? { greeting: entry!.greeting } : {}),
      }),
    ).not.toThrow();
    // The operator dialed in — the agent must greet first, not wait in
    // silence for the caller to speak.
    expect(entry!.agentSpeaksFirst).toBe(true);
  });

  it("rejects a payload with no CallSid (400 hangup), no session registered", async () => {
    setVoiceEnv();
    process.env.OPENAI_REALTIME_DIAGNOSTIC_ENABLED = "1";
    const res = await request(buildApp())
      .post("/voice/realtime-diagnostic")
      .send("From=%2B15551234567");
    expect(res.status).toBe(400);
    expect(getPendingSessions().size()).toBe(0);
  });
});
