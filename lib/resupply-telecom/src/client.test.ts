import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  TwilioApiError,
  TwilioConfigError,
  createTwilioClient,
  type RawTwilioSdk,
} from "./client";

// We never want to actually hit api.twilio.com in unit tests. The
// `sdkFactory` seam in `createTwilioClient` lets us inject a fake
// that records calls and lets us assert on the exact options
// shape we pass to the SDK.

describe("createTwilioClient — config", () => {
  beforeEach(() => {
    delete process.env.TWILIO_ACCOUNT_SID;
    delete process.env.TWILIO_AUTH_TOKEN;
  });
  afterEach(() => {
    delete process.env.TWILIO_ACCOUNT_SID;
    delete process.env.TWILIO_AUTH_TOKEN;
  });

  it("throws TwilioConfigError when TWILIO_ACCOUNT_SID is unset", () => {
    expect(() => createTwilioClient()).toThrowError(TwilioConfigError);
  });

  it("throws TwilioConfigError when only TWILIO_AUTH_TOKEN is missing", () => {
    process.env.TWILIO_ACCOUNT_SID = "ACxxxx";
    expect(() => createTwilioClient()).toThrowError(TwilioConfigError);
  });

  it("reads creds from env when options are not supplied", () => {
    process.env.TWILIO_ACCOUNT_SID = "ACenv";
    process.env.TWILIO_AUTH_TOKEN = "tok-env";
    const seen: { sid: string; tok: string } = { sid: "", tok: "" };
    const sdk: RawTwilioSdk = {
      calls: { create: vi.fn(async () => ({ sid: "CAxxx" })) },
    };
    createTwilioClient({
      sdkFactory: (sid, tok) => {
        seen.sid = sid;
        seen.tok = tok;
        return sdk;
      },
    });
    expect(seen.sid).toBe("ACenv");
    expect(seen.tok).toBe("tok-env");
  });

  it("explicit options override env vars", () => {
    process.env.TWILIO_ACCOUNT_SID = "ACenv";
    process.env.TWILIO_AUTH_TOKEN = "tok-env";
    const seen: { sid: string; tok: string } = { sid: "", tok: "" };
    const sdk: RawTwilioSdk = {
      calls: { create: vi.fn(async () => ({ sid: "CAxxx" })) },
    };
    createTwilioClient({
      accountSid: "AOoverride",
      authToken: "tok-override",
      sdkFactory: (sid, tok) => {
        seen.sid = sid;
        seen.tok = tok;
        return sdk;
      },
    });
    expect(seen).toEqual({ sid: "AOoverride", tok: "tok-override" });
  });
});

describe("createTwilioClient — placeCall", () => {
  it("forwards the call options Twilio expects (record off, timeLimit defaulted, lifecycle events subscribed)", async () => {
    const create = vi
      .fn<RawTwilioSdk["calls"]["create"]>()
      .mockResolvedValue({ sid: "CAabc" });
    const sdk: RawTwilioSdk = { calls: { create } };
    const client = createTwilioClient({
      accountSid: "ACxxxx",
      authToken: "tok",
      sdkFactory: () => sdk,
    });
    const result = await client.placeCall({
      to: "+12155551212",
      from: "+12158675309",
      url: "https://example.com/resupply-api/voice/twiml-connect?conversationId=cid",
      statusCallbackUrl: "https://example.com/resupply-api/voice/status-callback",
    });
    expect(result.sid).toBe("CAabc");
    expect(create).toHaveBeenCalledTimes(1);
    const opts = create.mock.calls[0]?.[0];
    if (!opts) throw new Error("expected create to receive an args object");
    expect(opts.to).toBe("+12155551212");
    expect(opts.from).toBe("+12158675309");
    expect(opts.method).toBe("POST");
    expect(opts.statusCallbackMethod).toBe("POST");
    expect(opts.record).toBe(false);
    expect(opts.timeLimit).toBe(600);
    expect(opts.statusCallbackEvent).toEqual([
      "initiated",
      "ringing",
      "answered",
      "completed",
    ]);
  });

  it("respects an explicit timeLimit override", async () => {
    const create = vi
      .fn<RawTwilioSdk["calls"]["create"]>()
      .mockResolvedValue({ sid: "CA1" });
    const sdk: RawTwilioSdk = { calls: { create } };
    const client = createTwilioClient({
      accountSid: "ACxxxx",
      authToken: "tok",
      sdkFactory: () => sdk,
    });
    await client.placeCall({
      to: "+1",
      from: "+1",
      url: "https://x/y",
      statusCallbackUrl: "https://x/z",
      timeLimit: 120,
    });
    const opts = create.mock.calls[0]?.[0];
    if (!opts) throw new Error("expected create to receive an args object");
    expect(opts.timeLimit).toBe(120);
  });

  it("translates a Twilio-side error into TwilioApiError with status+code preserved", async () => {
    const sdk: RawTwilioSdk = {
      calls: {
        create: vi.fn(async () => {
          throw Object.assign(new Error("call failed"), {
            status: 400,
            code: 21205,
          });
        }),
      },
    };
    const client = createTwilioClient({
      accountSid: "ACxxxx",
      authToken: "tok",
      sdkFactory: () => sdk,
    });
    let caught: TwilioApiError | undefined;
    try {
      await client.placeCall({
        to: "+1",
        from: "+1",
        url: "https://x/y",
        statusCallbackUrl: "https://x/z",
      });
    } catch (e) {
      caught = e as TwilioApiError;
    }
    expect(caught).toBeInstanceOf(TwilioApiError);
    expect(caught?.status).toBe(400);
    expect(caught?.code).toBe(21205);
  });
});
