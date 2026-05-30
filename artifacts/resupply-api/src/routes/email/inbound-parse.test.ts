// Tests for POST /email/inbound-parse.
//
// Coverage focus:
//   * Auth gating — wrong/missing basic auth → 401, missing env → 503.
//   * Multipart parsing helpers (extractEmailAddress, checkBasicAuth,
//     extractMessageIdHeader) — pure functions, deterministic.
//   * Unknown-sender handling — audited as `unknown_email`, no DB
//     writes, 200 OK so SendGrid doesn't retry.
//   * Happy path with one PNG attachment — message row inserted,
//     attachment row inserted via persistInboundAttachment, conversation
//     flipped to awaiting_admin, audit emitted.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import express, { type Express } from "express";
import request from "supertest";

import {
  installSupabaseMock,
  stageSupabaseResponse,
  getSupabaseCallCount,
  getSupabaseWritePayloads,
} from "../../test-helpers/supabase-mock";

const supabaseMock = installSupabaseMock();

// Mock the email config gate to "configured".
vi.mock("../../lib/messaging/messaging-config", () => ({
  readEmailConfigOrNull: () => ({
    sendgridApiKey: "SG.test",
    fromEmail: "noreply@test.example",
  }),
}));

// safeAudit hits the audit lib which expects a real DB.
const safeAuditMock = vi.fn(async (_event: unknown) => undefined);
vi.mock("../../lib/messaging/safe-audit", () => ({
  safeAudit: (event: unknown) => safeAuditMock(event),
}));

// persistInboundAttachment is exercised in its own unit tests; here
// we only care that the route hands it the right inputs.
const persistMock = vi.fn(
  async (_input: Record<string, unknown>, _logger: unknown) =>
    "succeeded" as const,
);
vi.mock("../../lib/messaging/ingest-mms", async () => {
  const actual = await vi.importActual<
    typeof import("../../lib/messaging/ingest-mms")
  >("../../lib/messaging/ingest-mms");
  return {
    ...actual,
    persistInboundAttachment: (
      input: Record<string, unknown>,
      logger: unknown,
    ) => persistMock(input, logger),
  };
});

import inboundParseRouter, {
  checkBasicAuth,
  extractEmailAddress,
  extractMessageIdHeader,
} from "./inbound-parse";

const BASIC_AUTH_VALUE = "sg_user:correct-horse";

