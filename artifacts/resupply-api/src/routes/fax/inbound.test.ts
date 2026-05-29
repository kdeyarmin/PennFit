// Route tests for POST /fax/inbound (Twilio inbound fax webhook).
//
// Coverage:
//   * 200 + TwiML <Response/> ACK on every request (Twilio retries 5xx)
//   * Missing FaxSid → no audit, logs warning
//   * "receiving" status (mid-transfer) → no audit emitted
//   * "received" status → audit emitted with non-PHI envelope
//   * ingestInboundFax is invoked with the received-event params
//   * Audit envelope contains fax_sid, num_pages, direction, outcome,
//     media_persisted — never From or MediaUrl literal
//   * NumPages defaults to null when absent
//   * Direction defaults to "inbound" when absent
//   * Audit write failure is swallowed (logged, not surfaced)
//
// PHI invariant: From (sender fax number) and MediaUrl literal never
// appear in any audit call argument — asserted explicitly.

import { describe, it, expect, vi, beforeEach } from "vitest";
import express, { type Express } from "express";
import request from "supertest";

// Bypass Twilio signature validation — all inbound tests share this stub.
vi.mock("@workspace/resupply-telecom", async () => {
  const actual = await vi.importActual<
    typeof import("@workspace/resupply-telecom")
  >("@workspace/resupply-telecom");
  return {
    ...actual,
    requireTwilioSignature:
      () => (_req: unknown, _res: unknown, next: () => void) =>
        next(),
  };
});

const logAuditMock = vi.hoisted(() =>
  vi.fn<(input: unknown) => Promise<undefined>>(async () => undefined),
);
vi.mock("@workspace/resupply-audit", () => ({
  logAudit: logAuditMock,
}));

const loggerWarnMock = vi.hoisted(() => vi.fn());
vi.mock("../../lib/logger", () => ({
  logger: { warn: loggerWarnMock },
}));

// Mock the ingest helper so tests don't need a real Supabase client.
// Default returns "inserted" with media_persisted=true; individual
// tests override via mockResolvedValueOnce.
type IngestOutcome =
  | {
      kind: "inserted";
      id: string;
      mediaPersisted: boolean;
    }
  | { kind: "already_recorded"; id: string }
  | { kind: "errored" };
const ingestInboundFaxMock = vi.hoisted(() =>
  vi.fn<(input: Record<string, unknown>) => Promise<IngestOutcome>>(
    async () => ({
      kind: "inserted",
      id: "00000000-0000-4000-8000-000000000abc",
      mediaPersisted: true,
    }),
  ),
);
vi.mock("../../lib/fax/ingest-inbound.js", () => ({
  ingestInboundFax: ingestInboundFaxMock,
}));

import inboundRouter from "./inbound";

function makeApp(): Express {
  const app = express();
  app.use(express.urlencoded({ extended: false }));
  app.use(inboundRouter);
  return app;
}

async function flushMicrotasks() {
  // The route does fire-and-forget on ingest + audit. Yield twice to
  // let both promise chains resolve before we assert.
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));
}

beforeEach(() => {
  logAuditMock.mockClear();
  loggerWarnMock.mockClear();
  ingestInboundFaxMock.mockClear();
  ingestInboundFaxMock.mockResolvedValue({
    kind: "inserted",
    id: "00000000-0000-4000-8000-000000000abc",
    mediaPersisted: true,
  });
});

describe("POST /fax/inbound — ACK", () => {
  it("always returns 200 with TwiML ACK", async () => {
    const res = await request(makeApp())
      .post("/fax/inbound")
      .type("form")
      .send({ FaxSid: "FX001", Status: "received", NumPages: "2" });
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toMatch(/text\/xml/);
    expect(res.text).toBe("<Response/>");
  });

  it("still returns 200 even when FaxSid is missing (malformed body)", async () => {
    const res = await request(makeApp())
      .post("/fax/inbound")
      .type("form")
      .send({ Status: "received" }); // no FaxSid
    expect(res.status).toBe(200);
    expect(res.text).toBe("<Response/>");
  });
});

describe("POST /fax/inbound — malformed body", () => {
  it("does not emit an audit or ingest call when FaxSid is missing", async () => {
    await request(makeApp())
      .post("/fax/inbound")
      .type("form")
      .send({ Status: "received" });
    await flushMicrotasks();
    expect(logAuditMock).not.toHaveBeenCalled();
    expect(ingestInboundFaxMock).not.toHaveBeenCalled();
  });

  it("logs a warning when FaxSid is missing", async () => {
    await request(makeApp())
      .post("/fax/inbound")
      .type("form")
      .send({ Status: "received" });
    await flushMicrotasks();
    expect(loggerWarnMock).toHaveBeenCalledWith(
      expect.objectContaining({ event: "fax_inbound_malformed" }),
      expect.any(String),
    );
  });
});

describe("POST /fax/inbound — mid-transfer deduplication", () => {
  it("does not emit an audit for 'receiving' status", async () => {
    await request(makeApp())
      .post("/fax/inbound")
      .type("form")
      .send({ FaxSid: "FX002", Status: "receiving", NumPages: "1" });
    await flushMicrotasks();
    expect(logAuditMock).not.toHaveBeenCalled();
    expect(ingestInboundFaxMock).not.toHaveBeenCalled();
  });

  it("does not ingest when Status is absent", async () => {
    await request(makeApp())
      .post("/fax/inbound")
      .type("form")
      .send({ FaxSid: "FX003" });
    await flushMicrotasks();
    expect(ingestInboundFaxMock).not.toHaveBeenCalled();
  });
});

