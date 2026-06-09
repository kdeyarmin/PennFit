// Route tests for POST /voice/inbound-reorder — focused on the
// normalizeE164 fix introduced in this PR.
//
// Bug fixed: the previous caller-ID normalization used a naive
// `+${digits}` that produced `+2155551212` (no country code) for a
// bare 10-digit US number instead of the correct `+12155551212`.
// This meant a known caller with a standard 10-digit caller ID was
// never matched against patients.phone_e164 (which stores E.164
// with the country code), silently falling through as "unidentified".
//
// The fix delegates to normalizeE164 from @workspace/resupply-domain,
// which maps a 10-digit NANP number to +1XXXXXXXXXX.
//
// Coverage:
//   1. Passthrough — 503 when voice config is missing
//   2. 10-digit caller ID is normalized to +1XXXXXXXXXX before the
//      patients SELECT (regression guard for the naive-+digits bug)
//   3. normalizeE164 returning null (unparseable) → patient_not_identified
//   4. Already-E.164 caller ID works correctly
//   5. Empty/missing From → patient_not_identified
//   6. Identified caller → 200 TwiML with Dial

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import express, { type Express } from "express";
import request from "supertest";

// ── Twilio signature: passthrough ────────────────────────────────────────────
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

// ── Supabase mock ─────────────────────────────────────────────────────────────
import {
  installSupabaseMock,
  stageSupabaseResponse,
} from "../../test-helpers/supabase-mock";

const supabaseMock = installSupabaseMock();

// ── Logger mock ───────────────────────────────────────────────────────────────
const { loggerMock } = vi.hoisted(() => ({
  loggerMock: { error: vi.fn(), warn: vi.fn(), info: vi.fn() },
}));
vi.mock("../../lib/logger", () => ({ logger: loggerMock }));

import inboundReorderRouter from "./inbound-reorder";
import {
  getPendingSessions,
  __resetPendingSessionsForTests,
} from "../../lib/voice/pending-sessions";
import { invalidateFeatureFlagCache } from "../../lib/feature-flags";

// ── Environment management ────────────────────────────────────────────────────
const VOICE_ENV_KEYS = [
  "OPENAI_API_KEY",
  "TWILIO_ACCOUNT_SID",
  "TWILIO_AUTH_TOKEN",
  "RESUPPLY_VOICE_PUBLIC_BASE_URL",
] as const;
type VoiceEnvKey = (typeof VOICE_ENV_KEYS)[number];
const savedEnv: Partial<Record<VoiceEnvKey, string | undefined>> = {};

function setVoiceEnv(): void {
  process.env.OPENAI_API_KEY = "test-openai-key";
  process.env.TWILIO_ACCOUNT_SID = "ACtest";
  process.env.TWILIO_AUTH_TOKEN = "test-twilio-token";
  process.env.RESUPPLY_VOICE_PUBLIC_BASE_URL = "https://test.example.com";
}

function makeApp(): Express {
  const app = express();
  app.use(express.urlencoded({ extended: false }));
  app.use(inboundReorderRouter);
  return app;
}

// ── Helpers ───────────────────────────────────────────────────────────────────
const PATIENT_ID = "11111111-1111-4111-8111-111111111111";
const SESSION_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const EPISODE_ID = "22222222-2222-4222-8222-222222222222";
const CONVERSATION_ID = "33333333-3333-4333-8333-333333333333";

/** Stage the minimal DB calls for a single inbound reorder request. */
function stagePatientFound(): void {
  stageSupabaseResponse("patients", "select", { data: [{ id: PATIENT_ID }] });
  stageSupabaseResponse("voice_reorder_sessions", "insert", {
    data: { id: SESSION_ID },
  });
}

function stagePatientNotFound(): void {
  stageSupabaseResponse("patients", "select", { data: [] });
  stageSupabaseResponse("voice_reorder_sessions", "insert", {
    data: { id: SESSION_ID },
  });
}

// ── Test setup/teardown ───────────────────────────────────────────────────────
beforeEach(() => {
  for (const k of VOICE_ENV_KEYS) savedEnv[k] = process.env[k];
  for (const k of VOICE_ENV_KEYS) delete process.env[k];
  supabaseMock.reset();
  invalidateFeatureFlagCache();
  __resetPendingSessionsForTests();
  loggerMock.error.mockReset();
  loggerMock.warn.mockReset();
  loggerMock.info.mockReset();
});

