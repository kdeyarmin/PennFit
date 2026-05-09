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
//
// We mock the drizzle chain comprehensively because this route walks
// several distinct queries (patient lookup, conversation lookup,
// message insert, conversation update). Mocks are keyed by the table
// reference so the test can simulate "patient found vs. not found"
// without re-implementing SQL.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import express, { type Express } from "express";
import request from "supertest";

import {
  conversations,
  episodes,
  messages,
  patients,
} from "@workspace/resupply-db";

// ---------------------------------------------------------------------------
// Drizzle stub. The route uses select/insert/update fluent chains.
// We dispatch on the first table the chain references so each test
// can tailor its responses (patient match, conversation match, etc).
// ---------------------------------------------------------------------------
type Row = Record<string, unknown>;
const selectScripts: Array<{ table: unknown; rows: Row[] }> = [];
const insertCalls: Array<{ table: unknown; values: Row }> = [];
const updateCalls: Array<{ table: unknown; set: Row }> = [];
const insertReturning: Map<unknown, Row> = new Map();

function makeSelect(table: unknown) {
  // Chain: .from(t).where(...).orderBy(...).limit(n) → Promise<Row[]>
  // Find the next scripted response targeting this table.
  const idx = selectScripts.findIndex((s) => s.table === table);
  const rows = idx >= 0 ? selectScripts.splice(idx, 1)[0]!.rows : [];
  const chain: Record<string, (...a: unknown[]) => unknown> = {};
  const thenable: PromiseLike<Row[]> = {
    then: (resolve, reject) =>
      Promise.resolve(rows).then(resolve as never, reject as never),
  };
  chain.from = () => chain;
  chain.where = () => chain;
  chain.orderBy = () => chain;
  chain.limit = () => thenable;
  return chain;
}

function makeInsert(table: unknown) {
  return {
    values: (vals: Row) => {
      insertCalls.push({ table, values: vals });
      const returnedRow = insertReturning.get(table) ?? { id: "test-id" };
      const result: PromiseLike<Row[]> = {
        then: (resolve, reject) =>
          Promise.resolve([returnedRow]).then(
            resolve as never,
            reject as never,
          ),
      };
      return {
        returning: () => result,
        // Also support bare-await (no .returning()), used by the
        // attachment insert.
        then: (resolve: (v: unknown) => unknown, reject?: unknown) =>
          Promise.resolve(undefined).then(resolve as never, reject as never),
      };
    },
  };
}

function makeUpdate(table: unknown) {
  return {
    set: (vals: Row) => {
      updateCalls.push({ table, set: vals });
      return {
        where: () => Promise.resolve(undefined),
      };
    },
  };
}

const dbStub = {
  select: () => ({
    from: (table: unknown) => makeSelect(table),
  }),
  insert: (table: unknown) => makeInsert(table),
  update: (table: unknown) => makeUpdate(table),
};

vi.mock("drizzle-orm/node-postgres", () => ({
  drizzle: () => dbStub,
}));

