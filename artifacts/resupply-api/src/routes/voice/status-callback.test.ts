// Route tests for POST /voice/status-callback.
//
// Signature middleware is replaced with a passthrough — see
// twiml-connect.test.ts for rationale.

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
    limit: () => Promise.resolve(result),
    returning: () => Promise.resolve(result),
    then: (resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) =>
      Promise.resolve(result).then(resolve, reject),
  };
  return obj;
}
const updateQueue: unknown[] = [];
const dbStub = {
  select: vi.fn(() => fluent([])),
  insert: vi.fn(() => fluent([])),
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

import statusCallbackRouter from "./status-callback";

function makeApp(): Express {
  const app = express();
  app.use(express.urlencoded({ extended: false }));
  app.use("/resupply-api", statusCallbackRouter);
  return app;
}

describe("POST /voice/status-callback", () => {
  beforeEach(() => {
    updateQueue.length = 0;
    dbStub.select.mockClear();
    dbStub.update.mockClear();
    logAuditMock.mockReset().mockResolvedValue(undefined);
  });
  afterEach(() => {
    /* no env to restore */
  });

  it("acks malformed bodies with empty <Response/>", async () => {
    const res = await request(makeApp())
      .post("/resupply-api/voice/status-callback?conversationId=c1")
      .type("form")
      .send({});
    expect(res.status).toBe(200);
    expect(res.text).toContain("<Response/>");
    expect(logAuditMock).not.toHaveBeenCalled();
  });

  it("acks non-terminal status without closing or auditing", async () => {
    const res = await request(makeApp())
      .post("/resupply-api/voice/status-callback?conversationId=c1")
      .type("form")
      .send({ CallSid: "CA1", CallStatus: "ringing" });
    expect(res.status).toBe(200);
    expect(dbStub.update).not.toHaveBeenCalled();
    expect(logAuditMock).not.toHaveBeenCalled();
  });

  it("closes conversation + audits voice.call.completed on terminal status", async () => {
    updateQueue.push(undefined);
    const res = await request(makeApp())
      .post("/resupply-api/voice/status-callback?conversationId=c1")
      .type("form")
      .send({ CallSid: "CA1", CallStatus: "completed" });
    expect(res.status).toBe(200);
    expect(dbStub.update).toHaveBeenCalledTimes(1);
    expect(logAuditMock).toHaveBeenCalledTimes(1);
    const audit = logAuditMock.mock.calls[0][0];
    expect(audit.action).toBe("voice.call.completed");
    expect(audit.targetTable).toBe("conversations");
    expect(audit.targetId).toBe("c1");
    expect(audit.metadata).toMatchObject({
      twilio_call_sid: "CA1",
      twilio_status: "completed",
      source: "status_callback",
    });
  });

  it.each(["failed", "busy", "no-answer", "canceled"])(
    "treats %s as terminal",
    async (status) => {
      updateQueue.push(undefined);
      const res = await request(makeApp())
        .post("/resupply-api/voice/status-callback?conversationId=c1")
        .type("form")
        .send({ CallSid: "CA1", CallStatus: status });
      expect(res.status).toBe(200);
      expect(dbStub.update).toHaveBeenCalledTimes(1);
      expect(logAuditMock).toHaveBeenCalledTimes(1);
      expect(logAuditMock.mock.calls[0][0].metadata.twilio_status).toBe(status);
    },
  );
});
