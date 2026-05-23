// Route tests for POST /voice/status-callback.
//
// Signature middleware is replaced with a passthrough — see
// twiml-connect.test.ts for rationale.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import express, { type Express } from "express";
import request from "supertest";

vi.mock("@workspace/resupply-telecom", async () => {
  const actual = await vi.importActual<
    typeof import("@workspace/resupply-telecom")
  >("@workspace/resupply-telecom");
  return {
    ...actual,
    requireTwilioSignature:
      () =>
      (_req: unknown, _res: unknown, next: (err?: unknown) => void): void => {
        next();
      },
  };
});

import {
  installSupabaseMock,
  stageSupabaseResponse,
  getSupabaseCallCount,
} from "../../test-helpers/supabase-mock";

const supabaseMock = installSupabaseMock();

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
    supabaseMock.reset();
    logAuditMock.mockReset().mockResolvedValue(undefined);
  });
  afterEach(() => {
    /* no env to restore */
  });

  it("acks malformed bodies with empty <Response/>", async () => {
    const res = await request(makeApp())
      .post("/resupply-api/voice/status-callback?conversationId=11111111-1111-4111-8111-111111111111")
      .type("form")
      .send({});
    expect(res.status).toBe(200);
    expect(res.text).toContain("<Response/>");
    expect(logAuditMock).not.toHaveBeenCalled();
  });

  it("acks non-terminal status without closing or auditing", async () => {
    const res = await request(makeApp())
      .post("/resupply-api/voice/status-callback?conversationId=11111111-1111-4111-8111-111111111111")
      .type("form")
      .send({ CallSid: "CA1", CallStatus: "ringing" });
    expect(res.status).toBe(200);
    expect(getSupabaseCallCount("conversations", "update")).toBe(0);
    expect(logAuditMock).not.toHaveBeenCalled();
  });

  it("closes conversation + audits voice.call.completed on terminal status", async () => {
    stageSupabaseResponse("conversations", "update", { error: null });
    const res = await request(makeApp())
      .post("/resupply-api/voice/status-callback?conversationId=11111111-1111-4111-8111-111111111111")
      .type("form")
      .send({ CallSid: "CA1", CallStatus: "completed" });
    expect(res.status).toBe(200);
    expect(getSupabaseCallCount("conversations", "update")).toBe(1);
    expect(logAuditMock).toHaveBeenCalledTimes(1);
    const audit = logAuditMock.mock.calls[0][0];
    expect(audit.action).toBe("voice.call.completed");
    expect(audit.targetTable).toBe("conversations");
    expect(audit.targetId).toBe("11111111-1111-4111-8111-111111111111");
    expect(audit.metadata).toMatchObject({
      twilio_call_sid: "CA1",
      twilio_status: "completed",
      source: "status_callback",
    });
  });

  it.each(["failed", "busy", "no-answer", "canceled"])(
    "treats %s as terminal",
    async (status) => {
      stageSupabaseResponse("conversations", "update", { error: null });
      const res = await request(makeApp())
        .post("/resupply-api/voice/status-callback?conversationId=11111111-1111-4111-8111-111111111111")
        .type("form")
        .send({ CallSid: "CA1", CallStatus: status });
      expect(res.status).toBe(200);
      expect(getSupabaseCallCount("conversations", "update")).toBe(1);
      expect(logAuditMock).toHaveBeenCalledTimes(1);
      expect(logAuditMock.mock.calls[0][0].metadata.twilio_status).toBe(status);
    },
  );
});
