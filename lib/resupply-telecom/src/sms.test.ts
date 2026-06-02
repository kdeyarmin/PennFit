import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { TwilioApiError, TwilioConfigError } from "./client";
import {
  createTwilioSmsClient,
  parseInboundSmsParams,
  parseSmsStatusCallbackParams,
  type RawTwilioMessagingSdk,
} from "./sms";

const ENV_KEYS = [
  "TWILIO_ACCOUNT_SID",
  "TWILIO_AUTH_TOKEN",
  "TWILIO_PHONE_NUMBER",
  "TWILIO_MESSAGING_SERVICE_SID",
] as const;

function fakeSdk(create: ReturnType<typeof vi.fn>): RawTwilioMessagingSdk {
  return {
    messages: { create },
  } as unknown as RawTwilioMessagingSdk;
}

describe("createTwilioSmsClient", () => {
  const saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const k of ENV_KEYS) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
  });

  afterEach(() => {
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  it("throws TwilioConfigError when TWILIO_ACCOUNT_SID is unset", () => {
    expect(() => createTwilioSmsClient()).toThrow(TwilioConfigError);
    expect(() => createTwilioSmsClient()).toThrow(/TWILIO_ACCOUNT_SID/);
  });

  it("throws TwilioConfigError when TWILIO_AUTH_TOKEN is unset", () => {
    process.env.TWILIO_ACCOUNT_SID = "AC123";
    expect(() => createTwilioSmsClient()).toThrow(/TWILIO_AUTH_TOKEN/);
  });

  it("throws TwilioConfigError when neither MSID nor PHONE_NUMBER is set", () => {
    process.env.TWILIO_ACCOUNT_SID = "AC123";
    process.env.TWILIO_AUTH_TOKEN = "tok";
    expect(() => createTwilioSmsClient()).toThrow(
      /Neither TWILIO_MESSAGING_SERVICE_SID nor TWILIO_PHONE_NUMBER/,
    );
  });

  it("constructs successfully with phone-number routing", () => {
    process.env.TWILIO_ACCOUNT_SID = "AC123";
    process.env.TWILIO_AUTH_TOKEN = "tok";
    process.env.TWILIO_PHONE_NUMBER = "+12158675309";
    const create = vi.fn().mockResolvedValue({ sid: "SMabc" });
    const client = createTwilioSmsClient({
      sdkFactory: () => fakeSdk(create),
    });
    expect(client).toBeDefined();
  });

  it("sends with from-number when only TWILIO_PHONE_NUMBER is set", async () => {
    process.env.TWILIO_ACCOUNT_SID = "AC123";
    process.env.TWILIO_AUTH_TOKEN = "tok";
    process.env.TWILIO_PHONE_NUMBER = "+12158675309";
    const create = vi.fn().mockResolvedValue({ sid: "SMabc" });
    const client = createTwilioSmsClient({
      sdkFactory: () => fakeSdk(create),
    });

    const result = await client.sendSms({
      to: "+12155551212",
      body: "hi",
    });

    expect(result).toEqual({ messageSid: "SMabc" });
    expect(create).toHaveBeenCalledWith({
      to: "+12155551212",
      from: "+12158675309",
      body: "hi",
    });
  });

  it("prefers messagingServiceSid over from-number", async () => {
    process.env.TWILIO_ACCOUNT_SID = "AC123";
    process.env.TWILIO_AUTH_TOKEN = "tok";
    process.env.TWILIO_PHONE_NUMBER = "+12158675309";
    process.env.TWILIO_MESSAGING_SERVICE_SID = "MGabc";
    const create = vi.fn().mockResolvedValue({ sid: "SMxyz" });
    const client = createTwilioSmsClient({
      sdkFactory: () => fakeSdk(create),
    });

    await client.sendSms({ to: "+12155551212", body: "hi" });

    expect(create).toHaveBeenCalledWith({
      to: "+12155551212",
      messagingServiceSid: "MGabc",
      body: "hi",
    });
  });

  it("includes statusCallbackUrl when provided", async () => {
    process.env.TWILIO_ACCOUNT_SID = "AC123";
    process.env.TWILIO_AUTH_TOKEN = "tok";
    process.env.TWILIO_PHONE_NUMBER = "+12158675309";
    const create = vi.fn().mockResolvedValue({ sid: "SMabc" });
    const client = createTwilioSmsClient({
      sdkFactory: () => fakeSdk(create),
    });

    await client.sendSms({
      to: "+12155551212",
      body: "hi",
      statusCallbackUrl: "https://example.com/cb",
    });

    expect(create).toHaveBeenCalledWith({
      to: "+12155551212",
      from: "+12158675309",
      body: "hi",
      statusCallback: "https://example.com/cb",
    });
  });

  it("propagates Twilio errors as TwilioApiError with status/code", async () => {
    process.env.TWILIO_ACCOUNT_SID = "AC123";
    process.env.TWILIO_AUTH_TOKEN = "tok";
    process.env.TWILIO_PHONE_NUMBER = "+12158675309";
    const create = vi.fn().mockRejectedValue({
      status: 400,
      code: 21610,
      message: "blocked by recipient",
    });
    const client = createTwilioSmsClient({
      sdkFactory: () => fakeSdk(create),
    });

    await expect(
      client.sendSms({ to: "+12155551212", body: "hi" }),
    ).rejects.toMatchObject({
      name: "TwilioApiError",
      message: "blocked by recipient",
      status: 400,
      code: 21610,
    });
    // Sanity: the rejected value really is an instance of our class.
    await expect(
      client.sendSms({ to: "+12155551212", body: "hi" }),
    ).rejects.toBeInstanceOf(TwilioApiError);
  });

  describe("retry on transient Twilio failures", () => {
    const noSleep = () => Promise.resolve();

    function envOn() {
      process.env.TWILIO_ACCOUNT_SID = "AC123";
      process.env.TWILIO_AUTH_TOKEN = "tok";
      process.env.TWILIO_PHONE_NUMBER = "+12158675309";
    }

    it("retries a 503 then succeeds", async () => {
      envOn();
      const create = vi
        .fn()
        .mockRejectedValueOnce({ status: 503, message: "Service Unavailable" })
        .mockResolvedValue({ sid: "SMok" });
      const client = createTwilioSmsClient({
        sdkFactory: () => fakeSdk(create),
        retry: { sleep: noSleep },
      });

      await expect(
        client.sendSms({ to: "+12155551212", body: "hi" }),
      ).resolves.toEqual({ messageSid: "SMok" });
      expect(create).toHaveBeenCalledTimes(2);
    });

    it("retries a 429 then succeeds", async () => {
      envOn();
      const create = vi
        .fn()
        .mockRejectedValueOnce({ status: 429, message: "Too Many Requests" })
        .mockResolvedValue({ sid: "SMok" });
      const client = createTwilioSmsClient({
        sdkFactory: () => fakeSdk(create),
        retry: { sleep: noSleep },
      });

      await client.sendSms({ to: "+12155551212", body: "hi" });
      expect(create).toHaveBeenCalledTimes(2);
    });

    it("retries a network error then succeeds", async () => {
      envOn();
      const create = vi
        .fn()
        .mockRejectedValueOnce({ code: "ETIMEDOUT", message: "timeout" })
        .mockResolvedValue({ sid: "SMok" });
      const client = createTwilioSmsClient({
        sdkFactory: () => fakeSdk(create),
        retry: { sleep: noSleep },
      });

      await client.sendSms({ to: "+12155551212", body: "hi" });
      expect(create).toHaveBeenCalledTimes(2);
    });

    it("does NOT retry a terminal 400 (blocked recipient)", async () => {
      envOn();
      const create = vi.fn().mockRejectedValue({
        status: 400,
        code: 21610,
        message: "blocked by recipient",
      });
      const client = createTwilioSmsClient({
        sdkFactory: () => fakeSdk(create),
        retry: { sleep: noSleep },
      });

      await expect(
        client.sendSms({ to: "+12155551212", body: "hi" }),
      ).rejects.toMatchObject({
        name: "TwilioApiError",
        status: 400,
        code: 21610,
      });
      expect(create).toHaveBeenCalledTimes(1);
    });

    it("exhausts attempts on a persistent 500 and marks retryable", async () => {
      envOn();
      const create = vi
        .fn()
        .mockRejectedValue({ status: 500, message: "Internal Server Error" });
      const client = createTwilioSmsClient({
        sdkFactory: () => fakeSdk(create),
        retry: { maxAttempts: 3, sleep: noSleep },
      });

      await expect(
        client.sendSms({ to: "+12155551212", body: "hi" }),
      ).rejects.toMatchObject({
        name: "TwilioApiError",
        status: 500,
        retryable: true,
      });
      expect(create).toHaveBeenCalledTimes(3);
    });

    it("maxAttempts:1 disables retry", async () => {
      envOn();
      const create = vi.fn().mockRejectedValue({ status: 503 });
      const client = createTwilioSmsClient({
        sdkFactory: () => fakeSdk(create),
        retry: { maxAttempts: 1, sleep: noSleep },
      });
      await expect(
        client.sendSms({ to: "+12155551212", body: "hi" }),
      ).rejects.toBeInstanceOf(TwilioApiError);
      expect(create).toHaveBeenCalledTimes(1);
    });
  });

  it("respects per-call from override", async () => {
    process.env.TWILIO_ACCOUNT_SID = "AC123";
    process.env.TWILIO_AUTH_TOKEN = "tok";
    process.env.TWILIO_PHONE_NUMBER = "+12158675309";
    const create = vi.fn().mockResolvedValue({ sid: "SMabc" });
    const client = createTwilioSmsClient({
      sdkFactory: () => fakeSdk(create),
    });

    await client.sendSms({
      to: "+12155551212",
      body: "hi",
      from: "+18001234567",
    });

    expect(create).toHaveBeenCalledWith({
      to: "+12155551212",
      from: "+18001234567",
      body: "hi",
    });
  });
});

