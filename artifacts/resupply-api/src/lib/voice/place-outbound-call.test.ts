// Unit tests for placeOutboundReorderCall — the shared outbound-call
// helper. The admin (HTTP) path is covered by routes/voice/place-call.test.ts;
// these focus on the SYSTEM-actor path the reminders.place-call escalation
// job uses, plus the recoverable outcomes the job branches on.
//
// Mocking mirrors the place-call route test: a Supabase service-role mock
// stages the patient/episode/conversation rows, createTwilioClient is
// stubbed so we never dial, and @workspace/resupply-audit is observable.

import { describe, it, expect, vi, beforeEach } from "vitest";

import {
  installSupabaseMock,
  stageSupabaseResponse,
} from "../../test-helpers/supabase-mock";

const supabaseMock = installSupabaseMock();

const logAuditMock = vi.fn().mockResolvedValue(undefined);
vi.mock("@workspace/resupply-audit", () => ({
  logAudit: (...a: unknown[]) => logAuditMock(...a),
}));

const placeCallMock = vi.fn();
vi.mock("@workspace/resupply-telecom", async () => {
  const actual = await vi.importActual<
    typeof import("@workspace/resupply-telecom")
  >("@workspace/resupply-telecom");
  return {
    ...actual,
    createTwilioClient: vi.fn(() => ({ placeCall: placeCallMock })),
  };
});

import { placeOutboundReorderCall } from "./place-outbound-call";
import {
  __resetPendingSessionsForTests,
  getPendingSessions,
} from "./pending-sessions";
import type { VoiceConfig } from "./voice-config";

const PATIENT_ID = "11111111-1111-4111-8111-111111111111";
const EPISODE_ID = "22222222-2222-4222-8222-222222222222";
const CONVERSATION_ID = "33333333-3333-4333-8333-333333333333";
const ORG_ID = "44444444-4444-4444-8444-444444444444";

const CONFIG: VoiceConfig & { twilioPhoneNumber: string } = {
  openaiApiKey: "test-openai-key",
  twilioAccountSid: "ACtest",
  twilioAuthToken: "test-twilio-token",
  twilioPhoneNumber: "+12158675309",
  publicBaseUrl: "https://test.example.com",
  streamBaseUrl: "https://test.example.com",
  elevenLabsTransport: "ws",
  realtimeSchema: "beta",
  realtimeDiagnosticEnabled: false,
};

function systemActor() {
  return { kind: "system", jobId: "job_123" } as const;
}

describe("placeOutboundReorderCall (system actor)", () => {
  beforeEach(() => {
    supabaseMock.reset();
    placeCallMock.mockReset();
    logAuditMock.mockReset().mockResolvedValue(undefined);
    __resetPendingSessionsForTests();
  });

  it("dials, opens a voice conversation, registers the pending session, audits ok", async () => {
    stageSupabaseResponse("patients", "select", {
      data: { id: PATIENT_ID, phone_e164: "+12155551212", status: "active" },
    });
    stageSupabaseResponse("episodes", "select", {
      data: { id: EPISODE_ID, patient_id: PATIENT_ID },
    });
    stageSupabaseResponse("conversations", "insert", {
      data: { id: CONVERSATION_ID },
    });
    stageSupabaseResponse("conversations", "update", { error: null });
    placeCallMock.mockResolvedValue({ sid: "CA_TEST_123" });

    const outcome = await placeOutboundReorderCall({
      orgId: ORG_ID,
      patientId: PATIENT_ID,
      episodeId: EPISODE_ID,
      config: CONFIG,
      actor: systemActor(),
    });

    expect(outcome).toEqual({
      status: "ok",
      conversationId: CONVERSATION_ID,
      callSid: "CA_TEST_123",
    });

    // Twilio dialed with the conversation-scoped TwiML URL.
    expect(placeCallMock).toHaveBeenCalledTimes(1);
    const call = placeCallMock.mock.calls[0][0];
    expect(call.to).toBe("+12155551212");
    expect(call.from).toBe("+12158675309");
    expect(call.url).toBe(
      `https://test.example.com/resupply-api/voice/twiml-connect?conversationId=${CONVERSATION_ID}`,
    );

    // Pending session registered + stamped with the CallSid.
    const entry = await getPendingSessions().peek(CONVERSATION_ID);
    expect(entry?.patientId).toBe(PATIENT_ID);
    expect(entry?.episodeId).toBe(EPISODE_ID);
    expect(entry?.orgId).toBe(ORG_ID);
    expect(entry?.twilioCallSid).toBe("CA_TEST_123");

    // Audit carries the SYSTEM actor fields and no PHI.
    expect(logAuditMock).toHaveBeenCalledTimes(1);
    const audit = logAuditMock.mock.calls[0][0];
    expect(audit.action).toBe("voice.call.placed");
    expect(audit.adminEmail).toBeNull();
    expect(audit.metadata.actor_kind).toBe("system");
    expect(audit.metadata.job_id).toBe("job_123");
    expect(audit.metadata.status).toBe("ok");
    expect(JSON.stringify(audit.metadata)).not.toContain("+12155551212");
  });

  it("returns patient_missing_phone without dialing", async () => {
    stageSupabaseResponse("patients", "select", {
      data: { id: PATIENT_ID, phone_e164: null, status: "active" },
    });
    stageSupabaseResponse("episodes", "select", {
      data: { id: EPISODE_ID, patient_id: PATIENT_ID },
    });

    const outcome = await placeOutboundReorderCall({
      orgId: ORG_ID,
      patientId: PATIENT_ID,
      episodeId: EPISODE_ID,
      config: CONFIG,
      actor: systemActor(),
    });

    expect(outcome.status).toBe("patient_missing_phone");
    expect(placeCallMock).not.toHaveBeenCalled();
    expect(logAuditMock).not.toHaveBeenCalled();
  });

  it("audits twilio_error and returns a retryable twilio_api_error outcome", async () => {
    stageSupabaseResponse("patients", "select", {
      data: { id: PATIENT_ID, phone_e164: "+12155551212", status: "active" },
    });
    stageSupabaseResponse("episodes", "select", {
      data: { id: EPISODE_ID, patient_id: PATIENT_ID },
    });
    stageSupabaseResponse("conversations", "insert", {
      data: { id: CONVERSATION_ID },
    });
    const { TwilioApiError } = await import("@workspace/resupply-telecom");
    placeCallMock.mockRejectedValue(
      new TwilioApiError("rejected by upstream", 400, 21211),
    );

    const outcome = await placeOutboundReorderCall({
      orgId: ORG_ID,
      patientId: PATIENT_ID,
      episodeId: EPISODE_ID,
      config: CONFIG,
      actor: systemActor(),
    });

    expect(outcome).toMatchObject({
      status: "twilio_api_error",
      conversationId: CONVERSATION_ID,
      twilioStatus: 400,
    });
    expect(logAuditMock).toHaveBeenCalledTimes(1);
    expect(logAuditMock.mock.calls[0][0].metadata.status).toBe("twilio_error");
  });
});
