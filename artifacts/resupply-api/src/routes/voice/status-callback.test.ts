// Route tests for POST /voice/status-callback.
//
// Signature middleware is replaced with a passthrough — see
// twiml-connect.test.ts for rationale.
//
// PR change: malformed/incomplete callbacks now emit a structured
// logger.warn with diagnostic fields so ops can investigate when
// conversations go unclosed. Tests for the new logging are in the
// second describe block below.

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
  getSupabaseWritePayloads,
} from "../../test-helpers/supabase-mock";

const supabaseMock = installSupabaseMock();

const logAuditMock = vi.fn().mockResolvedValue(undefined);
vi.mock("@workspace/resupply-audit", () => ({
  logAudit: (...a: unknown[]) => logAuditMock(...a),
}));

const loggerWarnMock = vi.hoisted(() => vi.fn());
vi.mock("../../lib/logger", () => ({
  logger: {
    warn: loggerWarnMock,
    info: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

vi.mock("../../lib/metering/usage", () => ({
  recordTenantUsage: vi.fn(async () => {}),
}));

import statusCallbackRouter from "./status-callback";
import { recordTenantUsage } from "../../lib/metering/usage";

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
    loggerWarnMock.mockReset();
    vi.mocked(recordTenantUsage).mockClear();
  });
  afterEach(() => {
    /* no env to restore */
  });

  it("acks malformed bodies with empty <Response/>", async () => {
    const res = await request(makeApp())
      .post(
        "/resupply-api/voice/status-callback?conversationId=11111111-1111-4111-8111-111111111111",
      )
      .type("form")
      .send({});
    expect(res.status).toBe(200);
    expect(res.text).toContain("<Response/>");
    expect(logAuditMock).not.toHaveBeenCalled();
  });

  it("acks non-terminal status without closing or auditing", async () => {
    const res = await request(makeApp())
      .post(
        "/resupply-api/voice/status-callback?conversationId=11111111-1111-4111-8111-111111111111",
      )
      .type("form")
      .send({ CallSid: "CA1", CallStatus: "ringing" });
    expect(res.status).toBe(200);
    expect(getSupabaseCallCount("conversations", "update")).toBe(0);
    expect(logAuditMock).not.toHaveBeenCalled();
  });

  it("closes conversation + audits voice.call.completed on terminal status", async () => {
    // The route now .select("id")s the UPDATE return so a duplicate
    // Twilio retry on an already-closed row doesn't double-audit.
    // Stage a one-element data payload so the row counts as the
    // first close + the audit fires.
    //
    // The route also reads the conversation's org up front, so the call's
    // real tenant is known to BOTH the metering and the voice_calls
    // telemetry row (whose org_id is what /admin/voice/metrics filters on).
    stageSupabaseResponse("conversations", "select", {
      data: { org_id: "44444444-4444-4444-8444-444444444444" },
      error: null,
    });
    stageSupabaseResponse("conversations", "update", {
      data: [{ id: "11111111-1111-4111-8111-111111111111" }],
      error: null,
    });
    const res = await request(makeApp())
      .post(
        "/resupply-api/voice/status-callback?conversationId=11111111-1111-4111-8111-111111111111",
      )
      .type("form")
      .send({ CallSid: "CA1", CallStatus: "completed" });
    expect(res.status).toBe(200);
    expect(getSupabaseCallCount("conversations", "update")).toBe(1);
    // Tenant-agnostic webhook keyed by the globally-unique conversation id:
    // the close must NOT be org-scoped (the facade forces org_id onto the
    // patch), else a non-seed tenant's call would never close.
    const [closePatch] = getSupabaseWritePayloads(
      "conversations",
      "update",
    ) as Array<Record<string, unknown>>;
    expect(closePatch).not.toHaveProperty("org_id");
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
    // First close → one aiVoiceEvents metered (G12), against the call's
    // own tenant.
    expect(vi.mocked(recordTenantUsage)).toHaveBeenCalledWith(
      expect.objectContaining({
        metricKey: "aiVoiceEvents",
        orgId: "44444444-4444-4444-8444-444444444444",
      }),
    );
  });

  it("does not meter a completed call whose tenant cannot be resolved", async () => {
    // This used to read `callOrgId ?? orgId`, billing an un-attributable
    // call to the SEED tenant — a practice that did not place it, on a
    // metered metric. An unknown tenant means nobody can be billed: log it
    // and skip, so the gap is visible rather than charged to a stranger.
    stageSupabaseResponse("conversations", "select", {
      data: null,
      error: null,
    });
    stageSupabaseResponse("conversations", "update", {
      data: [{ id: "11111111-1111-4111-8111-111111111111" }],
      error: null,
    });

    const res = await request(makeApp())
      .post(
        "/resupply-api/voice/status-callback?conversationId=11111111-1111-4111-8111-111111111111",
      )
      .type("form")
      .send({ CallSid: "CA_untenanted", CallStatus: "completed" });

    expect(res.status).toBe(200);
    expect(vi.mocked(recordTenantUsage)).not.toHaveBeenCalled();
  });

  it("meters aiVoiceEvents against the call's REAL tenant (org_id off the flipped row), not the seed org", async () => {
    // The close UPDATE returns the conversation's own org_id. A non-seed
    // tenant's voice call must be metered against THAT tenant, not the seed
    // org the webhook resolved for the (tenant-agnostic) close.
    const NON_SEED_ORG = "55555555-5555-4555-8555-555555555555";
    stageSupabaseResponse("conversations", "update", {
      data: [
        { id: "11111111-1111-4111-8111-111111111111", org_id: NON_SEED_ORG },
      ],
      error: null,
    });
    const res = await request(makeApp())
      .post(
        "/resupply-api/voice/status-callback?conversationId=11111111-1111-4111-8111-111111111111",
      )
      .type("form")
      .send({ CallSid: "CA1", CallStatus: "completed" });
    expect(res.status).toBe(200);
    expect(vi.mocked(recordTenantUsage)).toHaveBeenCalledWith(
      expect.objectContaining({
        orgId: NON_SEED_ORG,
        metricKey: "aiVoiceEvents",
      }),
    );
  });

  it("does not audit or meter a re-delivered (already-closed) callback", async () => {
    // Empty update return = the row was already closed (ws-handler or a
    // prior callback won) → not the first close, so neither the audit nor
    // the aiVoiceEvents metric fires (no double-count).
    stageSupabaseResponse("conversations", "update", { data: [], error: null });
    const res = await request(makeApp())
      .post(
        "/resupply-api/voice/status-callback?conversationId=11111111-1111-4111-8111-111111111111",
      )
      .type("form")
      .send({ CallSid: "CA1", CallStatus: "completed" });
    expect(res.status).toBe(200);
    expect(logAuditMock).not.toHaveBeenCalled();
    expect(vi.mocked(recordTenantUsage)).not.toHaveBeenCalled();
  });

  it.each(["failed", "busy", "no-answer", "canceled"])(
    "treats %s as terminal",
    async (status) => {
      // The route now .select("id")s the UPDATE return so a duplicate
      // Twilio retry on an already-closed row doesn't double-audit.
      // Stage a one-element data payload so the row counts as the
      // first close + the audit fires.
      stageSupabaseResponse("conversations", "update", {
        data: [{ id: "11111111-1111-4111-8111-111111111111" }],
        error: null,
      });
      const res = await request(makeApp())
        .post(
          "/resupply-api/voice/status-callback?conversationId=11111111-1111-4111-8111-111111111111",
        )
        .type("form")
        .send({ CallSid: "CA1", CallStatus: status });
      expect(res.status).toBe(200);
      expect(getSupabaseCallCount("conversations", "update")).toBe(1);
      expect(logAuditMock).toHaveBeenCalledTimes(1);
      expect(logAuditMock.mock.calls[0][0].metadata.twilio_status).toBe(status);
    },
  );
});