describe("parseInboundSmsParams", () => {
  it("parses a typical Twilio inbound payload", () => {
    const out = parseInboundSmsParams({
      From: "+12155551212",
      To: "+18001234567",
      Body: "YES",
      MessageSid: "SMabc",
      AccountSid: "AC123",
      NumMedia: "0",
    });
    expect(out.From).toBe("+12155551212");
    expect(out.Body).toBe("YES");
  });

  it("defaults Body to empty string when missing", () => {
    const out = parseInboundSmsParams({
      From: "+12155551212",
      To: "+18001234567",
      MessageSid: "SMabc",
    });
    expect(out.Body).toBe("");
  });

  it("rejects payloads missing From/To/MessageSid", () => {
    expect(() => parseInboundSmsParams({ Body: "hi" })).toThrow();
  });
});

describe("parseSmsStatusCallbackParams", () => {
  it("parses a typical status-callback payload", () => {
    const out = parseSmsStatusCallbackParams({
      MessageSid: "SMabc",
      MessageStatus: "delivered",
      To: "+12155551212",
      From: "+18001234567",
    });
    expect(out.MessageStatus).toBe("delivered");
  });

  it("captures error details on failure events", () => {
    const out = parseSmsStatusCallbackParams({
      MessageSid: "SMabc",
      MessageStatus: "failed",
      ErrorCode: "30003",
      ErrorMessage: "Unreachable destination",
    });
    expect(out.ErrorCode).toBe("30003");
  });
});
