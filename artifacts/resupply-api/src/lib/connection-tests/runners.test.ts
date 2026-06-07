// Unit tests for the connection-test runners. Every vendor dependency
// is injected, so these run with no network and no module mocking.

import { describe, it, expect, vi } from "vitest";

import type { AnthropicClient } from "../llm-provider";
import {
  computeConnectionTestStatus,
  defaultConnectionTestDeps,
  runChatTest,
  runEmailTest,
  runSmsTest,
  runVoiceTest,
  type ConnectionTestDeps,
} from "./runners";
import { EmailApiError } from "@workspace/resupply-email";
import { TwilioApiError } from "@workspace/resupply-telecom";

function makeDeps(over: Partial<ConnectionTestDeps> = {}): ConnectionTestDeps {
  return { ...defaultConnectionTestDeps, ...over };
}

const VOICE_BASE = {
  RESUPPLY_VOICE_PUBLIC_BASE_URL: "https://pennfit.example.com",
};

describe("computeConnectionTestStatus", () => {
  it("reports each channel unconfigured on an empty env", () => {
    const s = computeConnectionTestStatus({});
    expect(s.email.configured).toBe(false);
    expect(s.sms.configured).toBe(false);
    expect(s.voice.configured).toBe(false);
    expect(s.chat).toEqual({ configured: false, provider: "offline" });
  });

  it("reports configured channels and the chat provider", () => {
    const s = computeConnectionTestStatus({
      SENDGRID_API_KEY: "SG.x",
      SENDGRID_FROM_EMAIL: "info@pennpaps.com",
      TWILIO_ACCOUNT_SID: "AC1",
      TWILIO_AUTH_TOKEN: "tok",
      TWILIO_MESSAGING_SERVICE_SID: "MG1",
      TWILIO_PHONE_NUMBER: "+12155550000",
      ...VOICE_BASE,
      ANTHROPIC_API_KEY: "sk-ant-x",
    });
    expect(s.email.configured).toBe(true);
    expect(s.sms.configured).toBe(true);
    expect(s.voice.configured).toBe(true);
    expect(s.chat).toEqual({ configured: true, provider: "anthropic" });
  });

  it("treats email as configured with only the API key (From is a fixed default)", () => {
    // The From address defaults to info@pennpaps.com in code, so the API
    // key alone is enough to mark email configured.
    const status = computeConnectionTestStatus({ SENDGRID_API_KEY: "SG.x" });
    expect(status.email.configured).toBe(true);
  });

  it("voice needs a from-number AND a public base url (not just SMS routing)", () => {
    const base = {
      TWILIO_ACCOUNT_SID: "AC1",
      TWILIO_AUTH_TOKEN: "tok",
      TWILIO_MESSAGING_SERVICE_SID: "MG1",
    };
    // SMS-configured (messaging service) but no from-number / base url.
    expect(computeConnectionTestStatus(base).sms.configured).toBe(true);
    expect(computeConnectionTestStatus(base).voice.configured).toBe(false);
    // Add a from-number but still no public base url.
    expect(
      computeConnectionTestStatus({
        ...base,
        TWILIO_PHONE_NUMBER: "+12155550000",
      }).voice.configured,
    ).toBe(false);
  });
});

describe("runEmailTest", () => {
  const cfg = {
    SENDGRID_API_KEY: "SG.x",
    SENDGRID_FROM_EMAIL: "info@pennpaps.com",
  };

  it("returns not_configured when SendGrid env is missing", async () => {
    const r = await runEmailTest({}, { to: "a@b.com" }, makeDeps());
    expect(r).toMatchObject({
      ok: false,
      channel: "email",
      code: "not_configured",
    });
  });

  it("sends and returns the messageId on success", async () => {
    const sendEmail = vi.fn().mockResolvedValue({ messageId: "msg_123" });
    const deps = makeDeps({
      createSendgridClient: vi.fn().mockReturnValue({ sendEmail }),
    });
    const r = await runEmailTest(cfg, { to: "ops@pennpaps.com" }, deps);
    expect(r.ok).toBe(true);
    expect(r).toMatchObject({
      channel: "email",
      detail: { messageId: "msg_123", from: "info@pennpaps.com" },
    });
    expect(sendEmail).toHaveBeenCalledOnce();
    // The test email must carry no PHI and a fixed subject.
    expect(sendEmail.mock.calls[0][0]).toMatchObject({
      to: "ops@pennpaps.com",
      subject: "PennFit connection test",
    });
  });

  it("is configured with only SENDGRID_API_KEY and reports the default From", async () => {
    const sendEmail = vi.fn().mockResolvedValue({ messageId: "msg_def" });
    const deps = makeDeps({
      createSendgridClient: vi.fn().mockReturnValue({ sendEmail }),
    });
    const r = await runEmailTest(
      { SENDGRID_API_KEY: "SG.x" },
      { to: "ops@pennpaps.com" },
      deps,
    );
    expect(r.ok).toBe(true);
    expect(r).toMatchObject({
      channel: "email",
      detail: { messageId: "msg_def", from: "info@pennpaps.com" },
    });
  });

  it("maps an EmailApiError to upstream_error with status", async () => {
    const deps = makeDeps({
      createSendgridClient: vi.fn().mockReturnValue({
        sendEmail: vi
          .fn()
          .mockRejectedValue(
            new EmailApiError("Sender Identity not verified", 403),
          ),
      }),
    });
    const r = await runEmailTest(cfg, { to: "a@b.com" }, deps);
    expect(r).toMatchObject({
      ok: false,
      channel: "email",
      code: "upstream_error",
      upstream: { status: 403 },
    });
  });
});

