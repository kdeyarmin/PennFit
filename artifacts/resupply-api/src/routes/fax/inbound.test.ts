// Route tests for POST /fax/inbound (Twilio inbound fax webhook).
//
// Coverage:
//   * 200 + TwiML <Response/> ACK on every request (Twilio retries 5xx)
//   * Missing FaxSid → no audit, logs warning
//   * "receiving" status (mid-transfer) → no audit emitted
//   * "received" status → audit emitted with non-PHI envelope
//   * Audit envelope contains fax_sid, num_pages, direction — never From/MediaUrl
//   * NumPages defaults to null when absent
//   * Direction defaults to "inbound" when absent
//   * Audit write failure is swallowed (logged, not surfaced)
//
// PHI invariant: From (sender fax number) and MediaUrl never appear in
// any audit call argument — asserted explicitly in every relevant test.

import { describe, it, expect, vi, beforeEach } from "vitest";
import express, { type Express } from "express";
import request from "supertest";

// Bypass Twilio signature validation — all inbound tests share this stub.
vi.mock("@workspace/resupply-telecom", async () => {
  const actual =
    await vi.importActual<typeof import("@workspace/resupply-telecom")>(
      "@workspace/resupply-telecom",
    );
  return {
    ...actual,
    requireTwilioSignature: () =>
      (_req: unknown, _res: unknown, next: () => void) => next(),
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

import inboundRouter from "./inbound";

function makeApp(): Express {
  const app = express();
  app.use(express.urlencoded({ extended: false }));
  app.use(inboundRouter);
  return app;
}

beforeEach(() => {
  logAuditMock.mockClear();
  loggerWarnMock.mockClear();
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
  it("does not emit an audit when FaxSid is missing", async () => {
    await request(makeApp())
      .post("/fax/inbound")
      .type("form")
      .send({ Status: "received" });
    expect(logAuditMock).not.toHaveBeenCalled();
  });

  it("logs a warning when FaxSid is missing", async () => {
    await request(makeApp())
      .post("/fax/inbound")
      .type("form")
      .send({ Status: "received" });
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
    expect(logAuditMock).not.toHaveBeenCalled();
  });

  it("does not emit an audit when Status is absent", async () => {
    await request(makeApp())
      .post("/fax/inbound")
      .type("form")
      .send({ FaxSid: "FX003" });
    expect(logAuditMock).not.toHaveBeenCalled();
  });
});

describe("POST /fax/inbound — terminal received event", () => {
  it("emits an audit for 'received' status", async () => {
    await request(makeApp())
      .post("/fax/inbound")
      .type("form")
      .send({ FaxSid: "FX004", Status: "received", NumPages: "3", Direction: "inbound" });
    expect(logAuditMock).toHaveBeenCalledOnce();
  });

  it("audit action is physician_fax.inbound_received", async () => {
    await request(makeApp())
      .post("/fax/inbound")
      .type("form")
      .send({ FaxSid: "FX005", Status: "received" });
    const call = logAuditMock.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(call.action).toBe("physician_fax.inbound_received");
  });

  it("audit metadata contains twilio_fax_sid", async () => {
    await request(makeApp())
      .post("/fax/inbound")
      .type("form")
      .send({ FaxSid: "FX_AUDIT_SID", Status: "received", NumPages: "2" });
    const call = logAuditMock.mock.calls[0]?.[0] as Record<string, unknown>;
    const meta = call.metadata as Record<string, unknown>;
    expect(meta.twilio_fax_sid).toBe("FX_AUDIT_SID");
  });

  it("audit metadata contains num_pages as a number", async () => {
    await request(makeApp())
      .post("/fax/inbound")
      .type("form")
      .send({ FaxSid: "FX006", Status: "received", NumPages: "4" });
    const call = logAuditMock.mock.calls[0]?.[0] as Record<string, unknown>;
    const meta = call.metadata as Record<string, unknown>;
    expect(meta.num_pages).toBe(4);
  });

  it("audit metadata defaults num_pages to null when absent", async () => {
    await request(makeApp())
      .post("/fax/inbound")
      .type("form")
      .send({ FaxSid: "FX007", Status: "received" });
    const call = logAuditMock.mock.calls[0]?.[0] as Record<string, unknown>;
    const meta = call.metadata as Record<string, unknown>;
    expect(meta.num_pages).toBeNull();
  });

  it("audit metadata defaults direction to 'inbound' when absent", async () => {
    await request(makeApp())
      .post("/fax/inbound")
      .type("form")
      .send({ FaxSid: "FX008", Status: "received" });
    const call = logAuditMock.mock.calls[0]?.[0] as Record<string, unknown>;
    const meta = call.metadata as Record<string, unknown>;
    expect(meta.direction).toBe("inbound");
  });
});

describe("POST /fax/inbound — PHI invariants", () => {
  it("audit metadata never contains From (sender fax number)", async () => {
    await request(makeApp())
      .post("/fax/inbound")
      .type("form")
      .send({
        FaxSid: "FX009",
        Status: "received",
        From: "+12155551212", // PHI — must not appear in audit
        NumPages: "1",
      });
    const call = logAuditMock.mock.calls[0]?.[0] as Record<string, unknown>;
    const meta = call.metadata as Record<string, unknown>;
    expect(Object.keys(meta)).not.toContain("From");
    expect(Object.keys(meta)).not.toContain("from");
    const serialized = JSON.stringify(meta);
    expect(serialized).not.toContain("+12155551212");
  });

  it("audit metadata never contains MediaUrl", async () => {
    await request(makeApp())
      .post("/fax/inbound")
      .type("form")
      .send({
        FaxSid: "FX010",
        Status: "received",
        MediaUrl: "https://api.twilio.com/fax/FX010/media",
      });
    const call = logAuditMock.mock.calls[0]?.[0] as Record<string, unknown>;
    const meta = call.metadata as Record<string, unknown>;
    expect(Object.keys(meta)).not.toContain("MediaUrl");
    expect(Object.keys(meta)).not.toContain("mediaUrl");
    const serialized = JSON.stringify(meta);
    expect(serialized).not.toContain("media");
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
    // Give the fire-and-forget promise a tick to settle.
    await new Promise((r) => setImmediate(r));
    expect(loggerWarnMock).toHaveBeenCalledWith(
      expect.objectContaining({ err: expect.any(Error) }),
      expect.any(String),
    );
  });
});
