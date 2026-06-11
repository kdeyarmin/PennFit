import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { TwilioApiError, TwilioConfigError } from "./client";
import { createTwilioNtsClient, type RawTwilioNtsSdk } from "./nts";

const ENV_KEYS = ["TWILIO_ACCOUNT_SID", "TWILIO_AUTH_TOKEN"] as const;

describe("createTwilioNtsClient", () => {
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

  it("throws TwilioConfigError when credentials are missing", () => {
    expect(() => createTwilioNtsClient()).toThrow(TwilioConfigError);
    process.env.TWILIO_ACCOUNT_SID = "ACxxxx";
    expect(() => createTwilioNtsClient()).toThrow(TwilioConfigError);
  });

  it("normalizes the SDK's mixed url/urls shapes and parses ttl", async () => {
    const create = vi.fn().mockResolvedValue({
      ttl: "86400",
      iceServers: [
        {
          url: "stun:global.stun.twilio.com:3478",
          urls: "stun:global.stun.twilio.com:3478",
        },
        {
          urls: ["turn:global.turn.twilio.com:3478?transport=udp"],
          username: "u1",
          credential: "c1",
        },
        { username: "orphan-no-urls", credential: "x" },
      ],
    });
    const sdk: RawTwilioNtsSdk = { tokens: { create } };
    const client = createTwilioNtsClient({
      accountSid: "ACxxxx",
      authToken: "tok",
      sdkFactory: () => sdk,
    });
    const result = await client.createIceToken(3600);
    expect(create).toHaveBeenCalledWith({ ttl: 3600 });
    expect(result.ttlSeconds).toBe(86400);
    expect(result.iceServers).toEqual([
      { urls: ["stun:global.stun.twilio.com:3478"] },
      {
        urls: ["turn:global.turn.twilio.com:3478?transport=udp"],
        username: "u1",
        credential: "c1",
      },
    ]);
  });

  it("falls back to the requested ttl when the response ttl is unparseable", async () => {
    const sdk: RawTwilioNtsSdk = {
      tokens: { create: vi.fn().mockResolvedValue({ iceServers: [] }) },
    };
    const client = createTwilioNtsClient({
      accountSid: "ACxxxx",
      authToken: "tok",
      sdkFactory: () => sdk,
    });
    const result = await client.createIceToken(1234);
    expect(result.ttlSeconds).toBe(1234);
  });

  it("wraps SDK failures in TwilioApiError", async () => {
    const sdk: RawTwilioNtsSdk = {
      tokens: {
        create: vi
          .fn()
          .mockRejectedValue(Object.assign(new Error("boom"), { status: 503 })),
      },
    };
    const client = createTwilioNtsClient({
      accountSid: "ACxxxx",
      authToken: "tok",
      sdkFactory: () => sdk,
    });
    await expect(client.createIceToken()).rejects.toBeInstanceOf(
      TwilioApiError,
    );
  });
});