describe("runSmsTest", () => {
  const cfg = {
    TWILIO_ACCOUNT_SID: "AC1",
    TWILIO_AUTH_TOKEN: "tok",
    TWILIO_PHONE_NUMBER: "+12155550000",
  };

  it("returns not_configured when Twilio env is missing", async () => {
    const r = await runSmsTest({}, { to: "+12155551212" }, makeDeps());
    expect(r).toMatchObject({
      ok: false,
      channel: "sms",
      code: "not_configured",
    });
  });

  it("sends and returns the messageSid on success", async () => {
    const sendSms = vi.fn().mockResolvedValue({ messageSid: "SM_1" });
    const deps = makeDeps({
      createTwilioSmsClient: vi.fn().mockReturnValue({ sendSms }),
    });
    const r = await runSmsTest(cfg, { to: "+12155551212" }, deps);
    expect(r).toMatchObject({
      ok: true,
      channel: "sms",
      detail: { messageSid: "SM_1" },
    });
    expect(sendSms.mock.calls[0][0]).toMatchObject({ to: "+12155551212" });
  });

  it("maps a TwilioApiError to upstream_error with status + code", async () => {
    const deps = makeDeps({
      createTwilioSmsClient: vi.fn().mockReturnValue({
        sendSms: vi
          .fn()
          .mockRejectedValue(new TwilioApiError("bad number", 400, 21211)),
      }),
    });
    const r = await runSmsTest(cfg, { to: "+12155551212" }, deps);
    expect(r).toMatchObject({
      ok: false,
      channel: "sms",
      code: "upstream_error",
      upstream: { status: 400, code: 21211 },
    });
  });
});

describe("runVoiceTest", () => {
  const cfg = {
    TWILIO_ACCOUNT_SID: "AC1",
    TWILIO_AUTH_TOKEN: "tok",
    TWILIO_PHONE_NUMBER: "+12155550000",
    ...VOICE_BASE,
  };

  it("returns not_configured without a public base url", async () => {
    const noBase = { ...cfg, RESUPPLY_VOICE_PUBLIC_BASE_URL: "" };
    const r = await runVoiceTest(noBase, { to: "+12155551212" }, makeDeps());
    expect(r).toMatchObject({
      ok: false,
      channel: "voice",
      code: "not_configured",
    });
  });

  it("places a call pointing at the signed test-twiml route", async () => {
    const placeCall = vi.fn().mockResolvedValue({ sid: "CA_1" });
    const deps = makeDeps({
      createTwilioVoiceClient: vi.fn().mockReturnValue({ placeCall }),
    });
    const r = await runVoiceTest(cfg, { to: "+12155551212" }, deps);
    expect(r).toMatchObject({
      ok: true,
      channel: "voice",
      detail: { callSid: "CA_1" },
    });
    expect(placeCall.mock.calls[0][0]).toMatchObject({
      to: "+12155551212",
      from: "+12155550000",
      url: "https://pennfit.example.com/resupply-api/voice/connection-test-twiml",
    });
  });
});

describe("runChatTest", () => {
  it("returns not_configured when no provider key is set", async () => {
    const r = await runChatTest({}, makeDeps());
    expect(r).toMatchObject({
      ok: false,
      channel: "chat",
      code: "not_configured",
    });
  });

  it("pings Claude when ANTHROPIC_API_KEY is set", async () => {
    const fakeClient: AnthropicClient = {
      send: vi.fn().mockResolvedValue({
        ok: true,
        latencyMs: 12,
        cacheHitTokens: 0,
        response: {
          id: "msg_1",
          type: "message",
          role: "assistant",
          model: "claude-haiku-4-5-20251001",
          content: [{ type: "text", text: "OK" }],
          stop_reason: "end_turn",
          usage: { input_tokens: 5, output_tokens: 1 },
        },
      }),
      stream: vi.fn(),
    };
    const deps = makeDeps({
      getAnthropicClient: vi.fn().mockReturnValue(fakeClient),
    });
    const r = await runChatTest({ ANTHROPIC_API_KEY: "sk-ant-x" }, deps);
    expect(r).toMatchObject({
      ok: true,
      channel: "chat",
      detail: { provider: "anthropic", reply: "OK" },
    });
  });

  it("pings OpenAI when only OPENAI_API_KEY is set", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          model: "gpt-4o-mini",
          choices: [{ message: { content: "OK" } }],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );
    const deps = makeDeps({ fetchImpl: fetchImpl as unknown as typeof fetch });
    const r = await runChatTest({ OPENAI_API_KEY: "sk-openai-x" }, deps);
    expect(r).toMatchObject({
      ok: true,
      channel: "chat",
      detail: { provider: "openai", reply: "OK" },
    });
    // Never send the key anywhere but the Authorization header.
    const init = fetchImpl.mock.calls[0][1] as RequestInit;
    expect((init.headers as Record<string, string>).Authorization).toBe(
      "Bearer sk-openai-x",
    );
  });

  it("maps an OpenAI non-2xx to upstream_error", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({ error: { message: "Incorrect API key" } }),
        {
          status: 401,
        },
      ),
    );
    const deps = makeDeps({ fetchImpl: fetchImpl as unknown as typeof fetch });
    const r = await runChatTest({ OPENAI_API_KEY: "bad" }, deps);
    expect(r).toMatchObject({
      ok: false,
      channel: "chat",
      code: "upstream_error",
      message: "Incorrect API key",
      upstream: { status: 401 },
    });
  });
});
