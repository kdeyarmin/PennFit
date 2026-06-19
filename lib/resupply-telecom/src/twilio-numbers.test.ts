// Unit tests for the Twilio number-search + purchase client
// (twilio-numbers.ts) used to PROVISION a tenant's voice / SMS number.
//
// Coverage:
//   * TwilioConfigError when TWILIO_ACCOUNT_SID / TWILIO_AUTH_TOKEN missing
//   * Explicit options override env
//   * search maps capabilities (case-insensitive sms/SMS) + area code
//   * purchase forwards friendlyName + webhook urls
//   * provisionNumber picks a voice+SMS-capable candidate and buys it
//   * provisionNumber throws TwilioApiError when nothing matches

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { TwilioApiError, TwilioConfigError } from "./client";
import {
  createTwilioNumberClient,
  type RawTwilioNumbersSdk,
} from "./twilio-numbers";

const BASE_CREDS = { accountSid: "ACtest", authToken: "tok" };

interface FakeOpts {
  available?: Array<{
    phoneNumber: string;
    friendlyName?: string;
    capabilities?: Record<string, boolean | undefined>;
  }>;
  listError?: unknown;
  createError?: unknown;
}

function makeSdk(opts: FakeOpts = {}) {
  const listSpy = vi.fn(async () => {
    if (opts.listError) throw opts.listError;
    return opts.available ?? [];
  });
  const createSpy = vi.fn(async (args: { phoneNumber: string }) => {
    if (opts.createError) throw opts.createError;
    return { sid: "PN123", phoneNumber: args.phoneNumber };
  });
  const sdk: RawTwilioNumbersSdk = {
    availablePhoneNumbers: () => ({ local: { list: listSpy } }),
    incomingPhoneNumbers: { create: createSpy },
  };
  return { sdk, listSpy, createSpy };
}

describe("createTwilioNumberClient — config validation", () => {
  // The deploy environment may have real Twilio creds set; capture and
  // restore them so deleting them here never leaks into sibling test files.
  const original = {
    sid: process.env.TWILIO_ACCOUNT_SID,
    token: process.env.TWILIO_AUTH_TOKEN,
  };
  beforeEach(() => {
    delete process.env.TWILIO_ACCOUNT_SID;
    delete process.env.TWILIO_AUTH_TOKEN;
  });
  afterEach(() => {
    if (original.sid === undefined) delete process.env.TWILIO_ACCOUNT_SID;
    else process.env.TWILIO_ACCOUNT_SID = original.sid;
    if (original.token === undefined) delete process.env.TWILIO_AUTH_TOKEN;
    else process.env.TWILIO_AUTH_TOKEN = original.token;
  });

  it("throws TwilioConfigError when TWILIO_ACCOUNT_SID is missing", () => {
    expect(() => createTwilioNumberClient()).toThrow(TwilioConfigError);
  });

  it("throws TwilioConfigError when TWILIO_AUTH_TOKEN is missing", () => {
    process.env.TWILIO_ACCOUNT_SID = "ACenv";
    expect(() => createTwilioNumberClient()).toThrow(TwilioConfigError);
  });

  it("reads credentials from env", () => {
    process.env.TWILIO_ACCOUNT_SID = "ACenv";
    process.env.TWILIO_AUTH_TOKEN = "tokenv";
    const { sdk } = makeSdk();
    expect(() =>
      createTwilioNumberClient({ sdkFactory: () => sdk }),
    ).not.toThrow();
  });
});

describe("searchAvailableNumbers", () => {
  it("passes the area code + capability filters and maps results", async () => {
    const { sdk, listSpy } = makeSdk({
      available: [
        {
          phoneNumber: "+12155551212",
          friendlyName: "(215) 555-1212",
          // Upper-case SMS key, like some Twilio API versions.
          capabilities: { voice: true, SMS: true, MMS: false },
        },
      ],
    });
    const client = createTwilioNumberClient({
      ...BASE_CREDS,
      sdkFactory: () => sdk,
    });
    const rows = await client.searchAvailableNumbers({ areaCode: "215" });
    expect(listSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        areaCode: 215,
        voiceEnabled: true,
        smsEnabled: true,
      }),
    );
    expect(rows).toEqual([
      {
        phoneNumber: "+12155551212",
        friendlyName: "(215) 555-1212",
        capabilities: { voice: true, sms: true, mms: false },
      },
    ]);
  });

  it("wraps SDK errors as TwilioApiError", async () => {
    const { sdk } = makeSdk({ listError: { status: 429, message: "rate" } });
    const client = createTwilioNumberClient({
      ...BASE_CREDS,
      sdkFactory: () => sdk,
    });
    await expect(client.searchAvailableNumbers()).rejects.toBeInstanceOf(
      TwilioApiError,
    );
  });
});

describe("purchaseNumber", () => {
  it("forwards friendlyName + webhook urls", async () => {
    const { sdk, createSpy } = makeSdk();
    const client = createTwilioNumberClient({
      ...BASE_CREDS,
      sdkFactory: () => sdk,
    });
    const res = await client.purchaseNumber({
      phoneNumber: "+12155551212",
      friendlyName: "org:acme",
      voiceUrl: "https://app.example/voice",
      smsUrl: "https://app.example/sms",
    });
    expect(res).toEqual({ sid: "PN123", phoneNumber: "+12155551212" });
    expect(createSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        phoneNumber: "+12155551212",
        friendlyName: "org:acme",
        voiceUrl: "https://app.example/voice",
        voiceMethod: "POST",
        smsUrl: "https://app.example/sms",
        smsMethod: "POST",
      }),
    );
  });
});

describe("provisionNumber", () => {
  it("picks a voice+SMS-capable candidate and buys it", async () => {
    const { sdk, createSpy } = makeSdk({
      available: [
        {
          phoneNumber: "+1voiceonly",
          capabilities: { voice: true, sms: false },
        },
        { phoneNumber: "+1both", capabilities: { voice: true, sms: true } },
      ],
    });
    const client = createTwilioNumberClient({
      ...BASE_CREDS,
      sdkFactory: () => sdk,
    });
    const res = await client.provisionNumber({ areaCode: "215" });
    expect(res.phoneNumber).toBe("+1both");
    expect(createSpy).toHaveBeenCalledTimes(1);
  });

  it("throws TwilioApiError when nothing matches", async () => {
    const { sdk } = makeSdk({ available: [] });
    const client = createTwilioNumberClient({
      ...BASE_CREDS,
      sdkFactory: () => sdk,
    });
    await expect(
      client.provisionNumber({ areaCode: "999" }),
    ).rejects.toBeInstanceOf(TwilioApiError);
  });
});