// ── Structured logging for malformed callbacks (PR change) ───────────────────
//
// PR adds a logger.warn call with diagnostic fields when a status-callback
// is missing required fields. This surfaces the breakage so ops can see
// open conversations that will never receive a "call ended" tick.

describe("POST /voice/status-callback — structured logging for malformed callbacks (PR change)", () => {
  beforeEach(() => {
    supabaseMock.reset();
    logAuditMock.mockReset().mockResolvedValue(undefined);
    loggerWarnMock.mockReset();
  });

  it("emits logger.warn with event=voice_status_callback_malformed when CallStatus is missing", async () => {
    await request(makeApp())
      .post(
        "/resupply-api/voice/status-callback?conversationId=11111111-1111-4111-8111-111111111111",
      )
      .type("form")
      .send({ CallSid: "CA1" }); // no CallStatus

    expect(loggerWarnMock).toHaveBeenCalled();
    const [ctx] = loggerWarnMock.mock.calls[0] as [
      Record<string, unknown>,
      string,
    ];
    expect(ctx.event).toBe("voice_status_callback_malformed");
    expect(ctx.hasCallStatus).toBe(false);
    expect(ctx.hasCallSid).toBe(true);
    expect(ctx.hasConversationId).toBe(true);
  });

  it("emits logger.warn with event=voice_status_callback_malformed when CallSid is missing", async () => {
    await request(makeApp())
      .post(
        "/resupply-api/voice/status-callback?conversationId=11111111-1111-4111-8111-111111111111",
      )
      .type("form")
      .send({ CallStatus: "completed" }); // no CallSid

    expect(loggerWarnMock).toHaveBeenCalled();
    const [ctx] = loggerWarnMock.mock.calls[0] as [
      Record<string, unknown>,
      string,
    ];
    expect(ctx.event).toBe("voice_status_callback_malformed");
    expect(ctx.hasCallStatus).toBe(true);
    expect(ctx.hasCallSid).toBe(false);
  });

  it("emits logger.warn when conversationId is missing from query string", async () => {
    await request(makeApp())
      .post("/resupply-api/voice/status-callback") // no ?conversationId
      .type("form")
      .send({ CallSid: "CA1", CallStatus: "completed" });

    expect(loggerWarnMock).toHaveBeenCalled();
    const [ctx] = loggerWarnMock.mock.calls[0] as [
      Record<string, unknown>,
      string,
    ];
    expect(ctx.event).toBe("voice_status_callback_malformed");
    expect(ctx.hasConversationId).toBe(false);
  });

  it("sets conversationIdParseError=invalid_uuid when conversationId is not a UUID", async () => {
    await request(makeApp())
      .post("/resupply-api/voice/status-callback?conversationId=not-a-uuid")
      .type("form")
      .send({ CallSid: "CA1", CallStatus: "completed" });

    expect(loggerWarnMock).toHaveBeenCalled();
    const [ctx] = loggerWarnMock.mock.calls[0] as [
      Record<string, unknown>,
      string,
    ];
    expect(ctx.event).toBe("voice_status_callback_malformed");
    expect(ctx.conversationIdParseError).toBe("invalid_uuid");
    expect(ctx.hasConversationId).toBe(false);
  });

  it("sets conversationIdParseError=null when all fields are present and valid", async () => {
    // On a valid request, logger.warn for malformed should NOT be called
    stageSupabaseResponse("conversations", "update", {
      data: [{ id: "11111111-1111-4111-8111-111111111111" }],
      error: null,
    });
    await request(makeApp())
      .post(
        "/resupply-api/voice/status-callback?conversationId=11111111-1111-4111-8111-111111111111",
      )
      .type("form")
      .send({ CallSid: "CA1", CallStatus: "completed" });

    // logger.warn must NOT have been called with the malformed event
    const malformedCalls = loggerWarnMock.mock.calls.filter(
      (c: unknown[]) =>
        typeof c[0] === "object" &&
        c[0] !== null &&
        (c[0] as Record<string, unknown>).event ===
          "voice_status_callback_malformed",
    );
    expect(malformedCalls).toHaveLength(0);
  });

  it("returns 200 <Response/> even when logging the malformed warning (ack for Twilio)", async () => {
    const res = await request(makeApp())
      .post("/resupply-api/voice/status-callback")
      .type("form")
      .send({});

    expect(res.status).toBe(200);
    expect(res.text).toContain("<Response/>");
  });

  it("includes a human-readable log message string alongside the context object", async () => {
    await request(makeApp())
      .post("/resupply-api/voice/status-callback")
      .type("form")
      .send({});

    expect(loggerWarnMock).toHaveBeenCalled();
    const [, message] = loggerWarnMock.mock.calls[0] as [unknown, string];
    expect(typeof message).toBe("string");
    expect(message).toMatch(
      /status-callback.*malformed|malformed.*status-callback/i,
    );
  });
});