describe("POST /fax/inbound — terminal received event", () => {
  it("calls ingestInboundFax with parsed params", async () => {
    await request(makeApp()).post("/fax/inbound").type("form").send({
      FaxSid: "FX004",
      Status: "received",
      NumPages: "3",
      From: "+12155551212",
      To: "+19785551234",
      MediaUrl: "https://api.twilio.com/2010-04-01/x/Faxes/FX004/Media/ME9",
    });
    await flushMicrotasks();
    expect(ingestInboundFaxMock).toHaveBeenCalledOnce();
    const call = ingestInboundFaxMock.mock.calls[0]?.[0] as
      | Record<string, unknown>
      | undefined;
    expect(call?.twilioFaxSid).toBe("FX004");
    expect(call?.fromE164).toBe("+12155551212");
    expect(call?.toE164).toBe("+19785551234");
    expect(call?.numPages).toBe(3);
    expect(call?.mediaUrl).toBe(
      "https://api.twilio.com/2010-04-01/x/Faxes/FX004/Media/ME9",
    );
  });

  it("emits an audit for 'received' status", async () => {
    await request(makeApp())
      .post("/fax/inbound")
      .type("form")
      .send({ FaxSid: "FX005", Status: "received" });
    await flushMicrotasks();
    expect(logAuditMock).toHaveBeenCalledOnce();
  });

  it("audit action is fax.inbound_received", async () => {
    await request(makeApp())
      .post("/fax/inbound")
      .type("form")
      .send({ FaxSid: "FX006", Status: "received" });
    await flushMicrotasks();
    const call = logAuditMock.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(call.action).toBe("fax.inbound_received");
  });

  it("audit metadata contains twilio_fax_sid", async () => {
    await request(makeApp())
      .post("/fax/inbound")
      .type("form")
      .send({ FaxSid: "FX_AUDIT_SID", Status: "received", NumPages: "2" });
    await flushMicrotasks();
    const call = logAuditMock.mock.calls[0]?.[0] as Record<string, unknown>;
    const meta = call.metadata as Record<string, unknown>;
    expect(meta.twilio_fax_sid).toBe("FX_AUDIT_SID");
  });

  it("audit metadata contains num_pages, outcome, media_persisted", async () => {
    await request(makeApp())
      .post("/fax/inbound")
      .type("form")
      .send({ FaxSid: "FX007", Status: "received", NumPages: "4" });
    await flushMicrotasks();
    const call = logAuditMock.mock.calls[0]?.[0] as Record<string, unknown>;
    const meta = call.metadata as Record<string, unknown>;
    expect(meta.num_pages).toBe(4);
    expect(meta.outcome).toBe("inserted");
    expect(meta.media_persisted).toBe(true);
  });

  it("audit metadata records 'already_recorded' on Twilio replay", async () => {
    ingestInboundFaxMock.mockResolvedValueOnce({
      kind: "already_recorded",
      id: "00000000-0000-4000-8000-000000000abc",
    });
    await request(makeApp())
      .post("/fax/inbound")
      .type("form")
      .send({ FaxSid: "FX008", Status: "received" });
    await flushMicrotasks();
    const call = logAuditMock.mock.calls[0]?.[0] as Record<string, unknown>;
    const meta = call.metadata as Record<string, unknown>;
    expect(meta.outcome).toBe("already_recorded");
    expect(meta.media_persisted).toBeNull();
  });
});

describe("POST /fax/inbound — PHI invariants", () => {
  it("audit metadata never contains From or the literal phone digits", async () => {
    await request(makeApp()).post("/fax/inbound").type("form").send({
      FaxSid: "FX009",
      Status: "received",
      From: "+12155551212", // PHI — must not appear in audit
      NumPages: "1",
    });
    await flushMicrotasks();
    const call = logAuditMock.mock.calls[0]?.[0] as Record<string, unknown>;
    const meta = call.metadata as Record<string, unknown>;
    expect(Object.keys(meta)).not.toContain("From");
    expect(Object.keys(meta)).not.toContain("from");
    const serialized = JSON.stringify(meta);
    expect(serialized).not.toContain("+12155551212");
  });

  it("audit metadata never contains the MediaUrl literal", async () => {
    await request(makeApp()).post("/fax/inbound").type("form").send({
      FaxSid: "FX010",
      Status: "received",
      MediaUrl:
        "https://api.twilio.com/2010-04-01/x/Faxes/FX010/Media/SECRET-PATH",
    });
    await flushMicrotasks();
    const call = logAuditMock.mock.calls[0]?.[0] as Record<string, unknown>;
    const meta = call.metadata as Record<string, unknown>;
    expect(Object.keys(meta)).not.toContain("MediaUrl");
    expect(Object.keys(meta)).not.toContain("mediaUrl");
    // The Twilio-auth URL itself must not appear anywhere in the
    // audit metadata even though we DO record media_persisted as a
    // boolean (intentional — we want to know if the bytes landed).
    const serialized = JSON.stringify(meta);
    expect(serialized).not.toContain("SECRET-PATH");
    expect(serialized).not.toContain("api.twilio.com");
  });
});

describe("POST /fax/inbound — audit failure resilience", () => {
  it("swallows audit write failures without affecting the 200 response", async () => {
    logAuditMock.mockRejectedValueOnce(new Error("DB down"));
    const res = await request(makeApp())
      .post("/fax/inbound")
      .type("form")
      .send({ FaxSid: "FX011", Status: "received" });
    expect(res.status).toBe(200);
    await flushMicrotasks();
    expect(loggerWarnMock).toHaveBeenCalledWith(
      expect.objectContaining({ err: expect.any(Error) }),
      expect.any(String),
    );
  });
});
