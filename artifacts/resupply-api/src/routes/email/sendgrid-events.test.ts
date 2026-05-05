// Smoke tests for POST /email/sendgrid-events.
//
// Purpose: lock in the contract the architect previously flagged as
// untested — namely, that:
//   * Requests without a valid ECDSA signature are rejected (401)
//     with NO database side effects.
//   * Requests with a valid ECDSA signature are accepted (200) and
//     the SendGrid event maps to our internal delivery_status
//     taxonomy on the matching `messages` row.
//   * The full set of mappings we ship — processed → sent,
//     delivered → delivered, bounce → bounced, dropped → dropped,
//     deferred → deferred — fires the expected UPDATE.
//
// The route uses `db.execute(sql\`...\`)` for the messages update
// (raw SQL, not the query builder), so the drizzle stub here only
// needs to expose a single `execute` method — we capture invocations
// to assert mapping behaviour without a real Postgres.
//
// Signing strategy mirrors the lib's own signature.test.ts: we mint
// a fresh ECDSA P-256 keypair per test, install the public key into
// SENDGRID_EVENT_WEBHOOK_PUBLIC_KEY, and sign the raw body bytes the
// way SendGrid does (HMAC-style: timestamp + body, ECDSA-SHA256).

import { generateKeyPairSync, createSign } from "node:crypto";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import express, { type Express } from "express";
import request from "supertest";

// ---------------------------------------------------------------------------
// Drizzle stub — only `.execute(sql\`...\`)` is used by this route.
// ---------------------------------------------------------------------------
const executeMock = vi.fn().mockResolvedValue(undefined);
const dbStub = {
  execute: executeMock,
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
  };
});

// safeAudit hits @workspace/resupply-audit which expects a real DB.
// Stub it out — the audit-row contents are validated in their own
// test file; here we only care that the email-events route does not
// throw when bounce/dropped events arrive.
const safeAuditMock = vi.fn().mockResolvedValue(undefined);
vi.mock("../../lib/messaging/safe-audit", () => ({
  safeAudit: (...a: unknown[]) => safeAuditMock(...a),
}));

import sendgridEventsRouter from "./sendgrid-events";
import {
  SENDGRID_SIGNATURE_HEADER,
  SENDGRID_TIMESTAMP_HEADER,
} from "@workspace/resupply-email";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function freshKeyPair(): {
  publicKeyBase64: string;
  privateKeyPem: string;
} {
  const { publicKey, privateKey } = generateKeyPairSync("ec", {
    namedCurve: "prime256v1",
  });
  const publicKeyDer = publicKey.export({ format: "der", type: "spki" });
  return {
    publicKeyBase64: publicKeyDer.toString("base64"),
    privateKeyPem: privateKey
      .export({ format: "pem", type: "pkcs8" })
      .toString(),
  };
}

function signBody(privateKeyPem: string, timestamp: string, body: string) {
  const signer = createSign("sha256");
  signer.update(timestamp + body);
  signer.end();
  return signer.sign(privateKeyPem).toString("base64");
}

function buildApp(): Express {
  const app = express();
  app.use(sendgridEventsRouter);
  return app;
}

const ENV_KEYS = [
  "SENDGRID_API_KEY",
  "SENDGRID_FROM_EMAIL",
  "SENDGRID_FROM_NAME",
  "SENDGRID_EVENT_WEBHOOK_PUBLIC_KEY",
  "RESUPPLY_VOICE_PUBLIC_BASE_URL",
] as const;
type EnvKey = (typeof ENV_KEYS)[number];
const originalEnv: Partial<Record<EnvKey, string | undefined>> = {};

function setBaseEnv(publicKeyBase64: string) {
  process.env.SENDGRID_API_KEY = "SG.test";
  process.env.SENDGRID_FROM_EMAIL = "no-reply@penn.example";
  process.env.SENDGRID_FROM_NAME = "Penn";
  process.env.SENDGRID_EVENT_WEBHOOK_PUBLIC_KEY = publicKeyBase64;
  process.env.RESUPPLY_VOICE_PUBLIC_BASE_URL = "https://api.example.com";
}

