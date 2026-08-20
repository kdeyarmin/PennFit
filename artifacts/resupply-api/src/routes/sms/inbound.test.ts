// Route tests for POST /sms/inbound.
//
// Signature middleware is replaced with a passthrough — the signature
// behavior itself is exhaustively tested in @workspace/resupply-telecom.

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

import {
  installSupabaseMock,
  stageSupabaseResponse,
} from "../../test-helpers/supabase-mock";

const supabaseMock = installSupabaseMock();

const logAuditMock = vi.fn().mockResolvedValue(undefined);
vi.mock("@workspace/resupply-audit", () => ({
  logAudit: (...a: unknown[]) => logAuditMock(...a),
}));

const placeOrderMock = vi.fn();
const pausePatientMock = vi.fn();
const reactivatePatientMock = vi.fn();
vi.mock("../../lib/messaging/order-flow", () => ({
  placeResupplyOrderForConversation: (...a: unknown[]) => placeOrderMock(...a),
  pausePatient: (...a: unknown[]) => pausePatientMock(...a),
  reactivatePatient: (...a: unknown[]) => reactivatePatientMock(...a),
}));

// MMS ingestion — mocked at the module boundary so the route test
// can assert "we called ingest with the right shape" without
// stubbing fetch + GCS in here too.
const ingestMmsMock = vi.fn().mockResolvedValue({
  attempted: 0,
  succeeded: 0,
  rejected: 0,
  errored: 0,
});
vi.mock("../../lib/messaging/ingest-mms", () => ({
  ingestInboundMmsMedia: (...a: unknown[]) => ingestMmsMock(...a),
}));

import inboundRouter, { __setAiFallbackAdapterForTests } from "./inbound";
import { invalidateTenantTelecomCache } from "../../lib/messaging/tenant-telecom";

const SEED_ORG = "00000000-0000-4000-8000-000000000000"; // matches the mock's resolveSeedOrgId
const PATIENT_ID = "11111111-1111-4111-8111-111111111111";
const EPISODE_ID = "22222222-2222-4222-8222-222222222222";
const CONVERSATION_ID = "33333333-3333-4333-8333-333333333333";

function makeApp(): Express {
  const app = express();
  app.use(express.urlencoded({ extended: false }));
  app.use("/resupply-api", inboundRouter);
  return app;
}

const ENV_KEYS = [
  "TWILIO_ACCOUNT_SID",
  "TWILIO_AUTH_TOKEN",
  "TWILIO_PHONE_NUMBER",
  "SENDGRID_API_KEY",
  "SENDGRID_FROM_EMAIL",
  "SENDGRID_FROM_NAME",
  "SENDGRID_EVENT_WEBHOOK_PUBLIC_KEY",
  "RESUPPLY_LINK_HMAC_KEY",
  "RESUPPLY_VOICE_PUBLIC_BASE_URL",
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
  process.env.RESUPPLY_LINK_HMAC_KEY =
    "QkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkI=";
  process.env.RESUPPLY_VOICE_PUBLIC_BASE_URL = "https://test.example.com";
}

const FROM_PHONE = "+12155551212";

// Stage the standard "known patient → existing conversation"
// supabase response sequence the dispatch path expects:
//   1. patients SELECT (phone_lookup hit)
//   2. messages SELECT (sid_dedup miss)
//   3. conversations SELECT (open thread)
//   4. messages INSERT (inbound)
//   5. conversations UPDATE (last_message_at stamp) — null/no-error
// Everything beyond that (outbound reply insert, conversation close,
// AI thread fetch) is unstaged so the mock returns the default
// { data: null, error: null } envelope, which the route tolerates.
function stageKnownPatientFlow(): void {
  // The shared To number isn't tenant-owned, so the handler first runs the
  // cross-org patient-phone resolver. Returning no cross-org rows makes it
  // fall back to the seed org, where the main lookup below finds the patient.
  stageSupabaseResponse("patients", "select", { data: [] });
  stageSupabaseResponse("patients", "select", { data: [{ id: PATIENT_ID }] });
  stageSupabaseResponse("messages", "select", { data: null });
  stageSupabaseResponse("conversations", "select", {
    data: { id: CONVERSATION_ID },
  });
  stageSupabaseResponse("messages", "insert", {
    data: { id: "44444444-4444-4444-8444-444444444444" },
  });
}

