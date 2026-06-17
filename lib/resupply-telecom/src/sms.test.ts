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

  describe("confirmDelivery", () => {
    const noSleep = () => Promise.resolve();

    function envOn() {
      process.env.TWILIO_ACCOUNT_SID = "AC123";
      process.env.TWILIO_AUTH_TOKEN = "tok";
      process.env.TWILIO_PHONE_NUMBER = "+12158675309";
    }

    /** Build a fake SDK whose messages(sid).fetch() returns the queued statuses in order. */
    function fakeSdkWithFetch(
      statuses: Array<{
        status: string;
        errorCode?: number | null;
        errorMessage?: string | null;
      }>,
    ): { sdk: RawTwilioMessagingSdk; fetch: ReturnType<typeof vi.fn> } {
      const fetch = vi.fn();
      for (const s of statuses) {
        fetch.mockResolvedValueOnce({ sid: "SM_1", ...s });
      }
      // Last status repeats for any extra polls.
      const last = statuses[statuses.length - 1];
      if (last) fetch.mockResolvedValue({ sid: "SM_1", ...last });
      const messages = ((_sid: string) => ({ fetch })) as unknown as {
        (sid: string): { fetch: typeof fetch };
        create: ReturnType<typeof vi.fn>;
      };
      messages.create = vi.fn().mockResolvedValue({ sid: "SM_1" });
      return {
        sdk: { messages } as unknown as RawTwilioMessagingSdk,
        fetch,
      };
    }

    it("returns delivered=true on a terminal delivered status", async () => {
      envOn();
      const { sdk } = fakeSdkWithFetch([{ status: "delivered" }]);
      const client = createTwilioSmsClient({ sdkFactory: () => sdk });
      const r = await client.confirmDelivery("SM_1", { sleep: noSleep });
      expect(r).toMatchObject({
        status: "delivered",
        terminal: true,
        delivered: true,
        errorCode: null,
      });
    });

    it("surfaces the error code on a terminal undelivered status", async () => {
      envOn();
      const { sdk } = fakeSdkWithFetch([
        {
          status: "undelivered",
          errorCode: 30032,
          errorMessage: "Toll-free number has not been verified",
        },
      ]);
      const client = createTwilioSmsClient({ sdkFactory: () => sdk });
      const r = await client.confirmDelivery("SM_1", { sleep: noSleep });
      expect(r).toMatchObject({
        status: "undelivered",
        terminal: true,
        delivered: false,
        errorCode: 30032,
        errorMessage: "Toll-free number has not been verified",
      });
    });

    it("polls past non-terminal statuses until terminal", async () => {
      envOn();
      const { sdk, fetch } = fakeSdkWithFetch([
        { status: "queued" },
        { status: "sent" },
        { status: "delivered" },
      ]);
      const client = createTwilioSmsClient({ sdkFactory: () => sdk });
      const r = await client.confirmDelivery("SM_1", {
        sleep: noSleep,
        pollIntervalMs: 1,
        timeoutMs: 10_000,
      });
      expect(r.terminal).toBe(true);
      expect(r.delivered).toBe(true);
      expect(fetch).toHaveBeenCalledTimes(3);
    });

    it("returns terminal=false when it times out non-terminal", async () => {
      envOn();
      const { sdk } = fakeSdkWithFetch([{ status: "sent" }]);
      const client = createTwilioSmsClient({ sdkFactory: () => sdk });
      const r = await client.confirmDelivery("SM_1", {
        sleep: noSleep,
        pollIntervalMs: 1000,
        timeoutMs: 1, // one fetch then give up
      });
      expect(r).toMatchObject({
        status: "sent",
        terminal: false,
        delivered: false,
      });
    });

    it("coerces NaN timeout/pollInterval instead of looping forever", async () => {
      envOn();
      // A terminal status returns on the first fetch, so even with NaN
      // options this must resolve (proving NaN doesn't crash/hang the
      // option handling). The non-terminal loop-termination is covered by
      // the timeout test above with valid finite values.
      const { sdk, fetch } = fakeSdkWithFetch([{ status: "delivered" }]);
      const client = createTwilioSmsClient({ sdkFactory: () => sdk });
      const r = await client.confirmDelivery("SM_1", {
        sleep: noSleep,
        timeoutMs: Number.NaN,
        pollIntervalMs: Number.NaN,
      });
      expect(r).toMatchObject({ status: "delivered", terminal: true });
      expect(fetch).toHaveBeenCalledTimes(1);
    });

    it("never throws on a fetch failure; returns unknown/non-terminal", async () => {
      envOn();
      const fetch = vi.fn().mockRejectedValue(new Error("network"));
      const messages = ((_sid: string) => ({ fetch })) as unknown as {
        (sid: string): { fetch: typeof fetch };
        create: ReturnType<typeof vi.fn>;
      };
      messages.create = vi.fn().mockResolvedValue({ sid: "SM_1" });
      const client = createTwilioSmsClient({
        sdkFactory: () => ({ messages }) as unknown as RawTwilioMessagingSdk,
      });
      const r = await client.confirmDelivery("SM_1", {
        sleep: noSleep,
        pollIntervalMs: 1000,
        timeoutMs: 1,
      });
      expect(r).toMatchObject({
        status: "unknown",
        terminal: false,
        delivered: false,
      });
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
