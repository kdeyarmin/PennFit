// Route tests for POST /sms/inbound.
//
// Signature middleware is replaced with a passthrough — the signature
// behavior itself is exhaustively tested in @workspace/resupply-telecom.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import express, { type Express } from "express";
import request from "supertest";

vi.mock("@workspace/resupply-telecom", async () => {
  const actual =
    await vi.importActual<typeof import("@workspace/resupply-telecom")>(
      "@workspace/resupply-telecom",
    );
  return {
    ...actual,
    requireTwilioSignature: () =>
      (
        _req: unknown,
        _res: unknown,
        next: (err?: unknown) => void,
      ): void => {
        next();
      },
  };
});

function fluent(result: unknown) {
  const obj: Record<string, unknown> = {
    from: () => obj,
    where: () => obj,
    set: () => obj,
    values: () => obj,
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

const placeOrderMock = vi.fn();
const pausePatientMock = vi.fn();
vi.mock("../../lib/messaging/order-flow", () => ({
  placeResupplyOrderForConversation: (...a: unknown[]) => placeOrderMock(...a),
  pausePatient: (...a: unknown[]) => pausePatientMock(...a),
}));

// MMS ingestion — mocked at the module boundary so the route test
// can assert "we called ingest with the right shape" without
// stubbing fetch + GCS in here too (those concerns live in
// ingest-mms.test.ts).
const ingestMmsMock = vi.fn().mockResolvedValue({
  attempted: 0,
  succeeded: 0,
  rejected: 0,
  errored: 0,
});
vi.mock("../../lib/messaging/ingest-mms", () => ({
  ingestInboundMmsMedia: (...a: unknown[]) => ingestMmsMock(...a),
}));

import inboundRouter, {
  __setAiFallbackAdapterForTests,
} from "./inbound";

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
  "RESUPPLY_DATA_KEY",
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
  process.env.RESUPPLY_DATA_KEY = "00".repeat(32);
}

const FROM_PHONE = "+12155551212";

describe("POST /sms/inbound", () => {
  beforeEach(() => {
    for (const k of ENV_KEYS) originalEnv[k] = process.env[k];
    for (const k of ENV_KEYS) delete process.env[k];
    selectQueue.length = 0;
    insertQueue.length = 0;
    updateQueue.length = 0;
    logAuditMock.mockReset().mockResolvedValue(undefined);
    placeOrderMock.mockReset();
    pausePatientMock.mockReset().mockResolvedValue(undefined);
    ingestMmsMock.mockReset().mockResolvedValue({
      attempted: 0,
      succeeded: 0,
      rejected: 0,
      errored: 0,
    });
    dbStub.select.mockClear();
    dbStub.insert.mockClear();
    dbStub.update.mockClear();
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
    selectQueue.push([]); // phone lookup miss
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
    // PHI scrub: From not in body or audit.
    expect(logAuditMock).toHaveBeenCalledTimes(1);
    const audit = logAuditMock.mock.calls[0][0];
    expect(audit.action).toBe("messaging.inbound.received");
    expect(audit.metadata.outcome).toBe("unknown_phone");
    expect(JSON.stringify(audit.metadata)).not.toContain(FROM_PHONE);
  });

  it("audits ambiguous_phone and replies with router-guard boilerplate when two patients share a phone", async () => {
    // Family-plan / shared-line scenario: phone_e164 equality returns
    // multiple patients. We can't safely route the inbound to either
    // patient's conversation thread, so we audit, surface a generic
    // reply, and bail out before any conversation/messages writes.
    setMessagingEnv();
    selectQueue.push([
      { patientId: PATIENT_ID },
      { patientId: "99999999-9999-4999-8999-999999999999" },
    ]);
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
    // No conversation insert / message persist on the ambiguous path.
    expect(placeOrderMock).not.toHaveBeenCalled();
    // Single audit row, with the right outcome and PHI-scrubbed metadata.
    expect(logAuditMock).toHaveBeenCalledTimes(1);
    const audit = logAuditMock.mock.calls[0][0];
    expect(audit.action).toBe("messaging.inbound.received");
    expect(audit.metadata.outcome).toBe("ambiguous_phone");
    expect(audit.metadata.match_count).toBe(2);
    expect(JSON.stringify(audit.metadata)).not.toContain(FROM_PHONE);
  });

  it("dispatches confirm intent → places order, closes, audits ok", async () => {
    setMessagingEnv();
    selectQueue.push([{ patientId: PATIENT_ID }]); // phone_lookup hit
    // Forward-port of main commit 63de00e (Task #20): MessageSid
    // dedup pre-check runs after the phone lookup. Empty result =
    // "this SID has not been seen before, proceed normally".
    selectQueue.push([]); // sid_dedup miss
    selectQueue.push([{ id: CONVERSATION_ID }]); // open conversation
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
    expect(res.text).toMatch(/<Response><Message>.*refill is on its way/);
    expect(placeOrderMock).toHaveBeenCalledWith({
      conversationId: CONVERSATION_ID,
    });

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

  it("STOP keyword pauses patient + closes regardless of conversation context", async () => {
    setMessagingEnv();
    selectQueue.push([{ patientId: PATIENT_ID }]);
    selectQueue.push([]); // sid_dedup miss (Task #20 forward-port)
    selectQueue.push([{ id: CONVERSATION_ID }]);

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
    expect(res.text).toContain("unsubscribed");
    expect(pausePatientMock).toHaveBeenCalledWith(PATIENT_ID);
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

  it("AI fallback fires on unknown intent and steers dispatch", async () => {
    setMessagingEnv();
    selectQueue.push([{ patientId: PATIENT_ID }]);
    selectQueue.push([]); // sid_dedup miss (Task #20 forward-port)
    selectQueue.push([{ id: CONVERSATION_ID }]);
    // Recent thread fetch (decrypted) for AI context.
    selectQueue.push([]);
    placeOrderMock.mockResolvedValue({
      status: "ok",
      episodeId: EPISODE_ID,
      patientId: PATIENT_ID,
      fulfillmentIds: ["f1"],
    });

    const classifyMock = vi
      .fn()
      .mockResolvedValue({ intent: "confirm", reply: "Got it!" });
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
  });

  it("HELP returns boilerplate without dispatching anywhere", async () => {
    setMessagingEnv();
    selectQueue.push([{ patientId: PATIENT_ID }]);
    selectQueue.push([]); // sid_dedup miss (Task #20 forward-port)
    selectQueue.push([{ id: CONVERSATION_ID }]);

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
    expect(res.text).toContain("automated CPAP refill reminders");
    expect(placeOrderMock).not.toHaveBeenCalled();
    expect(pausePatientMock).not.toHaveBeenCalled();
  });

  it("ingests MMS media when NumMedia>0 and audits counts only", async () => {
    setMessagingEnv();
    selectQueue.push([{ patientId: PATIENT_ID }]); // phone_lookup hit
    selectQueue.push([]); // sid_dedup miss
    selectQueue.push([{ id: CONVERSATION_ID }]); // open conversation
    // Inbound message insert returns the new message id so the
    // ingest call has something to attach to.
    const INBOUND_MSG_ID = "44444444-4444-4444-8444-444444444444";
    insertQueue.push([{ id: INBOUND_MSG_ID }]);
    // The HELP path doesn't dispatch an order; outbound reply
    // insert pulls the next entry — empty is fine.
    insertQueue.push([]);

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
    expect(ingestArgs.messageId).toBe(INBOUND_MSG_ID);
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
    // PHI / linkability guard — counts-only payload. Audit row's
    // (targetTable, targetId) tuple already pins this to the
    // message; the metadata must NOT mirror conversation_id,
    // patient_id, or the Twilio message SID.
    const auditJson = JSON.stringify(ingestAudit?.metadata);
    expect(auditJson).not.toContain("ME001");
    expect(auditJson).not.toContain("ME002");
    expect(auditJson).not.toContain(FROM_PHONE);
    expect(auditJson).not.toContain(CONVERSATION_ID);
    expect(auditJson).not.toContain(PATIENT_ID);
    expect(auditJson).not.toContain("SM_mms");
  });

  // CARRIER COMPLIANCE — STOP/HELP must be honored even when we
  // can't map the inbound number to a patient. Twilio's Advanced
  // Opt-Out handles per-number suppression; we just emit the
  // canonical reply and audit so investigators can prove the
  // keyword was honored.

  it("STOP from unknown phone replies with STOP boilerplate + audits unknown_phone_stop", async () => {
    setMessagingEnv();
    selectQueue.push([]); // phone_lookup miss
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
    expect(res.text).toContain("unsubscribed");
    expect(res.text).toMatch(/<Response><Message>/);
    // No order placement, no pause (no patient_id to pause).
    expect(placeOrderMock).not.toHaveBeenCalled();
    expect(pausePatientMock).not.toHaveBeenCalled();
    expect(logAuditMock).toHaveBeenCalledTimes(1);
    const audit = logAuditMock.mock.calls[0][0];
    expect(audit.action).toBe("messaging.inbound.received");
    expect(audit.metadata.outcome).toBe("unknown_phone_stop");
    // PHI scrub.
    expect(JSON.stringify(audit.metadata)).not.toContain(FROM_PHONE);
  });

  it("HELP from unknown phone replies with HELP boilerplate + audits unknown_phone_help", async () => {
    setMessagingEnv();
    selectQueue.push([]); // phone_lookup miss
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
    expect(res.text).toContain("automated CPAP refill reminders");
    expect(placeOrderMock).not.toHaveBeenCalled();
    expect(pausePatientMock).not.toHaveBeenCalled();
    expect(logAuditMock).toHaveBeenCalledTimes(1);
    expect(logAuditMock.mock.calls[0][0].metadata.outcome).toBe(
      "unknown_phone_help",
    );
  });

  it("STOP from unparseable From still returns STOP boilerplate", async () => {
    setMessagingEnv();
    // No selectQueue entries — we never reach the phone_lookup query
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
    expect(res.text).toContain("unsubscribed");
    expect(logAuditMock).toHaveBeenCalledTimes(1);
    expect(logAuditMock.mock.calls[0][0].metadata.outcome).toBe(
      "unparseable_from_stop",
    );
  });
});