describe("POST /sms/inbound", () => {
  beforeEach(() => {
    for (const k of ENV_KEYS) originalEnv[k] = process.env[k];
    for (const k of ENV_KEYS) delete process.env[k];
    supabaseMock.reset();
    // The tenant-telecom resolvers cache by phone number at module scope;
    // clear it so a prior test's routing result doesn't leak into the next.
    invalidateTenantTelecomCache();
    logAuditMock.mockReset().mockResolvedValue(undefined);
    placeOrderMock.mockReset();
    pausePatientMock.mockReset().mockResolvedValue(undefined);
    reactivatePatientMock.mockReset().mockResolvedValue(undefined);
    ingestMmsMock.mockReset().mockResolvedValue({
      attempted: 0,
      succeeded: 0,
      rejected: 0,
      errored: 0,
    });
    __setAiFallbackAdapterForTests(null);
  });
  afterEach(() => {
    for (const k of ENV_KEYS) {
      if (originalEnv[k] === undefined) delete process.env[k];
      else process.env[k] = originalEnv[k];
    }
    __setAiFallbackAdapterForTests(null);
  });

  it("returns 503 TwiML when messaging is not configured", async () => {
    const res = await request(makeApp())
      .post("/resupply-api/sms/inbound")
      .type("form")
      .send({
        From: FROM_PHONE,
        To: "+12158675309",
        Body: "YES",
        MessageSid: "SM1",
        NumMedia: "0",
      });
    expect(res.status).toBe(503);
    expect(res.text).toContain("Service temporarily unavailable");
  });

  it("audits unknown_phone and replies with opt-out boilerplate", async () => {
    setMessagingEnv();
    stageSupabaseResponse("patients", "select", { data: [] });
    const res = await request(makeApp())
      .post("/resupply-api/sms/inbound")
      .type("form")
      .send({
        From: FROM_PHONE,
        To: "+12158675309",
        Body: "yes please",
        MessageSid: "SM_unknown",
        NumMedia: "0",
      });
    expect(res.status).toBe(200);
    expect(res.text).toContain("This number isn't set up");
    expect(logAuditMock).toHaveBeenCalledTimes(1);
    const audit = logAuditMock.mock.calls[0][0];
    expect(audit.action).toBe("messaging.inbound.received");
    expect(audit.metadata.outcome).toBe("unknown_phone");
    expect(JSON.stringify(audit.metadata)).not.toContain(FROM_PHONE);
  });

  it("audits ambiguous_phone and replies with router-guard boilerplate when two patients share a phone", async () => {
    setMessagingEnv();
    // Cross-org resolver finds nothing → seed; the seed lookup then returns
    // two patients on one phone → ambiguous.
    stageSupabaseResponse("patients", "select", { data: [] });
    stageSupabaseResponse("patients", "select", {
      data: [
        { id: PATIENT_ID },
        { id: "99999999-9999-4999-8999-999999999999" },
      ],
    });
    const res = await request(makeApp())
      .post("/resupply-api/sms/inbound")
      .type("form")
      .send({
        From: FROM_PHONE,
        To: "+12158675309",
        Body: "yes please",
        MessageSid: "SM_ambig",
        NumMedia: "0",
      });
    expect(res.status).toBe(200);
    expect(res.text).toContain("This number is on multiple accounts");
    expect(placeOrderMock).not.toHaveBeenCalled();
    expect(logAuditMock).toHaveBeenCalledTimes(1);
    const audit = logAuditMock.mock.calls[0][0];
    expect(audit.action).toBe("messaging.inbound.received");
    expect(audit.metadata.outcome).toBe("ambiguous_phone");
    expect(audit.metadata.match_count).toBe(2);
    expect(JSON.stringify(audit.metadata)).not.toContain(FROM_PHONE);
  });

  it("shared number: routes a reply to the tenant that owns the patient (even when the seed org also has that phone)", async () => {
    // The reply lands on the SHARED platform number (To not owned by any
    // tenant). The phone exists in BOTH the seed org and ORG_B, so the
    // cross-org resolver — which is authoritative for shared numbers — picks
    // ORG_B (most recent conversation) and the message is processed THERE,
    // NOT in the seed org. This is the duplicate-phone case that a seed-first
    // lookup would have misrouted.
    const ORG_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    setMessagingEnv();
    // Resolver: phone in seed + ORG_B → tie-break via conversations → ORG_B.
    stageSupabaseResponse("patients", "select", {
      data: [
        { id: "seed-patient", org_id: SEED_ORG },
        { id: PATIENT_ID, org_id: ORG_B },
      ],
    });
    stageSupabaseResponse("conversations", "select", {
      data: { org_id: ORG_B, last_message_at: "2026-06-20T00:00:00.000Z" },
    });
    // Main lookup, now scoped to ORG_B, then the known-patient dispatch flow.
    stageSupabaseResponse("patients", "select", { data: [{ id: PATIENT_ID }] });
    stageSupabaseResponse("messages", "select", { data: null });
    stageSupabaseResponse("conversations", "select", {
      data: { id: CONVERSATION_ID },
    });
    stageSupabaseResponse("messages", "insert", {
      data: { id: "44444444-4444-4444-8444-444444444444" },
    });
    stageSupabaseResponse("messages", "select", {
      data: { body: "Reply YES to confirm your refill." },
    });
    placeOrderMock.mockResolvedValue({
      status: "ok",
      episodeId: EPISODE_ID,
      patientId: PATIENT_ID,
      fulfillmentIds: ["f1"],
    });

    const res = await request(makeApp())
      .post("/resupply-api/sms/inbound")
      .type("form")
      .send({
        From: FROM_PHONE,
        To: "+12158675309", // the shared platform number
        Body: "YES",
        MessageSid: "SM_shared",
        NumMedia: "0",
      });

    expect(res.status).toBe(200);
    // The inbound message was recorded under ORG_B (the org-scoped client
    // stamps org_id onto the insert), proving it routed to the right tenant
    // and not the seed org despite the seed org having the same phone.
    const insert = supabaseMock.writePayloads("messages", "insert")[0] as {
      org_id?: string;
    };
    expect(insert.org_id).toBe(ORG_B);
    expect(placeOrderMock).toHaveBeenCalled();
  });

  it("dispatches confirm intent → places order, closes, audits ok", async () => {
    setMessagingEnv();
    stageKnownPatientFlow();
    // Last outbound prompt ASKED the attestation (default reminder copy),
    // so the YES records the refill attestation.
    stageSupabaseResponse("messages", "select", {
      data: {
        body:
          "Hi Sam, it's PennPaps. Time for a CPAP refill. Reply YES if you " +
          "still use it and are low on supplies, EDIT to change address, " +
          "STOP to opt out.",
      },
    });
    placeOrderMock.mockResolvedValue({
      status: "ok",
      episodeId: EPISODE_ID,
      patientId: PATIENT_ID,
      fulfillmentIds: ["f1", "f2"],
    });

    const res = await request(makeApp())
      .post("/resupply-api/sms/inbound")
      .type("form")
      .send({
        From: FROM_PHONE,
        To: "+12158675309",
        Body: "YES",
        MessageSid: "SM_yes",
        NumMedia: "0",
      });

    expect(res.status).toBe(200);
    expect(res.text).toMatch(/<Response><Message>.*supplies are on the way/);
    expect(placeOrderMock).toHaveBeenCalledWith(
      expect.objectContaining({
        conversationId: CONVERSATION_ID,
        // The YES reply carries the Medicare/payer refill attestation.
        affirmation: expect.objectContaining({
          channel: "sms",
          continuedUse: true,
          supplyLow: true,
        }),
      }),
    );

    const audits = logAuditMock.mock.calls.map((c) => c[0]);
    const intentAudit = audits.find(
      (a) => a.action === "messaging.intent.parsed",
    );
    expect(intentAudit?.metadata.intent).toBe("confirm");
    expect(intentAudit?.metadata.resolved_by).toBe("keyword");
    const orderAudit = audits.find(
      (a) => a.action === "messaging.order.confirmed",
    );
    expect(orderAudit).toBeDefined();
    expect(orderAudit?.metadata.episode_id).toBe(EPISODE_ID);
    // Inbound body never logged.
    for (const a of audits) {
      expect(JSON.stringify(a.metadata)).not.toContain("YES");
    }
  });

  it("confirm on a legacy/custom prompt that did NOT ask the attestation places the order WITHOUT recording a (false) attestation", async () => {
    setMessagingEnv();
    stageKnownPatientFlow();
    // Last outbound prompt was a custom body that did not ask the
    // continued-use / running-low questions → no attestation captured.
    stageSupabaseResponse("messages", "select", {
      data: {
        body: "Your CPAP refill is ready. Reply YES to ship, STOP to opt out.",
      },
    });
    placeOrderMock.mockResolvedValue({
      status: "ok",
      episodeId: EPISODE_ID,
      patientId: PATIENT_ID,
      fulfillmentIds: ["f1"],
    });

    const res = await request(makeApp())
      .post("/resupply-api/sms/inbound")
      .type("form")
      .send({
        From: FROM_PHONE,
        To: "+12158675309",
        Body: "YES",
        MessageSid: "SM_yes_legacy",
        NumMedia: "0",
      });

    expect(res.status).toBe(200);
    // Order still placed — the YES is a valid order confirmation.
    expect(placeOrderMock).toHaveBeenCalledTimes(1);
    // ...but with NO affirmation, so no false attestation is recorded.
    expect(placeOrderMock.mock.calls[0][0].affirmation).toBeUndefined();
  });

  it("dispatches confirm intent → coverage_blocked holds for CSR, audits blocked_coverage", async () => {
    setMessagingEnv();
    stageKnownPatientFlow();
    placeOrderMock.mockResolvedValue({
      status: "coverage_blocked",
      episodeId: EPISODE_ID,
      patientId: PATIENT_ID,
      coverage: {
        reason: "prior_auth_required",
        payerName: "Cigna",
        eligibilityCheckId: "elig-9",
      },
    });

    const res = await request(makeApp())
      .post("/resupply-api/sms/inbound")
      .type("form")
      .send({
        From: FROM_PHONE,
        To: "+12158675309",
        Body: "YES",
        MessageSid: "SM_yes_cov",
        NumMedia: "0",
      });

    expect(res.status).toBe(200);
    expect(res.text).toMatch(/check your insurance coverage/);
    const audits = logAuditMock.mock.calls.map((c) => c[0]);
    const blockedAudit = audits.find(
      (a) => a.action === "messaging.order.blocked_coverage",
    );
    expect(blockedAudit).toBeDefined();
    expect(blockedAudit?.metadata.coverage_reason).toBe("prior_auth_required");
    expect(blockedAudit?.metadata.eligibility_check_id).toBe("elig-9");
  });

  it("STOP keyword pauses patient + closes regardless of conversation context", async () => {
    setMessagingEnv();
    stageKnownPatientFlow();

    const res = await request(makeApp())
      .post("/resupply-api/sms/inbound")
      .type("form")
      .send({
        From: FROM_PHONE,
        To: "+12158675309",
        Body: "stop",
        MessageSid: "SM_stop",
        NumMedia: "0",
      });
    expect(res.status).toBe(200);
    expect(res.text).toContain("not get any more texts");
    // SMS-only opt-out: the reply scopes to texts (not "messages"), since
    // marketing email keeps its own separate opt-out.
    expect(res.text).toContain("texts");
    // orgId is now threaded from the called-number's tenant so STOP
    // opts the patient out in the right tenant (not always the seed org).
    expect(pausePatientMock).toHaveBeenCalledWith(
      PATIENT_ID,
      expect.any(String),
    );
    const handoffAudit = logAuditMock.mock.calls
      .map((c) => c[0])
      .find(
        (a) =>
          a.action === "messaging.handoff.escalated" &&
          a.metadata.reason === "stop_keyword",
      );
    expect(handoffAudit).toBeDefined();
    expect(handoffAudit?.metadata.patient_status).toBe("paused");
  });

  it("START keyword reactivates the patient + closes the conversation", async () => {
    setMessagingEnv();
    stageKnownPatientFlow();

    const res = await request(makeApp())
      .post("/resupply-api/sms/inbound")
      .type("form")
      .send({
        From: FROM_PHONE,
        To: "+12158675309",
        Body: "START",
        MessageSid: "SM_start",
        NumMedia: "0",
      });
    expect(res.status).toBe(200);
    expect(res.text).toContain("back on");
    expect(reactivatePatientMock).toHaveBeenCalledWith(
      PATIENT_ID,
      expect.any(String),
    );
    expect(pausePatientMock).not.toHaveBeenCalled();
    const startAudit = logAuditMock.mock.calls
      .map((c) => c[0])
      .find(
        (a) =>
          a.action === "messaging.handoff.escalated" &&
          a.metadata.reason === "start_keyword",
      );
    expect(startAudit).toBeDefined();
    expect(startAudit?.metadata.patient_status).toBe("active");
  });

  it("AI fallback fires on unknown intent and steers dispatch", async () => {
    setMessagingEnv();
    stageKnownPatientFlow();
    // Recent thread fetch (decrypted) for AI context.
    stageSupabaseResponse("messages", "select", { data: [] });
    placeOrderMock.mockResolvedValue({
      status: "ok",
      episodeId: EPISODE_ID,
      patientId: PATIENT_ID,
      fulfillmentIds: ["f1"],
    });

    // High-confidence confirm — the dispatch gate (see inbound.ts)
    // requires confidence >= 0.7 before an action intent (confirm /
    // decline / edit_address) is honoured. 0.95 reflects the model
    // being very sure.
    const classifyMock = vi.fn().mockResolvedValue({
      intent: "confirm",
      reply: "Got it!",
      confidence: 0.95,
    });
    __setAiFallbackAdapterForTests({ classify: classifyMock });

    const res = await request(makeApp())
      .post("/resupply-api/sms/inbound")
      .type("form")
      .send({
        From: FROM_PHONE,
        To: "+12158675309",
        Body: "sounds great just send my stuff",
        MessageSid: "SM_unknown_text",
        NumMedia: "0",
      });
    expect(res.status).toBe(200);
    expect(classifyMock).toHaveBeenCalledTimes(1);
    expect(res.text).toContain("Got it!");
    const intentAudit = logAuditMock.mock.calls
      .map((c) => c[0])
      .find((a) => a.action === "messaging.intent.parsed");
    expect(intentAudit?.metadata.intent).toBe("confirm");
    expect(intentAudit?.metadata.resolved_by).toBe("ai");
    expect(intentAudit?.metadata.low_confidence_override).toBeUndefined();
  });

  it("folds a model-written reply to GSM-7 before sending it", async () => {
    // The source-literal guard in inbound.gsm7.test.ts cannot see text
    // composed at runtime. A model reply is exactly that: the system
    // prompt asks for plain ASCII, but a prompt is guidance, not a
    // guarantee. One em-dash would flip the whole SMS to UCS-2 (70-char
    // segments instead of 160), so the route folds every reply body.
    setMessagingEnv();
    stageKnownPatientFlow();
    stageSupabaseResponse("messages", "select", { data: [] });

    const classifyMock = vi.fn().mockResolvedValue({
      intent: "unknown",
      reply: "Thanks \u2014 we\u2019ll follow up\u2026 caf\u00e9 Cl\u00ednica",
      confidence: 0.3,
    });
    __setAiFallbackAdapterForTests({ classify: classifyMock });

    const res = await request(makeApp())
      .post("/resupply-api/sms/inbound")
      .type("form")
      .send({
        From: FROM_PHONE,
        To: "+12158675309",
        Body: "what is going on here",
        MessageSid: "SM_gsm7_ai_reply",
        NumMedia: "0",
      });

    expect(res.status).toBe(200);
    const body = /<Message>([\s\S]*?)<\/Message>/.exec(res.text)?.[1] ?? "";
    expect(body).not.toBe("");
    // Typographic punctuation folded to ASCII...
    expect(body).toContain("Thanks - we&apos;ll follow up...");
    // ...accents GSM-7 already covers are kept (they cost nothing)...
    expect(body).toContain("caf\u00e9");
    // ...and one it does not cover is reduced to its base letter.
    expect(body).toContain("Clinica");
    // Nothing left that would trigger UCS-2.
    expect(body).not.toMatch(/[\u2010-\u2027\u2030-\u205e]/);
  });

  it("gates action intents when AI confidence is missing", async () => {
    setMessagingEnv();
    stageKnownPatientFlow();
    stageSupabaseResponse("messages", "select", { data: [] });

    const classifyMock = vi.fn().mockResolvedValue({
      intent: "confirm",
      reply: "Got it!",
    });
    __setAiFallbackAdapterForTests({ classify: classifyMock });

    const res = await request(makeApp())
      .post("/resupply-api/sms/inbound")
      .type("form")
      .send({
        From: FROM_PHONE,
        To: "+12158675309",
        Body: "well maybe",
        MessageSid: "SM_missing_conf",
        NumMedia: "0",
      });

    expect(res.status).toBe(200);
    expect(placeOrderMock).not.toHaveBeenCalled();
    const intentAudit = logAuditMock.mock.calls
      .map((c) => c[0])
      .find((a) => a.action === "messaging.intent.parsed");
    expect(intentAudit?.metadata.intent).toBe("unknown");
    expect(intentAudit?.metadata.low_confidence_override).toBe(true);
  });

  it("honours high-confidence non-action AI intents without gating", async () => {
    setMessagingEnv();
    stageKnownPatientFlow();
    stageSupabaseResponse("messages", "select", { data: [] });

    // STOP-class intents (stop/help/unknown) do not trigger
    // side-effects on the order pipeline, so they are NOT gated even
    // at low confidence. This ensures the safety gate doesn't hide
    // legitimate handoff signals from a slightly-uncertain model.
    const classifyMock = vi.fn().mockResolvedValue({
      intent: "unknown",
      reply: "Thanks — a teammate will reach out.",
      confidence: 0.5,
    });
    __setAiFallbackAdapterForTests({ classify: classifyMock });

    // "what is this" is two tokens — confirm `parseSmsIntent` returns
    // unknown here. (HELP would match "help"; STOP would match "stop".)
    const res = await request(makeApp())
      .post("/resupply-api/sms/inbound")
      .type("form")
      .send({
        From: FROM_PHONE,
        To: "+12158675309",
        Body: "wait who is this",
        MessageSid: "SM_unkn_lowconf",
        NumMedia: "0",
      });
    expect(res.status).toBe(200);
    expect(placeOrderMock).not.toHaveBeenCalled();
    const intentAudit = logAuditMock.mock.calls
      .map((c) => c[0])
      .find((a) => a.action === "messaging.intent.parsed");
    expect(intentAudit?.metadata.intent).toBe("unknown");
    expect(intentAudit?.metadata.low_confidence_override).toBeUndefined();
  });

  it("HELP returns boilerplate without dispatching anywhere", async () => {
    setMessagingEnv();
    stageKnownPatientFlow();

    const res = await request(makeApp())
      .post("/resupply-api/sms/inbound")
      .type("form")
      .send({
        From: FROM_PHONE,
        To: "+12158675309",
        Body: "HELP",
        MessageSid: "SM_help",
        NumMedia: "0",
      });
    expect(res.status).toBe(200);
    expect(res.text).toContain("when your CPAP supplies are due");
    expect(placeOrderMock).not.toHaveBeenCalled();
    expect(pausePatientMock).not.toHaveBeenCalled();
  });

  it("ingests MMS media when NumMedia>0 and audits counts only", async () => {
    setMessagingEnv();
    stageKnownPatientFlow();

    ingestMmsMock.mockResolvedValueOnce({
      attempted: 2,
      succeeded: 2,
      rejected: 0,
      errored: 0,
    });

    const res = await request(makeApp())
      .post("/resupply-api/sms/inbound")
      .type("form")
      .send({
        From: FROM_PHONE,
        To: "+12158675309",
        Body: "HELP",
        MessageSid: "SM_mms",
        NumMedia: "2",
        MediaUrl0:
          "https://api.twilio.com/2010-04-01/Accounts/ACtest/Messages/MMabc/Media/ME001",
        MediaContentType0: "image/jpeg",
        MediaUrl1:
          "https://api.twilio.com/2010-04-01/Accounts/ACtest/Messages/MMabc/Media/ME002",
        MediaContentType1: "image/png",
      });
    expect(res.status).toBe(200);
    // Ingest was called with the persisted message id and the raw
    // webhook body (so MediaUrlN are reachable).
    expect(ingestMmsMock).toHaveBeenCalledTimes(1);
    const ingestArgs = ingestMmsMock.mock.calls[0][0];
    expect(ingestArgs.messageId).toBe("44444444-4444-4444-8444-444444444444");
    expect(ingestArgs.numMedia).toBe(2);
    expect(ingestArgs.twilioAccountSid).toBe("ACtest");
    expect(ingestArgs.twilioAuthToken).toBe("test-twilio-token");
    expect(ingestArgs.rawWebhookBody.MediaUrl0).toContain("ME001");
    expect(ingestArgs.rawWebhookBody.MediaUrl1).toContain("ME002");
    // Counts-only audit was emitted with no PHI.
    const audits = logAuditMock.mock.calls.map((c) => c[0]);
    const ingestAudit = audits.find(
      (a) => a.action === "messaging.inbound.media_ingested",
    );
    expect(ingestAudit).toBeDefined();
    expect(ingestAudit?.metadata).toMatchObject({
      attempted: 2,
      succeeded: 2,
      rejected: 0,
      errored: 0,
    });
    // PHI / linkability guard — counts-only payload.
    const auditJson = JSON.stringify(ingestAudit?.metadata);
    expect(auditJson).not.toContain("ME001");
    expect(auditJson).not.toContain("ME002");
    expect(auditJson).not.toContain(FROM_PHONE);
    expect(auditJson).not.toContain(CONVERSATION_ID);
    expect(auditJson).not.toContain(PATIENT_ID);
    expect(auditJson).not.toContain("SM_mms");
  });

  // CARRIER COMPLIANCE — STOP/HELP must be honored even when we
  // can't map the inbound number to a patient.

  it("STOP from unknown phone replies with STOP boilerplate + audits unknown_phone_stop", async () => {
    setMessagingEnv();
    stageSupabaseResponse("patients", "select", { data: [] });
    const res = await request(makeApp())
      .post("/resupply-api/sms/inbound")
      .type("form")
      .send({
        From: FROM_PHONE,
        To: "+12158675309",
        Body: "STOP",
        MessageSid: "SM_unknown_stop",
        NumMedia: "0",
      });
    expect(res.status).toBe(200);
    expect(res.text).toContain("not get any more texts");
    expect(res.text).toMatch(/<Response><Message>/);
    expect(placeOrderMock).not.toHaveBeenCalled();
    expect(pausePatientMock).not.toHaveBeenCalled();
    expect(logAuditMock).toHaveBeenCalledTimes(1);
    const audit = logAuditMock.mock.calls[0][0];
    expect(audit.action).toBe("messaging.inbound.received");
    expect(audit.metadata.outcome).toBe("unknown_phone_stop");
    expect(JSON.stringify(audit.metadata)).not.toContain(FROM_PHONE);
  });

  it("HELP from unknown phone replies with HELP boilerplate + audits unknown_phone_help", async () => {
    setMessagingEnv();
    stageSupabaseResponse("patients", "select", { data: [] });
    const res = await request(makeApp())
      .post("/resupply-api/sms/inbound")
      .type("form")
      .send({
        From: FROM_PHONE,
        To: "+12158675309",
        Body: "help",
        MessageSid: "SM_unknown_help",
        NumMedia: "0",
      });
    expect(res.status).toBe(200);
    expect(res.text).toContain("when your CPAP supplies are due");
    expect(placeOrderMock).not.toHaveBeenCalled();
    expect(pausePatientMock).not.toHaveBeenCalled();
    expect(logAuditMock).toHaveBeenCalledTimes(1);
    expect(logAuditMock.mock.calls[0][0].metadata.outcome).toBe(
      "unknown_phone_help",
    );
  });

  it("STOP from unparseable From still returns STOP boilerplate", async () => {
    setMessagingEnv();
    // No supabase stages — we never reach the phone_lookup query
    // because normalizeE164 rejects the From first.
    const res = await request(makeApp())
      .post("/resupply-api/sms/inbound")
      .type("form")
      .send({
        From: "garbage-not-a-phone",
        To: "+12158675309",
        Body: "STOP",
        MessageSid: "SM_garbage_stop",
        NumMedia: "0",
      });
    expect(res.status).toBe(200);
    expect(res.text).toContain("not get any more texts");
    expect(logAuditMock).toHaveBeenCalledTimes(1);
    expect(logAuditMock.mock.calls[0][0].metadata.outcome).toBe(
      "unparseable_from_stop",
    );
  });
});
