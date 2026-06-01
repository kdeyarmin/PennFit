// Route tests for /email/click.
//
// Forward-port of main commit 63de00e (Task #20) — the route is now a
// two-step GET landing + POST action flow. GET renders an HTML form
// and audits an `email.link.opened` event; POST verifies the token
// again and performs the side-effect.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import express, { type Express } from "express";
import request from "supertest";

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

const placeOrderMock = vi.fn();
const pausePatientMock = vi.fn();
vi.mock("../../lib/messaging/order-flow", () => ({
  placeResupplyOrderForConversation: (...a: unknown[]) => placeOrderMock(...a),
  pausePatient: (...a: unknown[]) => pausePatientMock(...a),
}));

import clickRouter from "./click";
import { signLinkToken } from "@workspace/resupply-messaging";

const PATIENT_ID = "11111111-1111-4111-8111-111111111111";
const EPISODE_ID = "22222222-2222-4222-8222-222222222222";
const CONVERSATION_ID = "33333333-3333-4333-8333-333333333333";

function makeApp(): Express {
  const app = express();
  app.use("/resupply-api", clickRouter);
  return app;
}

const ENV_KEYS = [
  "TWILIO_ACCOUNT_SID",
  "TWILIO_AUTH_TOKEN",
  "TWILIO_PHONE_NUMBER",
  "SENDGRID_API_KEY",
  "SENDGRID_FROM_EMAIL",
  "SENDGRID_FROM_NAME",
  "SENDGRID_EVENT_WEBHOOK_PUBLIC_KEY",
  "RESUPPLY_LINK_HMAC_KEY",
  "RESUPPLY_VOICE_PUBLIC_BASE_URL",
] as const;
type EnvKey = (typeof ENV_KEYS)[number];
const originalEnv: Partial<Record<EnvKey, string | undefined>> = {};

function setMessagingEnv(): void {
  process.env.TWILIO_ACCOUNT_SID = "ACtest";
  process.env.TWILIO_AUTH_TOKEN = "test-twilio-token";
  process.env.TWILIO_PHONE_NUMBER = "+12158675309";
  process.env.SENDGRID_API_KEY = "SG.testkey";
  process.env.SENDGRID_FROM_EMAIL = "no-reply@penn.example";
  process.env.SENDGRID_FROM_NAME = "Penn Sleep";
  process.env.SENDGRID_EVENT_WEBHOOK_PUBLIC_KEY = "fake-pubkey";
  process.env.RESUPPLY_LINK_HMAC_KEY =
    "QkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkI=";
  process.env.RESUPPLY_VOICE_PUBLIC_BASE_URL = "https://test.example.com";
}

function resetMocks(): void {
  supabaseMock.reset();
  logAuditMock.mockReset().mockResolvedValue(undefined);
  placeOrderMock.mockReset();
  pausePatientMock.mockReset().mockResolvedValue(undefined);
}