function buildApp(): Express {
  const app = express();
  app.use((req, _res, next) => {
    // Pino-shaped no-op logger; the route uses req.log.
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

beforeEach(() => {
  supabaseMock.reset();
  safeAuditMock.mockClear();
  persistMock.mockClear();
  process.env.SENDGRID_INBOUND_PARSE_BASIC_AUTH = BASIC_AUTH_VALUE;
});

afterEach(() => {
  delete process.env.SENDGRID_INBOUND_PARSE_BASIC_AUTH;
});

// ---------------------------------------------------------------------------
// Pure helper tests.
// ---------------------------------------------------------------------------

describe("extractEmailAddress", () => {
  it("parses 'Name <addr>' form", () => {
    expect(extractEmailAddress("John Doe <john@example.com>")).toBe(
      "john@example.com",
    );
  });
  it("parses bare addresses, lower-casing", () => {
    expect(extractEmailAddress("Jane@Example.COM")).toBe("jane@example.com");
  });
  it("returns null for malformed input", () => {
    expect(extractEmailAddress("not an email")).toBeNull();
    expect(extractEmailAddress("")).toBeNull();
    expect(extractEmailAddress(undefined)).toBeNull();
  });
});

describe("checkBasicAuth", () => {
  it("accepts a matching base64 user:pass", () => {
    const enc = Buffer.from("u:p").toString("base64");
    expect(checkBasicAuth(`Basic ${enc}`, "u:p")).toBe(true);
  });
  it("rejects mismatched credentials", () => {
    const enc = Buffer.from("u:WRONG").toString("base64");
    expect(checkBasicAuth(`Basic ${enc}`, "u:p")).toBe(false);
  });
  it("rejects non-Basic schemes and missing headers", () => {
    expect(checkBasicAuth(null, "u:p")).toBe(false);
    expect(checkBasicAuth("Bearer abc", "u:p")).toBe(false);
  });
});

describe("extractMessageIdHeader", () => {
  it("pulls the bracketed Message-ID value", () => {
    expect(
      extractMessageIdHeader(
        "Received: from foo\r\nMessage-ID: <abc123@mail.example>\r\nFrom: x",
      ),
    ).toBe("abc123@mail.example");
  });
  it("returns null when absent", () => {
    expect(extractMessageIdHeader("")).toBeNull();
    expect(extractMessageIdHeader("From: x")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Route tests.
// ---------------------------------------------------------------------------

describe("POST /email/inbound-parse", () => {
  it("returns 503 when the basic-auth env var is missing", async () => {
    delete process.env.SENDGRID_INBOUND_PARSE_BASIC_AUTH;
    const res = await request(buildApp())
      .post("/email/inbound-parse")
      .field("from", "patient@example.com")
      .field("text", "hi");
    expect(res.status).toBe(503);
    expect(res.body).toEqual({ error: "inbound_parse_not_configured" });
    expect(getSupabaseCallCount("messages", "insert")).toBe(0);
  });

  it("returns 401 when basic auth is wrong", async () => {
    const res = await request(buildApp())
      .post("/email/inbound-parse")
      .auth("sg_user", "WRONG")
      .field("from", "patient@example.com")
      .field("text", "hi");
    expect(res.status).toBe(401);
    expect(getSupabaseCallCount("messages", "insert")).toBe(0);
  });

  it("audits unknown_email and returns 200 when no patient matches", async () => {
    // Patient lookup returns []. The route reads `lookupRows ?? []`
    // and computes `lookupRows[0]?.id` so an empty array is the
    // "unknown sender" branch.
    stageSupabaseResponse("patients", "select", { data: [] });

    const res = await request(buildApp())
      .post("/email/inbound-parse")
      .auth("sg_user", "correct-horse")
      .field("from", "Unknown <stranger@example.com>")
      .field("text", "hi");
    expect(res.status).toBe(200);
    expect(getSupabaseCallCount("messages", "insert")).toBe(0);
    expect(safeAuditMock).toHaveBeenCalledTimes(1);
    const auditMeta = (
      safeAuditMock.mock.calls[0]![0] as {
        metadata: Record<string, unknown>;
      }
    ).metadata;
    expect(auditMeta.channel).toBe("email");
    expect(auditMeta.outcome).toBe("unknown_email");
  });

  it("ingests a PNG attachment on the happy path", async () => {
    // Scripted query responses, in order:
    //   1) patient lookup — one match
    //   2) open conversation lookup — one match
    //   3) message insert — returns the new id
    //   4) conversation last_message_at update — touches conversations
    //   5) status flip → awaiting_admin — touches conversations
    stageSupabaseResponse("patients", "select", {
      data: [{ id: "patient-1" }],
    });
    stageSupabaseResponse("conversations", "select", {
      data: { id: "conv-1" },
    });
    stageSupabaseResponse("messages", "insert", { data: { id: "msg-1" } });
    stageSupabaseResponse("conversations", "update", { error: null });
    stageSupabaseResponse("conversations", "update", { error: null });

    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

    const res = await request(buildApp())
      .post("/email/inbound-parse")
      .auth("sg_user", "correct-horse")
      .field("from", "Patient <patient@example.com>")
      .field("subject", "Re: Your refill")
      .field("text", "Here is my insurance card")
      .field("headers", "Message-ID: <unique-id-1@mail.example>")
      .attach("attachment1", png, {
        filename: "card.png",
        contentType: "image/png",
      });

    expect(res.status).toBe(200);

    // Message row inserted with email-shaped fields. The route uses
    // snake_case columns; the mock captures the payload verbatim.
    const msgInserts = getSupabaseWritePayloads("messages", "insert");
    expect(msgInserts).toHaveLength(1);
    const msgVals = msgInserts[0] as Record<string, unknown>;
    expect(msgVals.direction).toBe("inbound");
    expect(msgVals.sender_role).toBe("patient");
    expect(msgVals.body).toBe("Here is my insurance card");
    const meta = msgVals.vendor_metadata as Record<string, unknown>;
    expect(meta.sendgrid_inbound).toBe(true);
    expect(meta.subject).toBe("Re: Your refill");
    expect(meta.sendgrid_message_id).toBe("unique-id-1@mail.example");

    // persistInboundAttachment was called with the attachment bytes.
    expect(persistMock).toHaveBeenCalledTimes(1);
    const persistArg = persistMock.mock.calls[0]![0] as Record<string, unknown>;
    expect(persistArg.messageId).toBe("msg-1");
    expect(persistArg.contentType).toBe("image/png");
    expect(persistArg.filename).toBe("card.png");
    expect(persistArg.source).toBe("email");
    expect(persistArg.twilioMediaSid).toBeNull();
    expect((persistArg.bytes as Uint8Array).byteLength).toBe(png.byteLength);

    // Conversation flipped to awaiting_admin.
    const updates = getSupabaseWritePayloads(
      "conversations",
      "update",
    ) as Record<string, unknown>[];
    expect(updates.some((u) => u.status === "awaiting_admin")).toBe(true);

    // Inbound + media-ingested audits both fired.
    const actions = safeAuditMock.mock.calls.map(
      (c) => (c[0] as { action: string }).action,
    );
    expect(actions).toContain("messaging.inbound.received");
    expect(actions).toContain("messaging.inbound.media_ingested");
  });

  it("opens a fresh conversation when the patient has no open email thread", async () => {
    stageSupabaseResponse("patients", "select", {
      data: [{ id: "patient-2" }],
    });
    // No open conversation.
    stageSupabaseResponse("conversations", "select", { data: null });
    // Most recent episode → present.
    stageSupabaseResponse("episodes", "select", { data: { id: "ep-99" } });
    // INSERT new conversation row.
    stageSupabaseResponse("conversations", "insert", {
      data: { id: "conv-new" },
    });
    // INSERT inbound message.
    stageSupabaseResponse("messages", "insert", { data: { id: "msg-2" } });
    // Two trailing UPDATEs on conversations (last_message_at + status).
    stageSupabaseResponse("conversations", "update", { error: null });
    stageSupabaseResponse("conversations", "update", { error: null });

    const res = await request(buildApp())
      .post("/email/inbound-parse")
      .auth("sg_user", "correct-horse")
      .field("from", "patient2@example.com")
      .field("text", "Hello");
    expect(res.status).toBe(200);
    const convInserts = getSupabaseWritePayloads("conversations", "insert");
    expect(convInserts).toHaveLength(1);
    const convVals = convInserts[0] as Record<string, unknown>;
    expect(convVals.patient_id).toBe("patient-2");
    expect(convVals.episode_id).toBe("ep-99");
    expect(convVals.channel).toBe("email");
    expect(convVals.status).toBe("open");
  });
});
