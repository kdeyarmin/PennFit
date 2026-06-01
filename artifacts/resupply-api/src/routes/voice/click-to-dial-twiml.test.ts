// Route tests for POST /voice/click-to-dial-twiml (CSR #11 bridge leg).
//
// The signature middleware is replaced with a passthrough — the
// signature algorithm is covered in
// lib/resupply-telecom/src/signature.test.ts; these focus on the
// disposition→patient→Dial lookup and the soft Hangup fallbacks.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import express, { type Express } from "express";
import request from "supertest";

import {
  installSupabaseMock,
  stageSupabaseResponse,
} from "../../test-helpers/supabase-mock";

const supabaseMock = installSupabaseMock();

vi.mock("@workspace/resupply-telecom", async () => {
  const actual = await vi.importActual<
    typeof import("@workspace/resupply-telecom")
  >("@workspace/resupply-telecom");
  return {
    ...actual,
    requireTwilioSignature:
      () =>
      (_req: unknown, _res: unknown, next: (err?: unknown) => void): void =>
        next(),
  };
});

import clickToDialTwimlRouter from "./click-to-dial-twiml";

const PATIENT_ID = "11111111-1111-4111-8111-111111111111";
const DISPOSITION_ID = "22222222-2222-4222-8222-222222222222";

function makeApp(): Express {
  const app = express();
  app.use(express.urlencoded({ extended: false }));
  app.use(clickToDialTwimlRouter);
  return app;
}

const VOICE_ENV: Record<string, string> = {
  OPENAI_API_KEY: "test-openai",
  TWILIO_ACCOUNT_SID: "ACtest",
  TWILIO_AUTH_TOKEN: "test-token",
  TWILIO_PHONE_NUMBER: "+12158675309",
  RESUPPLY_VOICE_PUBLIC_BASE_URL: "https://test.example.com",
};

beforeEach(() => {
  supabaseMock.reset();
  for (const [k, v] of Object.entries(VOICE_ENV)) process.env[k] = v;
});
afterEach(() => {
  for (const k of Object.keys(VOICE_ENV)) delete process.env[k];
});

describe("POST /voice/click-to-dial-twiml", () => {
  it("hangs up (200) when dispositionId is missing", async () => {
    const res = await request(makeApp()).post("/voice/click-to-dial-twiml");
    expect(res.status).toBe(200);
    expect(res.text).toContain("<Hangup/>");
  });

  it("hangs up when the disposition/patient can't be found", async () => {
    stageSupabaseResponse("call_dispositions", "select", { data: null });
    const res = await request(makeApp()).post(
      `/voice/click-to-dial-twiml?dispositionId=${DISPOSITION_ID}`,
    );
    expect(res.status).toBe(200);
    expect(res.text).toContain("<Hangup/>");
  });

  it("bridges by Dialing the patient when everything resolves", async () => {
    stageSupabaseResponse("call_dispositions", "select", {
      data: { id: DISPOSITION_ID, patient_id: PATIENT_ID },
    });
    stageSupabaseResponse("patients", "select", {
      data: { phone_e164: "+12155551212" },
    });
    const res = await request(makeApp()).post(
      `/voice/click-to-dial-twiml?dispositionId=${DISPOSITION_ID}`,
    );
    expect(res.status).toBe(200);
    expect(res.text).toContain("<Dial");
    expect(res.text).toContain("+12155551212");
    expect(res.text).toContain('callerId="+12158675309"');
  });

  it("hangs up when the patient has no phone on file", async () => {
    stageSupabaseResponse("call_dispositions", "select", {
      data: { id: DISPOSITION_ID, patient_id: PATIENT_ID },
    });
    stageSupabaseResponse("patients", "select", { data: { phone_e164: null } });
    const res = await request(makeApp()).post(
      `/voice/click-to-dial-twiml?dispositionId=${DISPOSITION_ID}`,
    );
    expect(res.status).toBe(200);
    expect(res.text).toContain("<Hangup/>");
  });
});
