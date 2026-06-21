// Route tests for POST /voice/inbound-breathe-sales — the CareMetric Breathe
// B2B platform sales line.
//
// Coverage:
//   1. Missing voice config → 503 hangup.
//   2. Called number is not the configured sales number → hangup.
//   3. Feature flag voice.breathe_sales disabled → hangup.
//   4. Configured + flag on → 200 Connect/Stream TwiML + a registered
//      breathe_prospect pending session (no patient, no orgId).

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import express, { type Express } from "express";
import request from "supertest";

// ── Twilio signature: passthrough; keep the real Connect/Stream builder ──────
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
  };
});

// ── Supabase mock (feature-flag lookup rides this) ───────────────────────────
import {
  installSupabaseMock,
  stageSupabaseResponse,
} from "../../test-helpers/supabase-mock";

const supabaseMock = installSupabaseMock();

// ── Logger mock ──────────────────────────────────────────────────────────────
const { loggerMock } = vi.hoisted(() => ({
  loggerMock: { error: vi.fn(), warn: vi.fn(), info: vi.fn() },
}));
vi.mock("../../lib/logger", () => ({ logger: loggerMock }));

import inboundBreatheSalesRouter from "./inbound-breathe-sales";
import {
  getPendingSessions,
  __resetPendingSessionsForTests,
} from "../../lib/voice/pending-sessions";
import { invalidateFeatureFlagCache } from "../../lib/feature-flags";

const ENV_KEYS = [
  "OPENAI_API_KEY",
  "TWILIO_ACCOUNT_SID",
  "TWILIO_AUTH_TOKEN",
  "RESUPPLY_VOICE_PUBLIC_BASE_URL",
  "BREATHE_SALES_VOICE_NUMBER",
] as const;
type EnvKey = (typeof ENV_KEYS)[number];
const savedEnv: Partial<Record<EnvKey, string | undefined>> = {};

const SALES_NUMBER = "+18005550100";

function setEnv(): void {
  process.env.OPENAI_API_KEY = "test-openai-key";
  process.env.TWILIO_ACCOUNT_SID = "ACtest";
  process.env.TWILIO_AUTH_TOKEN = "test-twilio-token";
  process.env.RESUPPLY_VOICE_PUBLIC_BASE_URL = "https://test.example.com";
  process.env.BREATHE_SALES_VOICE_NUMBER = SALES_NUMBER;
}

function makeApp(): Express {
  const app = express();
  app.use(express.urlencoded({ extended: false }));
  app.use(inboundBreatheSalesRouter);
  return app;
}

function post(body: Record<string, string>) {
  return request(makeApp())
    .post("/voice/inbound-breathe-sales")
    .type("form")
    .send(body);
}

const BASE_BODY = {
  From: "+12155551212",
  CallSid: "CA-test-sales",
  To: SALES_NUMBER,
};

beforeEach(() => {
  for (const k of ENV_KEYS) savedEnv[k] = process.env[k];
  for (const k of ENV_KEYS) delete process.env[k];
  supabaseMock.reset();
  invalidateFeatureFlagCache();
  __resetPendingSessionsForTests();
  loggerMock.error.mockReset();
  loggerMock.warn.mockReset();
  loggerMock.info.mockReset();
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
});

describe("POST /voice/inbound-breathe-sales", () => {
  it("returns 503 when voice config is missing", async () => {
    // No env set → readVoiceConfigOrNull() is null.
    process.env.BREATHE_SALES_VOICE_NUMBER = SALES_NUMBER;
    const res = await post(BASE_BODY);
    expect(res.status).toBe(503);
    expect(res.text).toContain("Hangup");
    expect(await getPendingSessions().size()).toBe(0);
  });

  it("hangs up when the called number is not the sales line", async () => {
    setEnv();
    const res = await post({ ...BASE_BODY, To: "+19998887777" });
    expect(res.status).toBe(200);
    expect(res.text).toContain("Hangup");
    expect(res.text).not.toContain("Stream");
    expect(await getPendingSessions().size()).toBe(0);
  });

  it("hangs up when the voice.breathe_sales flag is disabled", async () => {
    setEnv();
    stageSupabaseResponse("feature_flags", "select", {
      data: { enabled: false },
    });
    const res = await post(BASE_BODY);
    expect(res.status).toBe(200);
    expect(res.text).toContain("Hangup");
    expect(res.text).not.toContain("Stream");
    expect(await getPendingSessions().size()).toBe(0);
  });

  it("connects to the sales bridge and registers a breathe_prospect session", async () => {
    setEnv();
    stageSupabaseResponse("feature_flags", "select", {
      data: { enabled: true },
    });
    const res = await post(BASE_BODY);
    expect(res.status).toBe(200);
    expect(res.text).toContain("Connect");
    expect(res.text).toContain("Stream");

    // Exactly one pending session, bound to the sales persona with no
    // patient/episode/orgId and the agent speaking first.
    expect(await getPendingSessions().size()).toBe(1);
    const conversationId = res.text.match(
      /conversationId=([0-9a-fA-F-]{36})/,
    )?.[1];
    expect(conversationId).toBeTruthy();
    const pending = await getPendingSessions().peek(conversationId!);
    expect(pending).toBeTruthy();
    expect(pending?.callerKind).toBe("breathe_prospect");
    expect(pending?.orgId).toBeUndefined();
    expect(pending?.patientId).toBe("");
    expect(pending?.agentSpeaksFirst).toBe(true);
    expect(pending?.twilioCallSid).toBe("CA-test-sales");
  });
});
