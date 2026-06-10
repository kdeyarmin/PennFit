// Tests for the chatbot email auto-reply path in POST /email/inbound-parse.
//
// These live in a separate file from inbound-parse.test.ts so the
// module-level mocks (feature flag ON, an LLM provider configured, and a
// stubbed generator/SendGrid client) don't change the baseline
// "route-to-a-human" behavior the sibling file asserts.
//
// Coverage:
//   * Generator returns a reply → email sent via SendGrid, outbound
//     message persisted with auto_reply metadata, conversation flipped to
//     awaiting_patient, messaging.reply.sent audit fired.
//   * Generator hands off → no outbound send, conversation flipped to
//     awaiting_admin (the pre-existing behavior).

import { beforeEach, describe, expect, it, vi } from "vitest";
import express, { type Express } from "express";
import request from "supertest";

import {
  installSupabaseMock,
  stageSupabaseResponse,
  getSupabaseWritePayloads,
  getSupabaseCallCount,
} from "../../test-helpers/supabase-mock";

const supabaseMock = installSupabaseMock();

// Email config present (full EmailConfig shape so the SendGrid client can
// be constructed).
vi.mock("../../lib/messaging/messaging-config", () => ({
  readEmailConfigOrNull: () => ({
    sendgridApiKey: "SG.test",
    sendgridFromEmail: "info@pennpaps.com",
    sendgridFromName: "PennPaps",
    sendgridEventWebhookPublicKey: "pk",
    publicBaseUrl: "https://pennpaps.example",
  }),
}));

// Feature flag ON.
vi.mock("../../lib/feature-flags", () => ({
  isFeatureEnabled: async () => true,
}));

// A provider is configured (route's cheap pre-check before the flag read).
vi.mock("../../lib/llm-provider", () => ({
  selectLlmProvider: () => ({ provider: "openai" }),
}));

// Stub the generator so we can drive both outcomes deterministically.
const generateEmailReplyMock = vi.fn();
vi.mock("../../lib/messaging/email-auto-reply", () => ({
  generateEmailReply: (input: unknown) => generateEmailReplyMock(input),
}));

// Stub the SendGrid client.
const sendEmailMock = vi.fn(async (_input: unknown) => ({
  messageId: "sg-out-1",
}));
vi.mock("@workspace/resupply-email", () => ({
  createSendgridClient: () => ({ sendEmail: sendEmailMock }),
  EmailApiError: class EmailApiError extends Error {},
  EmailConfigError: class EmailConfigError extends Error {},
}));

const safeAuditMock = vi.fn(async (_event: unknown) => undefined);
vi.mock("../../lib/messaging/safe-audit", () => ({
  safeAudit: (event: unknown) => safeAuditMock(event),
}));

import inboundParseRouter from "./inbound-parse";

const BASIC_AUTH_VALUE = "sg_user:correct-horse";

function buildApp(): Express {
  const app = express();
  app.use((req, _res, next) => {
    (req as unknown as { log: typeof console }).log = {
      info: () => {},
      warn: () => {},
      error: () => {},
      debug: () => {},
      trace: () => {},
      fatal: () => {},
    } as never;
    next();
  });
  app.use(inboundParseRouter);
  return app;
}

function stageMatchedPatientWithOpenThread(): void {
  stageSupabaseResponse("patients", "select", { data: [{ id: "patient-1" }] });
  stageSupabaseResponse("conversations", "select", { data: { id: "conv-1" } });
  // Inbound message insert.
  stageSupabaseResponse("messages", "insert", { data: { id: "msg-in" } });
  // last_message_at stamp (step 6).
  stageSupabaseResponse("conversations", "update", { error: null });
  // Thread fetch inside attemptEmailAutoReply.
  stageSupabaseResponse("messages", "select", { data: [] });
  // Outbound reply insert.
  stageSupabaseResponse("messages", "insert", { data: { id: "msg-out" } });
  // Final status flip (step 9).
  stageSupabaseResponse("conversations", "update", { error: null });
}