describe("GET /email/click (landing page — no side effects)", () => {
  beforeEach(() => {
    for (const k of ENV_KEYS) originalEnv[k] = process.env[k];
    for (const k of ENV_KEYS) delete process.env[k];
    resetMocks();
  });
  afterEach(() => {
    for (const k of ENV_KEYS) {
      if (originalEnv[k] === undefined) delete process.env[k];
      else process.env[k] = originalEnv[k];
    }
  });

  it("returns 503 when messaging is not configured", async () => {
    const res = await request(makeApp()).get(
      "/resupply-api/email/click?t=anything",
    );
    expect(res.status).toBe(503);
    expect(res.headers["content-type"]).toContain("text/html");
  });

  it("returns 400 on missing token", async () => {
    setMessagingEnv();
    const res = await request(makeApp()).get("/resupply-api/email/click");
    expect(res.status).toBe(400);
  });

  it("returns 400 on tampered token (signature mismatch)", async () => {
    setMessagingEnv();
    const good = signLinkToken({
      conversationId: CONVERSATION_ID,
      action: "confirm",
    });
    const [payload, sig] = good.split(".");
    const bad =
      payload + "." + (sig.charAt(0) === "A" ? "B" : "A") + sig.slice(1);

    const res = await request(makeApp()).get(
      `/resupply-api/email/click?t=${encodeURIComponent(bad)}`,
    );
    expect(res.status).toBe(400);
    expect(logAuditMock).not.toHaveBeenCalled();
  });

  it("returns 400 on expired token without leaking the conversation", async () => {
    setMessagingEnv();
    const expiredToken = signLinkToken({
      conversationId: CONVERSATION_ID,
      action: "confirm",
      expiresAt: new Date(Date.now() - 60_000),
    });
    const res = await request(makeApp()).get(
      `/resupply-api/email/click?t=${encodeURIComponent(expiredToken)}`,
    );
    expect(res.status).toBe(400);
    expect(logAuditMock).not.toHaveBeenCalled();
  });

  it("renders generic error if conversation not found (no leak)", async () => {
    setMessagingEnv();
    const token = signLinkToken({
      conversationId: CONVERSATION_ID,
      action: "confirm",
    });
    stageSupabaseResponse("conversations", "select", { data: null });

    const res = await request(makeApp()).get(
      `/resupply-api/email/click?t=${encodeURIComponent(token)}`,
    );
    expect(res.status).toBe(400);
    expect(logAuditMock).not.toHaveBeenCalled();
  });

  it("renders the landing page with a POST <form> and never mutates state", async () => {
    setMessagingEnv();
    const token = signLinkToken({
      conversationId: CONVERSATION_ID,
      action: "confirm",
    });
    stageSupabaseResponse("conversations", "select", {
      data: { id: CONVERSATION_ID },
    });

    const res = await request(makeApp()).get(
      `/resupply-api/email/click?t=${encodeURIComponent(token)}`,
    );

    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toContain("text/html");
    // Crucial: the landing page contains a POST form so a mail-scanner
    // pre-fetch (which only issues GETs) cannot trigger the action.
    expect(res.text).toContain('method="POST"');
    expect(res.text).toContain(encodeURIComponent(token));

    // GET must NEVER touch the order-flow / patient-pause helpers.
    expect(placeOrderMock).not.toHaveBeenCalled();
    expect(pausePatientMock).not.toHaveBeenCalled();
    expect(getSupabaseCallCount("conversations", "update")).toBe(0);

    // The link-open is audited (informational, no PHI mutation).
    const audits = logAuditMock.mock.calls.map((c) => c[0]);
    expect(audits.find((a) => a.action === "email.link.opened")).toBeDefined();
    expect(
      audits.find((a) => a.action === "messaging.order.confirmed"),
    ).toBeUndefined();
  });
});

