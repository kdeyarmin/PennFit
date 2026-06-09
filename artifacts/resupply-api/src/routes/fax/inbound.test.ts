// Route tests for the Telnyx inbound fax handler (faxInboundHandler).
//
// Coverage:
//   * 200 ACK on every request (Telnyx retries non-2xx)
//   * Missing fax_id → no audit/ingest, logs warning
//   * Non-fax.received event (outbound status) → no audit/ingest
//   * fax.received → ingestInboundFax invoked with mapped params
//   * Audit envelope contains fax_id, num_pages, direction, outcome,
//     media_persisted — never `from` or the media_url literal
//   * already_recorded outcome → media_persisted null
//   * Audit write failure is swallowed (logged, not surfaced)
//
// The Ed25519 signature middleware is exercised separately (telecom
// unit tests + webhooks integration test); here we mount the handler
// directly with express.json so the focus is the event handling.
//
// PHI invariant: `from` (sender fax number) and media_url literal never
// appear in any audit call argument — asserted explicitly.

import { describe, it, expect, vi, beforeEach } from "vitest";
import express, { type Express } from "express";
import request from "supertest";

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

type IngestOutcome =
  | { kind: "inserted"; id: string; mediaPersisted: boolean }
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

import { faxInboundHandler } from "./inbound";

function makeApp(): Express {
  const app = express();
  app.use(express.json());
  app.post("/fax/inbound", faxInboundHandler);
  return app;
}

/** Build a wrapped Telnyx fax.received event. */
function receivedEvent(payload: Record<string, unknown>) {
  return { data: { event_type: "fax.received", payload } };
}

async function flushMicrotasks() {
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
  it("always returns 200 with a JSON ACK", async () => {
    const res = await request(makeApp())
      .post("/fax/inbound")
      .send(receivedEvent({ fax_id: "fx-001", page_count: 2 }));
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ received: true });
  });

  it("still returns 200 when the event is malformed (no fax_id)", async () => {
    const res = await request(makeApp())
      .post("/fax/inbound")
      .send({ data: { event_type: "fax.received", payload: {} } });
    expect(res.status).toBe(200);
  });
});

describe("POST /fax/inbound — malformed body", () => {
  it("does not emit an audit or ingest call when fax_id is missing", async () => {
    await request(makeApp())
      .post("/fax/inbound")
      .send({ data: { event_type: "fax.received", payload: {} } });
    await flushMicrotasks();
    expect(logAuditMock).not.toHaveBeenCalled();
    expect(ingestInboundFaxMock).not.toHaveBeenCalled();
  });

  it("logs a warning when the event is malformed", async () => {
    await request(makeApp()).post("/fax/inbound").send({ nonsense: true });
    await flushMicrotasks();
    expect(loggerWarnMock).toHaveBeenCalledWith(
      expect.objectContaining({ event: "fax_inbound_malformed" }),
      expect.any(String),
    );
  });
});

describe("POST /fax/inbound — non-received events ignored", () => {
  it("does not ingest an outbound fax.delivered event", async () => {
    await request(makeApp())
      .post("/fax/inbound")
      .send({
        data: {
          event_type: "fax.delivered",
          payload: { fax_id: "fx-out", direction: "outbound" },
        },
      });
    await flushMicrotasks();
    expect(ingestInboundFaxMock).not.toHaveBeenCalled();
    expect(logAuditMock).not.toHaveBeenCalled();
  });
});

describe("POST /fax/inbound — terminal received event", () => {
  it("calls ingestInboundFax with parsed params", async () => {
    await request(makeApp())
      .post("/fax/inbound")
      .send(
        receivedEvent({
          fax_id: "fx-004",
          page_count: 3,
          from: "+12155551212",
          to: "+19785551234",
          media_url: "https://s3.amazonaws.com/telnyx/fx-004.pdf",
        }),
      );
    await flushMicrotasks();
    expect(ingestInboundFaxMock).toHaveBeenCalledOnce();
    const call = ingestInboundFaxMock.mock.calls[0]?.[0] as
      | Record<string, unknown>
      | undefined;
    expect(call?.telnyxFaxId).toBe("fx-004");
    expect(call?.fromE164).toBe("+12155551212");
    expect(call?.toE164).toBe("+19785551234");
    expect(call?.numPages).toBe(3);
    expect(call?.mediaUrl).toBe("https://s3.amazonaws.com/telnyx/fx-004.pdf");
  });

  it("audit action is fax.inbound_received with fax_id + counts", async () => {
    await request(makeApp())
      .post("/fax/inbound")
      .send(receivedEvent({ fax_id: "fx-006", page_count: 4 }));
    await flushMicrotasks();
    const call = logAuditMock.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(call.action).toBe("fax.inbound_received");
    const meta = call.metadata as Record<string, unknown>;
    expect(meta.fax_id).toBe("fx-006");
    expect(meta.num_pages).toBe(4);
    expect(meta.outcome).toBe("inserted");
    expect(meta.media_persisted).toBe(true);
  });

  it("records 'already_recorded' on a Telnyx replay", async () => {
    ingestInboundFaxMock.mockResolvedValueOnce({
      kind: "already_recorded",
      id: "00000000-0000-4000-8000-000000000abc",
    });
    await request(makeApp())
      .post("/fax/inbound")
      .send(receivedEvent({ fax_id: "fx-008" }));
    await flushMicrotasks();
    const meta = (logAuditMock.mock.calls[0]?.[0] as Record<string, unknown>)
      .metadata as Record<string, unknown>;
    expect(meta.outcome).toBe("already_recorded");
    expect(meta.media_persisted).toBeNull();
  });
});

describe("POST /fax/inbound — PHI invariants", () => {
  it("audit metadata never contains the sender number or media_url", async () => {
    await request(makeApp())
      .post("/fax/inbound")
      .send(
        receivedEvent({
          fax_id: "fx-009",
          from: "+12155551212",
          media_url: "https://s3.amazonaws.com/telnyx/SECRET-PATH.pdf",
          page_count: 1,
        }),
      );
    await flushMicrotasks();
    const meta = (logAuditMock.mock.calls[0]?.[0] as Record<string, unknown>)
      .metadata as Record<string, unknown>;
    expect(Object.keys(meta)).not.toContain("from");
    const serialized = JSON.stringify(meta);
    expect(serialized).not.toContain("+12155551212");
    expect(serialized).not.toContain("SECRET-PATH");
    expect(serialized).not.toContain("s3.amazonaws.com");
  });
});

describe("POST /fax/inbound — audit failure resilience", () => {
  it("swallows audit write failures without affecting the 200 response", async () => {
    logAuditMock.mockRejectedValueOnce(new Error("DB down"));
    const res = await request(makeApp())
      .post("/fax/inbound")
      .send(receivedEvent({ fax_id: "fx-011" }));
    expect(res.status).toBe(200);
    await flushMicrotasks();
    expect(loggerWarnMock).toHaveBeenCalledWith(
      expect.objectContaining({ err: expect.any(Error) }),
      expect.any(String),
    );
  });
});