vi.mock("@workspace/resupply-db", async () => {
  const actual = await vi.importActual<typeof import("@workspace/resupply-db")>(
    "@workspace/resupply-db",
  );
  return {
    ...actual,
    getDbPool: () => ({}) as never,
    tryUpsertPatientLatestMessageSb: vi.fn(async () => true),
  };
});

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
  selectScripts.length = 0;
  insertCalls.length = 0;
  updateCalls.length = 0;
  insertReturning.clear();
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
    expect(insertCalls).toHaveLength(0);
  });

  it("returns 401 when basic auth is wrong", async () => {
    const res = await request(buildApp())
      .post("/email/inbound-parse")
      .auth("sg_user", "WRONG")
      .field("from", "patient@example.com")
      .field("text", "hi");
    expect(res.status).toBe(401);
    expect(insertCalls).toHaveLength(0);
  });

  it("audits unknown_email and returns 200 when no patient matches", async () => {
    // Patient lookup → empty.
    selectScripts.push({ table: patients, rows: [] });

    const res = await request(buildApp())
      .post("/email/inbound-parse")
      .auth("sg_user", "correct-horse")
      .field("from", "Unknown <stranger@example.com>")
      .field("text", "hi");
    expect(res.status).toBe(200);
    expect(insertCalls).toHaveLength(0);
    expect(safeAuditMock).toHaveBeenCalledTimes(1);
    const auditMeta = (safeAuditMock.mock.calls[0]![0] as { metadata: Row })
      .metadata;
    expect(auditMeta.channel).toBe("email");
    expect(auditMeta.outcome).toBe("unknown_email");
  });

  it("ingests a PNG attachment on the happy path", async () => {
    // Scripted query responses, in order:
    //   1) patient lookup → one match
    //   2) open conversation lookup → one match
    selectScripts.push({
      table: patients,
      rows: [{ patientId: "patient-1" }],
    });
    selectScripts.push({
      table: conversations,
      rows: [{ id: "conv-1" }],
    });
    insertReturning.set(messages, { id: "msg-1" });

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

    // Message row inserted into messages table with email-shaped fields.
    const msgInsert = insertCalls.find((c) => c.table === messages);
    expect(msgInsert).toBeDefined();
    expect(msgInsert!.values.direction).toBe("inbound");
    expect(msgInsert!.values.senderRole).toBe("patient");
    expect(msgInsert!.values.body).toBe("Here is my insurance card");
    const meta = msgInsert!.values.vendorMetadata as Row;
    expect(meta.sendgrid_inbound).toBe(true);
    expect(meta.subject).toBe("Re: Your refill");
    expect(meta.sendgrid_message_id).toBe("unique-id-1@mail.example");

    // persistInboundAttachment was called with the attachment bytes.
    expect(persistMock).toHaveBeenCalledTimes(1);
    const persistArg = persistMock.mock.calls[0]![0] as Row;
    expect(persistArg.messageId).toBe("msg-1");
    expect(persistArg.contentType).toBe("image/png");
    expect(persistArg.filename).toBe("card.png");
    expect(persistArg.source).toBe("email");
    expect(persistArg.twilioMediaSid).toBeNull();
    expect((persistArg.bytes as Uint8Array).byteLength).toBe(png.byteLength);

    // Conversation flipped to awaiting_admin.
    const statusUpdate = updateCalls.find(
      (u) => u.table === conversations && u.set.status === "awaiting_admin",
    );
    expect(statusUpdate).toBeDefined();

    // Inbound + media-ingested audits both fired.
    const actions = safeAuditMock.mock.calls.map(
      (c) => (c[0] as { action: string }).action,
    );
    expect(actions).toContain("messaging.inbound.received");
    expect(actions).toContain("messaging.inbound.media_ingested");
  });

  it("opens a fresh conversation when the patient has no open email thread", async () => {
    selectScripts.push({
      table: patients,
      rows: [{ patientId: "patient-2" }],
    });
    // No open conversation.
    selectScripts.push({ table: conversations, rows: [] });
    // Most recent episode → present.
    selectScripts.push({ table: episodes, rows: [{ id: "ep-99" }] });
    insertReturning.set(conversations, { id: "conv-new" });
    insertReturning.set(messages, { id: "msg-2" });

    const res = await request(buildApp())
      .post("/email/inbound-parse")
      .auth("sg_user", "correct-horse")
      .field("from", "patient2@example.com")
      .field("text", "Hello");
    expect(res.status).toBe(200);
    const convInsert = insertCalls.find((c) => c.table === conversations);
    expect(convInsert).toBeDefined();
    expect(convInsert!.values.patientId).toBe("patient-2");
    expect(convInsert!.values.episodeId).toBe("ep-99");
    expect(convInsert!.values.channel).toBe("email");
    expect(convInsert!.values.status).toBe("open");
  });
});