afterEach(() => {
  for (const k of VOICE_ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
});

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("POST /voice/inbound-reorder — voice config guard", () => {
  it("returns 503 TwiML when voice config is not configured", async () => {
    // Don't set env vars. Route should 503 with hangup TwiML.
    const res = await request(makeApp())
      .post("/voice/inbound-reorder")
      .type("form")
      .send({ From: "+12155551212", CallSid: "CA_test_001" });
    expect(res.status).toBe(503);
    expect(res.headers["content-type"]).toContain("text/xml");
    expect(res.text).toContain("Hangup");
  });
});

describe("POST /voice/inbound-reorder — E.164 normalisation (regression guard)", () => {
  beforeEach(() => setVoiceEnv());

  it("queries patients with +1XXXXXXXXXX when From is a bare 10-digit NANP number", async () => {
    stagePatientNotFound();

    await request(makeApp())
      .post("/voice/inbound-reorder")
      .type("form")
      .send({ From: "2155551212", CallSid: "CA_10digit" });

    // The patients SELECT should have been called with the correctly
    // normalized +12155551212, NOT the naive +2155551212 from the old code.
    const filterCalls = supabaseMock.filterCalls("patients", "select");
    const eqCalls = filterCalls.filter((c) => c.verb === "eq");
    const phoneFilter = eqCalls.find((c) => c.args[0] === "phone_e164");
    expect(phoneFilter).toBeDefined();
    expect(phoneFilter!.args[1]).toBe("+12155551212");
  });

  it("does NOT query +2155551212 (the old naive-+ output) for a 10-digit number", async () => {
    stagePatientNotFound();

    await request(makeApp())
      .post("/voice/inbound-reorder")
      .type("form")
      .send({ From: "2155551212", CallSid: "CA_10digit_naive" });

    const filterCalls = supabaseMock.filterCalls("patients", "select");
    const eqCalls = filterCalls.filter((c) => c.verb === "eq");
    const phoneFilter = eqCalls.find((c) => c.args[0] === "phone_e164");
    // The old naive code would have produced "+2155551212" (7 digits after the
    // country position) — assert that value was NOT used.
    expect(phoneFilter?.args[1]).not.toBe("+2155551212");
  });

  it("queries with the correct +12155551212 for an 11-digit number starting with 1", async () => {
    stagePatientNotFound();

    await request(makeApp())
      .post("/voice/inbound-reorder")
      .type("form")
      .send({ From: "12155551212", CallSid: "CA_11digit" });

    const filterCalls = supabaseMock.filterCalls("patients", "select");
    const phoneFilter = filterCalls.find(
      (c) => c.verb === "eq" && c.args[0] === "phone_e164",
    );
    expect(phoneFilter?.args[1]).toBe("+12155551212");
  });

  it("passes through an already-E.164 caller ID unchanged", async () => {
    stagePatientFound();

    await request(makeApp())
      .post("/voice/inbound-reorder")
      .type("form")
      .send({ From: "+12155551212", CallSid: "CA_e164" });

    const filterCalls = supabaseMock.filterCalls("patients", "select");
    const phoneFilter = filterCalls.find(
      (c) => c.verb === "eq" && c.args[0] === "phone_e164",
    );
    expect(phoneFilter?.args[1]).toBe("+12155551212");
  });
});

describe("POST /voice/inbound-reorder — unidentified caller paths", () => {
  beforeEach(() => setVoiceEnv());

  it("treats an unparseable From (e.g. 4-digit number) as unidentified without querying patients", async () => {
    // normalizeE164("1234") → null (too few digits) → skip DB query
    stageSupabaseResponse("voice_reorder_sessions", "insert", {
      data: { id: SESSION_ID },
    });

    const res = await request(makeApp())
      .post("/voice/inbound-reorder")
      .type("form")
      .send({ From: "1234", CallSid: "CA_short" });

    expect(res.status).toBe(200);
    // The patients table must not have been queried at all.
    expect(supabaseMock.callCount("patients", "select")).toBe(0);
    // Response should be the unidentified-caller Dial TwiML.
    expect(res.text).toContain("<Dial");
  });

  it("returns 200 TwiML with Dial when caller is not identified (no matching patient)", async () => {
    stagePatientNotFound();

    const res = await request(makeApp())
      .post("/voice/inbound-reorder")
      .type("form")
      .send({ From: "+12155559999", CallSid: "CA_unknown" });

    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toContain("text/xml");
    expect(res.text).toContain("<Dial");
    expect(res.text).toContain("couldn't match");
  });

  it("treats empty string From as unidentified without querying patients", async () => {
    stageSupabaseResponse("voice_reorder_sessions", "insert", {
      data: { id: SESSION_ID },
    });

    const res = await request(makeApp())
      .post("/voice/inbound-reorder")
      .type("form")
      .send({ From: "", CallSid: "CA_empty" });

    expect(res.status).toBe(200);
    expect(supabaseMock.callCount("patients", "select")).toBe(0);
  });
});

describe("POST /voice/inbound-reorder — identified caller path", () => {
  beforeEach(() => setVoiceEnv());

  it("returns 200 TwiML with Dial when caller IS identified", async () => {
    stagePatientFound();

    const res = await request(makeApp())
      .post("/voice/inbound-reorder")
      .type("form")
      .send({ From: "+12155550001", CallSid: "CA_known" });

    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toContain("text/xml");
    expect(res.text).toContain("<Dial");
    expect(res.text).toContain("Welcome");
  });

  it("creates a voice_reorder_sessions row with status in_progress for identified caller", async () => {
    stagePatientFound();

    await request(makeApp())
      .post("/voice/inbound-reorder")
      .type("form")
      .send({ From: "+12155550001", CallSid: "CA_known_sid" });

    const inserts = supabaseMock.writePayloads(
      "voice_reorder_sessions",
      "insert",
    ) as Array<Record<string, unknown>>;
    expect(inserts).toHaveLength(1);
    expect(inserts[0]).toMatchObject({
      twilio_call_sid: "CA_known_sid",
      patient_id: PATIENT_ID,
      status: "in_progress",
    });
  });

  it("transfers to a human (never binds to a patient) when the caller number is on multiple accounts", async () => {
    // Two patients share the caller-ID number. We must NOT auto-bind the
    // patient-scoped AI reorder agent to an arbitrary one — mirror the SMS
    // handler's ambiguous-phone guard and route to a human instead.
    stageSupabaseResponse("patients", "select", {
      data: [
        { id: PATIENT_ID },
        { id: "99999999-9999-4999-8999-999999999999" },
      ],
    });
    stageSupabaseResponse("voice_reorder_sessions", "insert", {
      data: { id: SESSION_ID },
    });

    const res = await request(makeApp())
      .post("/voice/inbound-reorder")
      .type("form")
      .send({ From: "+12155550001", CallSid: "CA_shared" });

    expect(res.status).toBe(200);
    // Routed to a human, NOT connected to the patient-scoped media bridge.
    expect(res.text).not.toContain("<Connect");
    expect(res.text).toContain("<Dial");
    // The session row must not be bound to either patient.
    const inserts = supabaseMock.writePayloads(
      "voice_reorder_sessions",
      "insert",
    ) as Array<Record<string, unknown>>;
    expect(inserts[0]).toMatchObject({ patient_id: null });
  });
});

describe("POST /voice/inbound-reorder — session insert failure", () => {
  beforeEach(() => setVoiceEnv());

  it("returns 500 TwiML when voice_reorder_sessions insert fails", async () => {
    stageSupabaseResponse("patients", "select", { data: [{ id: PATIENT_ID }] });
    stageSupabaseResponse("voice_reorder_sessions", "insert", {
      error: { message: "db error" },
    });

    const res = await request(makeApp())
      .post("/voice/inbound-reorder")
      .type("form")
      .send({ From: "+12155550001", CallSid: "CA_insert_fail" });

    expect(res.status).toBe(500);
    expect(res.text).toContain("Hangup");
  });
});

describe("POST /voice/inbound-reorder — invalid body", () => {
  beforeEach(() => setVoiceEnv());

  it("returns 400 TwiML when CallSid is missing", async () => {
    const res = await request(makeApp())
      .post("/voice/inbound-reorder")
      .type("form")
      .send({ From: "+12155551212" }); // no CallSid

    expect(res.status).toBe(400);
    expect(res.text).toContain("Hangup");
  });
});

describe("POST /voice/inbound-reorder — identified caller → realtime bridge", () => {
  beforeEach(() => setVoiceEnv());

  function stageIdentifiedWithEpisode(flagEnabled: boolean): void {
    stageSupabaseResponse("patients", "select", { data: [{ id: PATIENT_ID }] });
    stageSupabaseResponse("voice_reorder_sessions", "insert", {
      data: { id: SESSION_ID },
    });
    stageSupabaseResponse("feature_flags", "select", {
      data: { enabled: flagEnabled },
    });
    stageSupabaseResponse("episodes", "select", {
      data: {
        id: EPISODE_ID,
        status: "outreach_pending",
        created_at: new Date().toISOString(),
      },
    });
    stageSupabaseResponse("conversations", "insert", {
      data: { id: CONVERSATION_ID },
    });
  }

  it("connects an identified caller with an actionable episode to the Media Stream bridge", async () => {
    stageIdentifiedWithEpisode(true);

    const res = await request(makeApp())
      .post("/voice/inbound-reorder")
      .type("form")
      .send({ From: "+12155551212", CallSid: "CA_bridge" });

    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toContain("text/xml");
    // Connect/Stream TwiML pointing at the existing voice bridge.
    expect(res.text).toContain("<Connect");
    expect(res.text).toContain("<Stream");
    expect(res.text).toContain(
      "wss://test.example.com/resupply-api/voice/stream",
    );
    expect(res.text).toContain(CONVERSATION_ID);
    expect(res.text).toContain('<Parameter name="conversationId"');
    // A voice conversation was created and a pending session registered
    // with the inbound-flavored context + greeting.
    expect(supabaseMock.callCount("conversations", "insert")).toBe(1);
    const pending = getPendingSessions().peek(CONVERSATION_ID);
    expect(pending).not.toBeNull();
    expect(pending!.patientId).toBe(PATIENT_ID);
    expect(pending!.episodeId).toBe(EPISODE_ID);
    expect(pending!.callContext).toBeTruthy();
    expect(pending!.greeting).toBeTruthy();
  });

  it("transfers to a human when the voice agent is disabled in the Control Center", async () => {
    stageIdentifiedWithEpisode(false);

    const res = await request(makeApp())
      .post("/voice/inbound-reorder")
      .type("form")
      .send({ From: "+12155551212", CallSid: "CA_flag_off" });

    expect(res.status).toBe(200);
    expect(res.text).toContain("<Dial");
    expect(res.text).toContain("Connecting you to our team");
    // No bridge: no conversation row, no pending session.
    expect(supabaseMock.callCount("conversations", "insert")).toBe(0);
    expect(getPendingSessions().peek(CONVERSATION_ID)).toBeNull();
  });

  it("transfers to a human when the patient has no actionable episode", async () => {
    stageSupabaseResponse("patients", "select", { data: [{ id: PATIENT_ID }] });
    stageSupabaseResponse("voice_reorder_sessions", "insert", {
      data: { id: SESSION_ID },
    });
    stageSupabaseResponse("feature_flags", "select", {
      data: { enabled: true },
    });
    stageSupabaseResponse("episodes", "select", { data: null });

    const res = await request(makeApp())
      .post("/voice/inbound-reorder")
      .type("form")
      .send({ From: "+12155551212", CallSid: "CA_no_episode" });

    expect(res.status).toBe(200);
    expect(res.text).toContain("<Dial");
    expect(supabaseMock.callCount("conversations", "insert")).toBe(0);
    expect(getPendingSessions().peek(CONVERSATION_ID)).toBeNull();
  });
});

describe("POST /voice/inbound-reorder — storefront caller resolution", () => {
  beforeEach(() => setVoiceEnv());

  it("records the matched storefront customer id on the session when only a shop_customer matches", async () => {
    // No patient on this number, but a cash-pay storefront customer is.
    // The resolver falls through to shop_customers; the session row must
    // capture the match (shop_customer_id) with patient_id left null.
    stageSupabaseResponse("patients", "select", { data: [] });
    stageSupabaseResponse("shop_customers", "select", {
      data: [{ customer_id: "cust_store_1" }],
    });
    stageSupabaseResponse("voice_reorder_sessions", "insert", {
      data: { id: SESSION_ID },
    });

    await request(makeApp())
      .post("/voice/inbound-reorder")
      .type("form")
      .send({ From: "+12155557777", CallSid: "CA_shop" });

    const inserts = supabaseMock.writePayloads(
      "voice_reorder_sessions",
      "insert",
    ) as Array<Record<string, unknown>>;
    expect(inserts).toHaveLength(1);
    expect(inserts[0]).toMatchObject({
      shop_customer_id: "cust_store_1",
      patient_id: null,
    });
  });

  it("returns a 500 hangup when caller resolution hits a DB error (no silent mis-route)", async () => {
    // The patients lookup errors → resolveCallerByPhone throws → the route
    // must surface it as a retryable failure, NOT silently route as
    // unidentified. No session row should be written.
    stageSupabaseResponse("patients", "select", {
      error: { message: "db down" },
    });

    const res = await request(makeApp())
      .post("/voice/inbound-reorder")
      .type("form")
      .send({ From: "+12155551212", CallSid: "CA_db_err" });

    expect(res.status).toBe(500);
    expect(res.text).toContain("Hangup");
    expect(supabaseMock.callCount("voice_reorder_sessions", "insert")).toBe(0);
  });
});
