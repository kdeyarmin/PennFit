import { describe, it, expect, vi } from "vitest";

import {
  createTwilioLookupClient,
  mapTwilioLineType,
  type TwilioLookupHttpResponse,
} from "./lookup";
import { TwilioConfigError } from "./client";

describe("mapTwilioLineType", () => {
  it("maps mobile and landline directly", () => {
    expect(mapTwilioLineType("mobile")).toBe("mobile");
    expect(mapTwilioLineType("landline")).toBe("landline");
  });
  it("maps both VoIP flavours to voip", () => {
    expect(mapTwilioLineType("fixedVoip")).toBe("voip");
    expect(mapTwilioLineType("nonFixedVoip")).toBe("voip");
  });
  it("maps null / tollFree / anything else to unknown", () => {
    expect(mapTwilioLineType(null)).toBe("unknown");
    expect(mapTwilioLineType(undefined)).toBe("unknown");
    expect(mapTwilioLineType("tollFree")).toBe("unknown");
    expect(mapTwilioLineType("voicemail")).toBe("unknown");
  });
});

describe("createTwilioLookupClient", () => {
  it("throws when credentials are missing", () => {
    // Hermetic: createTwilioLookupClient falls back to process.env, and
    // some environments (e.g. CI runners with real secrets injected) carry
    // live TWILIO_* values. Clear them so this exercises the missing-cred
    // path regardless of ambient env.
    vi.stubEnv("TWILIO_ACCOUNT_SID", "");
    vi.stubEnv("TWILIO_AUTH_TOKEN", "");
    try {
      expect(() => createTwilioLookupClient({ authToken: "t" })).toThrow(
        TwilioConfigError,
      );
      expect(() => createTwilioLookupClient({ accountSid: "AC" })).toThrow(
        TwilioConfigError,
      );
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("classifies a mobile number from a 200 response", async () => {
    const httpGet = vi.fn(
      async (
        _url: string,
        _authorization: string,
      ): Promise<TwilioLookupHttpResponse> => ({
        status: 200,
        json: { line_type_intelligence: { type: "mobile" } },
      }),
    );
    const client = createTwilioLookupClient({
      accountSid: "AC",
      authToken: "tok",
      httpGet,
    });
    const r = await client.lookupLineType("+12155551212");
    expect(r.lineType).toBe("mobile");
    expect(r.rawType).toBe("mobile");
    // URL targets Lookup v2 with the line_type_intelligence field + Basic auth.
    const [url, authorization] = httpGet.mock.calls[0]!;
    expect(url).toContain("/v2/PhoneNumbers/");
    expect(url).toContain("line_type_intelligence");
    expect(url).toContain(encodeURIComponent("+12155551212"));
    expect(authorization.startsWith("Basic ")).toBe(true);
  });

  it("classifies a landline", async () => {
    const client = createTwilioLookupClient({
      accountSid: "AC",
      authToken: "tok",
      httpGet: async () => ({
        status: 200,
        json: { line_type_intelligence: { type: "landline" } },
      }),
    });
    expect((await client.lookupLineType("+12155551212")).lineType).toBe(
      "landline",
    );
  });

  it("returns unknown (never throws) on a non-2xx response", async () => {
    const client = createTwilioLookupClient({
      accountSid: "AC",
      authToken: "tok",
      httpGet: async () => ({ status: 404, json: null }),
    });
    expect((await client.lookupLineType("+12155551212")).lineType).toBe(
      "unknown",
    );
  });

  it("returns unknown when the transport throws", async () => {
    const client = createTwilioLookupClient({
      accountSid: "AC",
      authToken: "tok",
      httpGet: async () => {
        throw new Error("network down");
      },
    });
    expect((await client.lookupLineType("+12155551212")).lineType).toBe(
      "unknown",
    );
  });
});
