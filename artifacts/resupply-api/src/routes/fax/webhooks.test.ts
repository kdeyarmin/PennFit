// Integration test for the Telnyx fax webhook router (webhooks.ts).
//
// This is the security-critical plumbing: express.raw() must hand the
// requireTelnyxSignature middleware the EXACT bytes Telnyx signed, the
// middleware must verify the Ed25519 signature over `${timestamp}|${raw}`,
// and only then hand the parsed JSON to the handler. We mount the real
// router behind express.raw (as app.ts does) with a generated keypair and
// assert a genuinely-signed event is processed while an unsigned/forged
// one is rejected with 403 before the handler runs.

import { describe, it, expect, vi, beforeEach } from "vitest";
import express, { type Express } from "express";
import request from "supertest";
import {
  generateKeyPairSync,
  sign as cryptoSign,
  type KeyObject,
} from "node:crypto";

import {
  installSupabaseMock,
  stageSupabaseResponse,
} from "../../test-helpers/supabase-mock";

const supabaseMock = installSupabaseMock();

const logAuditMock = vi.hoisted(() =>
  vi.fn<(input: unknown) => Promise<undefined>>(async () => undefined),
);
vi.mock("@workspace/resupply-audit", () => ({ logAudit: logAuditMock }));

vi.mock("../../lib/logger", () => ({
  logger: { warn: vi.fn(), info: vi.fn() },
}));

type IngestOutcome = {
  kind: "inserted";
  id: string;
  mediaPersisted: boolean;
};
const ingestInboundFaxMock = vi.hoisted(() =>
  vi.fn<(input: Record<string, unknown>) => Promise<IngestOutcome>>(
    async () => ({
      kind: "inserted",
      id: "row-1",
      mediaPersisted: false,
    }),
  ),
);
vi.mock("../../lib/fax/ingest-inbound.js", () => ({
  ingestInboundFax: ingestInboundFaxMock,
}));

import faxWebhooksRouter from "./webhooks";

const { publicKey, privateKey } = generateKeyPairSync("ed25519");

function publicKeyBase64(pub: KeyObject): string {
  const der = pub.export({ type: "spki", format: "der" });
  return Buffer.from(der.subarray(der.length - 32)).toString("base64");
}

function sign(timestamp: string, rawBody: string): string {
  return cryptoSign(
    null,
    Buffer.from(`${timestamp}|${rawBody}`, "utf8"),
    privateKey,
  ).toString("base64");
}

// Mirror app.ts: express.raw BEFORE the router so the signature is
// verified over the unparsed body bytes.
function makeApp(): Express {
  const app = express();
  app.use(
    "/resupply-api/fax",
    express.raw({ type: "application/json", limit: "256kb" }),
    faxWebhooksRouter,
  );
  return app;
}

async function flush() {
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));
}

beforeEach(() => {
  supabaseMock.reset();
  logAuditMock.mockClear();
  ingestInboundFaxMock.mockClear();
  process.env.TELNYX_PUBLIC_KEY = publicKeyBase64(publicKey);
});

describe("Telnyx fax webhooks — signature plumbing", () => {
  it("accepts a genuinely-signed fax.received and ingests it", async () => {
    const raw = JSON.stringify({
      data: {
        event_type: "fax.received",
        payload: { fax_id: "fx-1", from: "+15551112222", page_count: 1 },
      },
    });
    const ts = String(Math.floor(Date.now() / 1000));
    const res = await request(makeApp())
      .post("/resupply-api/fax/inbound")
      .set("Content-Type", "application/json")
      .set("telnyx-signature-ed25519", sign(ts, raw))
      .set("telnyx-timestamp", ts)
      .send(raw);
    expect(res.status).toBe(200);
    await flush();
    expect(ingestInboundFaxMock).toHaveBeenCalledOnce();
    const arg = ingestInboundFaxMock.mock.calls[0]?.[0] as Record<
      string,
      unknown
    >;
    expect(arg.telnyxFaxId).toBe("fx-1");
  });

  it("rejects an unsigned request with 403 and never ingests", async () => {
    const raw = JSON.stringify({
      data: { event_type: "fax.received", payload: { fax_id: "fx-2" } },
    });
    const res = await request(makeApp())
      .post("/resupply-api/fax/inbound")
      .set("Content-Type", "application/json")
      .send(raw);
    expect(res.status).toBe(403);
    await flush();
    expect(ingestInboundFaxMock).not.toHaveBeenCalled();
  });

  it("rejects a forged body (signature over different bytes) with 403", async () => {
    const ts = String(Math.floor(Date.now() / 1000));
    const signedFor = JSON.stringify({
      data: { event_type: "fax.received", payload: { fax_id: "fx-real" } },
    });
    const tampered = JSON.stringify({
      data: { event_type: "fax.received", payload: { fax_id: "fx-FORGED" } },
    });
    const res = await request(makeApp())
      .post("/resupply-api/fax/inbound")
      .set("Content-Type", "application/json")
      .set("telnyx-signature-ed25519", sign(ts, signedFor))
      .set("telnyx-timestamp", ts)
      .send(tampered);
    expect(res.status).toBe(403);
    await flush();
    expect(ingestInboundFaxMock).not.toHaveBeenCalled();
  });

  it("verifies + processes a signed outbound fax.delivered status event", async () => {
    stageSupabaseResponse("physician_fax_outreach", "update", { error: null });
    const raw = JSON.stringify({
      data: {
        event_type: "fax.delivered",
        payload: { fax_id: "fx-3", direction: "outbound" },
      },
    });
    const ts = String(Math.floor(Date.now() / 1000));
    const res = await request(makeApp())
      .post("/resupply-api/fax/status-callback")
      .set("Content-Type", "application/json")
      .set("telnyx-signature-ed25519", sign(ts, raw))
      .set("telnyx-timestamp", ts)
      .send(raw);
    expect(res.status).toBe(200);
    await flush();
    expect(logAuditMock).toHaveBeenCalledOnce();
  });
});