// ---------------------------------------------------------------------------

describe("POST /email/sendgrid-events", () => {
  beforeEach(() => {
    for (const k of ENV_KEYS) originalEnv[k] = process.env[k];
    for (const k of ENV_KEYS) delete process.env[k];
    executeMock.mockClear();
    safeAuditMock.mockClear();
  });
  afterEach(() => {
    for (const k of ENV_KEYS) {
      if (originalEnv[k] === undefined) delete process.env[k];
      else process.env[k] = originalEnv[k];
    }
  });

  it("rejects requests with no signature header (401) and issues NO DB updates", async () => {
    const { publicKeyBase64 } = freshKeyPair();
    setBaseEnv(publicKeyBase64);

    const app = buildApp();
    const body = JSON.stringify([
      { event: "delivered", sg_message_id: "sg.evt.1" },
    ]);

    const res = await request(app)
      .post("/email/sendgrid-events")
      .set("content-type", "application/json")
      .send(body);

    expect(res.status).toBe(401);
    expect(executeMock).not.toHaveBeenCalled();
    expect(safeAuditMock).not.toHaveBeenCalled();
  });

  it("accepts a validly-signed batch and UPDATEs the matching messages row (delivered)", async () => {
    const { publicKeyBase64, privateKeyPem } = freshKeyPair();
    setBaseEnv(publicKeyBase64);

    const ts = "1810000000";
    const body = JSON.stringify([
      {
        event: "delivered",
        sg_message_id: "sg.msg.delivered.1",
        conversation_id: "conv-aaa",
      },
    ]);
    const sig = signBody(privateKeyPem, ts, body);

    const app = buildApp();
    const res = await request(app)
      .post("/email/sendgrid-events")
      .set("content-type", "application/json")
      .set(SENDGRID_SIGNATURE_HEADER, sig)
      .set(SENDGRID_TIMESTAMP_HEADER, ts)
      .send(body);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
    expect(executeMock).toHaveBeenCalledTimes(1);
    // The first arg is a drizzle SQL chunk — its .queryChunks include
    // the bound parameters. Stringify and assert on the substring.
    const sqlArg = executeMock.mock.calls[0]![0];
    const stringified = JSON.stringify(sqlArg);
    expect(stringified).toContain("delivered");
    expect(stringified).toContain("sg.msg.delivered.1");
  });

  it.each([
    { event: "processed", expectedStatus: "sent" },
    { event: "delivered", expectedStatus: "delivered" },
    { event: "bounce", expectedStatus: "bounced" },
    { event: "dropped", expectedStatus: "dropped" },
    { event: "deferred", expectedStatus: "deferred" },
  ])(
    "maps SendGrid '$event' to delivery_status '$expectedStatus'",
    async ({ event, expectedStatus }) => {
      const { publicKeyBase64, privateKeyPem } = freshKeyPair();
      setBaseEnv(publicKeyBase64);

      const ts = "1810000001";
      const body = JSON.stringify([
        {
          event,
          // bounce events also carry a `type` we whitelist; safe to
          // include unconditionally — passthrough on other event kinds.
          type: "bounce",
          sg_message_id: `sg.msg.${event}.1`,
          conversation_id: "conv-bbb",
        },
      ]);
      const sig = signBody(privateKeyPem, ts, body);

      const app = buildApp();
      const res = await request(app)
        .post("/email/sendgrid-events")
        .set("content-type", "application/json")
        .set(SENDGRID_SIGNATURE_HEADER, sig)
        .set(SENDGRID_TIMESTAMP_HEADER, ts)
        .send(body);

      expect(res.status).toBe(200);
      expect(executeMock).toHaveBeenCalledTimes(1);
      const stringified = JSON.stringify(executeMock.mock.calls[0]![0]);
      expect(stringified).toContain(expectedStatus);
      expect(stringified).toContain(`sg.msg.${event}.1`);

      // bounce + dropped also write an audit row.
      if (event === "bounce" || event === "dropped") {
        expect(safeAuditMock).toHaveBeenCalledTimes(1);
        const auditArg = safeAuditMock.mock.calls[0]![0] as {
          metadata: { event: string; bounce_classification: string };
        };
        expect(auditArg.metadata.event).toBe(event);
        // We seeded type:"bounce" which is in the whitelist.
        expect(auditArg.metadata.bounce_classification).toBe("bounce");
      } else {
        expect(safeAuditMock).not.toHaveBeenCalled();
      }
    },
  );

  it("rejects a tampered body with the original valid signature (401)", async () => {
    const { publicKeyBase64, privateKeyPem } = freshKeyPair();
    setBaseEnv(publicKeyBase64);

    const ts = "1810000002";
    const originalBody = JSON.stringify([
      { event: "delivered", sg_message_id: "sg.msg.tamper.1" },
    ]);
    const sig = signBody(privateKeyPem, ts, originalBody);
    const tamperedBody = originalBody.replace("delivered", "bounce");

    const app = buildApp();
    const res = await request(app)
      .post("/email/sendgrid-events")
      .set("content-type", "application/json")
      .set(SENDGRID_SIGNATURE_HEADER, sig)
      .set(SENDGRID_TIMESTAMP_HEADER, ts)
      .send(tamperedBody);

    expect(res.status).toBe(401);
    expect(executeMock).not.toHaveBeenCalled();
  });

  it("returns 400 for a validly-signed request with non-JSON Content-Type (text/plain)", async () => {
    // When Content-Type is not application/json, express.raw() does not
    // populate req.body as a Buffer, so the signature middleware has no
    // raw bytes to verify against and rejects the request with 400.
    // This ensures that a non-JSON SendGrid request is never silently
    // accepted (which would suppress retries and lose the event batch).
    const { publicKeyBase64, privateKeyPem } = freshKeyPair();
    setBaseEnv(publicKeyBase64);

    const ts = "1810000003";
    const body = JSON.stringify([
      { event: "delivered", sg_message_id: "sg.msg.plain.1" },
    ]);
    const sig = signBody(privateKeyPem, ts, body);

    const app = buildApp();
    const res = await request(app)
      .post("/email/sendgrid-events")
      .set("content-type", "text/plain")
      .set(SENDGRID_SIGNATURE_HEADER, sig)
      .set(SENDGRID_TIMESTAMP_HEADER, ts)
      .send(body);

    expect(res.status).toBe(400);
    expect(executeMock).not.toHaveBeenCalled();
  });

  it("returns 400 (not 200) for a validly-signed request with invalid JSON body", async () => {
    // B-12: parse failures must return 400 so SendGrid retries the
    // event batch instead of treating a 200 as successful delivery.
    const { publicKeyBase64, privateKeyPem } = freshKeyPair();
    setBaseEnv(publicKeyBase64);

    const ts = "1810000004";
    // Content-Type is application/json so express.raw() captures the
    // body as a Buffer; the signature is valid over these exact bytes.
    const invalidJsonBody = "{ this is not valid JSON !!!";
    const sig = signBody(privateKeyPem, ts, invalidJsonBody);

    const app = buildApp();
    const res = await request(app)
      .post("/email/sendgrid-events")
      .set("content-type", "application/json")
      .set(SENDGRID_SIGNATURE_HEADER, sig)
      .set(SENDGRID_TIMESTAMP_HEADER, ts)
      .send(invalidJsonBody);

    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ error: "parse_failed" });
    // No DB updates must occur when the body is unparseable.
    expect(executeMock).not.toHaveBeenCalled();
  });
});