beforeEach(() => {
  supabaseMock.reset();
  safeAuditMock.mockClear();
  sendEmailMock.mockClear();
  generateEmailReplyMock.mockReset();
  process.env.SENDGRID_INBOUND_PARSE_BASIC_AUTH = BASIC_AUTH_VALUE;
});

describe("POST /email/inbound-parse — auto-reply", () => {
  it("sends a reply and flips to awaiting_patient when the bot answers", async () => {
    generateEmailReplyMock.mockResolvedValue({
      kind: "reply",
      reply: "Hi!\n\nFull-face masks are the way to go.\n\n— The PennPaps Team",
    });
    stageMatchedPatientWithOpenThread();

    const res = await request(buildApp())
      .post("/email/inbound-parse")
      .auth("sg_user", "correct-horse")
      .field("from", "Patient <patient@example.com>")
      .field("subject", "Mask question")
      .field("text", "Do nasal masks work for mouth breathers?");

    expect(res.status).toBe(200);

    // The reply was sent to the patient's address with a Re: subject.
    expect(sendEmailMock).toHaveBeenCalledTimes(1);
    const sent = sendEmailMock.mock.calls[0]![0] as Record<string, unknown>;
    expect(sent.to).toBe("patient@example.com");
    expect(sent.subject).toBe("Re: Mask question");
    expect((sent.customArgs as Record<string, string>).kind).toBe(
      "email_auto_reply",
    );

    // Two message inserts: the inbound + the outbound auto-reply.
    const inserts = getSupabaseWritePayloads("messages", "insert") as Record<
      string,
      unknown
    >[];
    expect(inserts).toHaveLength(2);
    const outbound = inserts[1]!;
    expect(outbound.direction).toBe("outbound");
    expect(outbound.sender_role).toBe("agent");
    const meta = outbound.vendor_metadata as Record<string, unknown>;
    expect(meta.auto_reply).toBe(true);
    expect(meta.sendgrid_message_id).toBe("sg-out-1");

    // Conversation ends awaiting_patient (the bot answered).
    const updates = getSupabaseWritePayloads(
      "conversations",
      "update",
    ) as Record<string, unknown>[];
    expect(updates.some((u) => u.status === "awaiting_patient")).toBe(true);
    expect(updates.some((u) => u.status === "awaiting_admin")).toBe(false);

    // A reply-sent audit fired with the auto_reply marker.
    const replyAudit = safeAuditMock.mock.calls
      .map((c) => c[0] as { action: string; metadata: Record<string, unknown> })
      .find((e) => e.action === "messaging.reply.sent");
    expect(replyAudit).toBeDefined();
    expect(replyAudit!.metadata.auto_reply).toBe(true);
    expect(replyAudit!.metadata.channel).toBe("email");
  });

  it("routes to a human (awaiting_admin) when the bot hands off", async () => {
    generateEmailReplyMock.mockResolvedValue({ kind: "handoff" });
    stageSupabaseResponse("patients", "select", {
      data: [{ id: "patient-1" }],
    });
    stageSupabaseResponse("conversations", "select", {
      data: { id: "conv-1" },
    });
    stageSupabaseResponse("messages", "insert", { data: { id: "msg-in" } });
    stageSupabaseResponse("conversations", "update", { error: null });
    // Thread fetch still happens before the generator decides to hand off.
    stageSupabaseResponse("messages", "select", { data: [] });
    stageSupabaseResponse("conversations", "update", { error: null });

    const res = await request(buildApp())
      .post("/email/inbound-parse")
      .auth("sg_user", "correct-horse")
      .field("from", "patient@example.com")
      .field("text", "Where is my order?");

    expect(res.status).toBe(200);
    // No email sent, only the inbound message persisted.
    expect(sendEmailMock).not.toHaveBeenCalled();
    expect(getSupabaseCallCount("messages", "insert")).toBe(1);

    const updates = getSupabaseWritePayloads(
      "conversations",
      "update",
    ) as Record<string, unknown>[];
    expect(updates.some((u) => u.status === "awaiting_admin")).toBe(true);
  });

  // Replay + amplification guards (app-review 2026-06-10, P1-6). Both
  // suppressions hand the thread to a human BEFORE the model runs — a
  // replayed/spoofed inbound email must never trigger another LLM call
  // or another outbound reply.

  it("suppresses the auto-reply for a replayed Message-ID (held dedup key)", async () => {
    generateEmailReplyMock.mockResolvedValue({ kind: "reply", reply: "hi" });
    stageSupabaseResponse("patients", "select", {
      data: [{ id: "patient-1" }],
    });
    stageSupabaseResponse("conversations", "select", {
      data: { id: "conv-1" },
    });
    stageSupabaseResponse("messages", "insert", { data: { id: "msg-in" } });
    stageSupabaseResponse("conversations", "update", { error: null });
    // Message-ID dedup claim: an UNEXPIRED key already owns it.
    stageSupabaseResponse("worker_dedup_keys", "delete", { error: null });
    stageSupabaseResponse("worker_dedup_keys", "insert", {
      data: null,
      error: { code: "23505", message: "duplicate key" },
    });
    // Final status flip.
    stageSupabaseResponse("conversations", "update", { error: null });

    const res = await request(buildApp())
      .post("/email/inbound-parse")
      .auth("sg_user", "correct-horse")
      .field("from", "patient@example.com")
      .field("subject", "Mask question")
      .field("headers", "Message-ID: <replayed-id@example.com>\r\n")
      .field("text", "Do nasal masks work for mouth breathers?");

    expect(res.status).toBe(200);
    // Suppressed BEFORE the model and before any send.
    expect(generateEmailReplyMock).not.toHaveBeenCalled();
    expect(sendEmailMock).not.toHaveBeenCalled();
    const updates = getSupabaseWritePayloads(
      "conversations",
      "update",
    ) as Record<string, unknown>[];
    expect(updates.some((u) => u.status === "awaiting_admin")).toBe(true);
    // The key is a hash, never the raw Message-ID (joinable pseudo-id).
    const keys = getSupabaseWritePayloads("worker_dedup_keys", "insert").map(
      (p) => (p as { key: string }).key,
    );
    expect(keys[0]).toMatch(/^email-auto-reply:msgid:[0-9a-f]{64}$/);
  });

  it("caps a sender to one auto-reply per window (held sender bucket)", async () => {
    generateEmailReplyMock.mockResolvedValue({ kind: "reply", reply: "hi" });
    stageSupabaseResponse("patients", "select", {
      data: [{ id: "patient-1" }],
    });
    stageSupabaseResponse("conversations", "select", {
      data: { id: "conv-1" },
    });
    stageSupabaseResponse("messages", "insert", { data: { id: "msg-in" } });
    stageSupabaseResponse("conversations", "update", { error: null });
    // No Message-ID header on this request → the first dedup claim IS
    // the sender bucket; it's already held.
    stageSupabaseResponse("worker_dedup_keys", "delete", { error: null });
    stageSupabaseResponse("worker_dedup_keys", "insert", {
      data: null,
      error: { code: "23505", message: "duplicate key" },
    });
    stageSupabaseResponse("conversations", "update", { error: null });

    const res = await request(buildApp())
      .post("/email/inbound-parse")
      .auth("sg_user", "correct-horse")
      .field("from", "patient@example.com")
      .field("text", "Another question already?");

    expect(res.status).toBe(200);
    expect(generateEmailReplyMock).not.toHaveBeenCalled();
    expect(sendEmailMock).not.toHaveBeenCalled();
    const updates = getSupabaseWritePayloads(
      "conversations",
      "update",
    ) as Record<string, unknown>[];
    expect(updates.some((u) => u.status === "awaiting_admin")).toBe(true);
    const keys = getSupabaseWritePayloads("worker_dedup_keys", "insert").map(
      (p) => (p as { key: string }).key,
    );
    expect(keys[0]).toMatch(/^email-auto-reply:sender:[0-9a-f]{64}:\d+$/);
  });
});