describe("POST /email/click (signed action)", () => {
  beforeEach(() => {
    for (const k of ENV_KEYS) originalEnv[k] = process.env[k];
    for (const k of ENV_KEYS) delete process.env[k];
    resetMocks();
  });
  afterEach(() => {
    for (const k of ENV_KEYS) {
      if (originalEnv[k] === undefined) delete process.env[k];
      else process.env[k] = originalEnv[k];
    }
  });

  it("rejects POST with a tampered token", async () => {
    setMessagingEnv();
    const good = signLinkToken({
      conversationId: CONVERSATION_ID,
      action: "confirm",
    });
    const [payload, sig] = good.split(".");
    const bad =
      payload + "." + (sig.charAt(0) === "A" ? "B" : "A") + sig.slice(1);

    const res = await request(makeApp()).post(
      `/resupply-api/email/click?t=${encodeURIComponent(bad)}`,
    );
    expect(res.status).toBe(400);
    expect(placeOrderMock).not.toHaveBeenCalled();
  });

  it("confirm: places order, closes conversation, audits, returns 200", async () => {
    setMessagingEnv();
    const token = signLinkToken({
      conversationId: CONVERSATION_ID,
      action: "confirm",
    });
    stageSupabaseResponse("conversations", "select", {
      data: {
        id: CONVERSATION_ID,
        patient_id: PATIENT_ID,
        episode_id: EPISODE_ID,
      },
    });
    // Closing-the-conversation update on the success path.
    stageSupabaseResponse("conversations", "update", { error: null });
    placeOrderMock.mockResolvedValue({
      status: "ok",
      episodeId: EPISODE_ID,
      patientId: PATIENT_ID,
      fulfillmentIds: ["f1"],
    });

    const res = await request(makeApp()).post(
      `/resupply-api/email/click?t=${encodeURIComponent(token)}`,
    );
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toContain("text/html");
    expect(placeOrderMock).toHaveBeenCalledWith({
      conversationId: CONVERSATION_ID,
    });
    const audits = logAuditMock.mock.calls.map((c) => c[0]);
    expect(audits.find((a) => a.action === "email.link.clicked")).toBeDefined();
    expect(
      audits.find((a) => a.action === "messaging.order.confirmed"),
    ).toBeDefined();
  });

  it("confirm + coverage_blocked: parks in awaiting_admin, renders review, audits blocked_coverage", async () => {
    setMessagingEnv();
    const token = signLinkToken({
      conversationId: CONVERSATION_ID,
      action: "confirm",
    });
    stageSupabaseResponse("conversations", "select", {
      data: {
        id: CONVERSATION_ID,
        patient_id: PATIENT_ID,
        episode_id: EPISODE_ID,
      },
    });
    // awaiting_admin update on the coverage-hold path.
    stageSupabaseResponse("conversations", "update", { error: null });
    placeOrderMock.mockResolvedValue({
      status: "coverage_blocked",
      episodeId: EPISODE_ID,
      patientId: PATIENT_ID,
      coverage: {
        reason: "inactive",
        payerName: "Aetna",
        eligibilityCheckId: "elig-1",
      },
    });

    const res = await request(makeApp()).post(
      `/resupply-api/email/click?t=${encodeURIComponent(token)}`,
    );
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toContain("text/html");
    const blockedAudit = logAuditMock.mock.calls
      .map((c) => c[0])
      .find((a) => a.action === "messaging.order.blocked_coverage");
    expect(blockedAudit).toBeDefined();
    expect(blockedAudit.metadata.coverage_reason).toBe("inactive");
    expect(blockedAudit.metadata.eligibility_check_id).toBe("elig-1");
  });

  it("stop: pauses patient, closes conversation, audits", async () => {
    setMessagingEnv();
    const token = signLinkToken({
      conversationId: CONVERSATION_ID,
      action: "stop",
    });
    stageSupabaseResponse("conversations", "select", {
      data: {
        id: CONVERSATION_ID,
        patient_id: PATIENT_ID,
        episode_id: EPISODE_ID,
      },
    });
    stageSupabaseResponse("conversations", "update", { error: null });

    const res = await request(makeApp()).post(
      `/resupply-api/email/click?t=${encodeURIComponent(token)}`,
    );
    expect(res.status).toBe(200);
    expect(pausePatientMock).toHaveBeenCalledWith(PATIENT_ID);
    const handoffAudit = logAuditMock.mock.calls
      .map((c) => c[0])
      .find(
        (a) =>
          a.action === "messaging.handoff.escalated" &&
          a.metadata.reason === "stop_link",
      );
    expect(handoffAudit).toBeDefined();
  });

  it("edit: parks conversation in awaiting_admin, audits", async () => {
    setMessagingEnv();
    const token = signLinkToken({
      conversationId: CONVERSATION_ID,
      action: "edit",
    });
    stageSupabaseResponse("conversations", "select", {
      data: {
        id: CONVERSATION_ID,
        patient_id: PATIENT_ID,
        episode_id: EPISODE_ID,
      },
    });
    stageSupabaseResponse("conversations", "update", { error: null });

    const res = await request(makeApp()).post(
      `/resupply-api/email/click?t=${encodeURIComponent(token)}`,
    );
    expect(res.status).toBe(200);
    const handoffAudit = logAuditMock.mock.calls
      .map((c) => c[0])
      .find(
        (a) =>
          a.action === "messaging.handoff.escalated" &&
          a.metadata.reason === "edit_address_link",
      );
    expect(handoffAudit).toBeDefined();
    expect(placeOrderMock).not.toHaveBeenCalled();
    expect(pausePatientMock).not.toHaveBeenCalled();
  });
});
