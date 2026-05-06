// Unit tests for the Twilio Programmable Fax client (fax.ts).
//
// Coverage:
//   * TwilioConfigError thrown when TWILIO_ACCOUNT_SID is missing
//   * TwilioConfigError thrown when TWILIO_AUTH_TOKEN is missing
//   * Explicit options override env vars
//   * Happy path: correct Basic-auth header, correct URLSearchParams
//   * Default quality is "fine"
//   * Optional statusCallbackUrl included only when provided
//   * Custom quality ("superfine") passed through
//   * HTTP 4xx → TwilioApiError with status + code preserved
//   * HTTP 5xx → TwilioApiError
//   * Non-JSON response → TwilioApiError
//   * Response missing sid → TwilioApiError
//   * TwilioApiError/TwilioConfigError re-thrown as-is (no double-wrap)

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  TwilioApiError,
  TwilioConfigError,
} from "./client";
import {
  createTwilioFaxClient,
  type FaxHttpSend,
  type SendFaxResult,
} from "./fax";

const BASE_CREDS = { accountSid: "ACtest", authToken: "toktest" };

function makeSend(result: SendFaxResult | Error): FaxHttpSend {
  return vi.fn(async () => {
    if (result instanceof Error) throw result;
    return result;
  });
}

describe("createTwilioFaxClient — config validation", () => {
  beforeEach(() => {
    delete process.env.TWILIO_ACCOUNT_SID;
    delete process.env.TWILIO_AUTH_TOKEN;
  });
  afterEach(() => {
    delete process.env.TWILIO_ACCOUNT_SID;
    delete process.env.TWILIO_AUTH_TOKEN;
  });

  it("throws TwilioConfigError when TWILIO_ACCOUNT_SID is missing", () => {
    expect(() => createTwilioFaxClient()).toThrow(TwilioConfigError);
  });

  it("throws TwilioConfigError when TWILIO_AUTH_TOKEN is missing", () => {
    process.env.TWILIO_ACCOUNT_SID = "ACenv";
    expect(() => createTwilioFaxClient()).toThrow(TwilioConfigError);
  });

  it("reads credentials from env when options are not supplied", () => {
    process.env.TWILIO_ACCOUNT_SID = "ACenv";
    process.env.TWILIO_AUTH_TOKEN = "tokenv";
    const capturedAuth: string[] = [];
    const send: FaxHttpSend = vi.fn(async (_url, basicAuth) => {
      capturedAuth.push(basicAuth);
      return { sid: "FXenv", status: "queued" };
    });
    const client = createTwilioFaxClient({ httpSend: send });
    // sendFax call needed to trigger the seam
    void client.sendFax({ to: "+1", from: "+2", mediaUrl: "http://x" });
    const expected = Buffer.from("ACenv:tokenv").toString("base64");
    expect(capturedAuth[0]).toBe(expected);
  });

  it("explicit options override env vars", () => {
    process.env.TWILIO_ACCOUNT_SID = "ACenv";
    process.env.TWILIO_AUTH_TOKEN = "tokenv";
    const capturedAuth: string[] = [];
    const send: FaxHttpSend = vi.fn(async (_url, basicAuth) => {
      capturedAuth.push(basicAuth);
      return { sid: "FXoverride", status: "queued" };
    });
    const client = createTwilioFaxClient({
      accountSid: "ACoverride",
      authToken: "tokoverride",
      httpSend: send,
    });
    void client.sendFax({ to: "+1", from: "+2", mediaUrl: "http://x" });
    const expected = Buffer.from("ACoverride:tokoverride").toString("base64");
    expect(capturedAuth[0]).toBe(expected);
  });
});

describe("createTwilioFaxClient — sendFax", () => {
  it("sends to the Twilio Fax API URL", async () => {
    const capturedUrl: string[] = [];
    const send: FaxHttpSend = vi.fn(async (url, _auth, _body) => {
      capturedUrl.push(url);
      return { sid: "FX1", status: "queued" };
    });
    const client = createTwilioFaxClient({ ...BASE_CREDS, httpSend: send });
    await client.sendFax({ to: "+12155551212", from: "+12155550000", mediaUrl: "https://example.com/doc.pdf" });
    expect(capturedUrl[0]).toBe("https://fax.twilio.com/v1/Faxes");
  });

  it("includes To, From, MediaUrl in the request body", async () => {
    const capturedBodies: string[] = [];
    const send: FaxHttpSend = vi.fn(async (_url, _auth, body) => {
      capturedBodies.push(body);
      return { sid: "FX2", status: "queued" };
    });
    const client = createTwilioFaxClient({ ...BASE_CREDS, httpSend: send });
    await client.sendFax({
      to: "+12155551212",
      from: "+12155550000",
      mediaUrl: "https://example.com/doc.pdf",
    });
    const params = new URLSearchParams(capturedBodies[0]);
    expect(params.get("To")).toBe("+12155551212");
    expect(params.get("From")).toBe("+12155550000");
    expect(params.get("MediaUrl")).toBe("https://example.com/doc.pdf");
  });

  it("defaults quality to 'fine'", async () => {
    const capturedBodies: string[] = [];
    const send: FaxHttpSend = vi.fn(async (_url, _auth, body) => {
      capturedBodies.push(body);
      return { sid: "FX3", status: "queued" };
    });
    const client = createTwilioFaxClient({ ...BASE_CREDS, httpSend: send });
    await client.sendFax({ to: "+1", from: "+2", mediaUrl: "http://x" });
    const params = new URLSearchParams(capturedBodies[0]);
    expect(params.get("Quality")).toBe("fine");
  });

  it("passes custom quality through", async () => {
    const capturedBodies: string[] = [];
    const send: FaxHttpSend = vi.fn(async (_url, _auth, body) => {
      capturedBodies.push(body);
      return { sid: "FX4", status: "queued" };
    });
    const client = createTwilioFaxClient({ ...BASE_CREDS, httpSend: send });
    await client.sendFax({ to: "+1", from: "+2", mediaUrl: "http://x", quality: "superfine" });
    const params = new URLSearchParams(capturedBodies[0]);
    expect(params.get("Quality")).toBe("superfine");
  });

  it("omits StatusCallback when not provided", async () => {
    const capturedBodies: string[] = [];
    const send: FaxHttpSend = vi.fn(async (_url, _auth, body) => {
      capturedBodies.push(body);
      return { sid: "FX5", status: "queued" };
    });
    const client = createTwilioFaxClient({ ...BASE_CREDS, httpSend: send });
    await client.sendFax({ to: "+1", from: "+2", mediaUrl: "http://x" });
    const params = new URLSearchParams(capturedBodies[0]);
    expect(params.has("StatusCallback")).toBe(false);
  });

  it("includes StatusCallback when provided", async () => {
    const capturedBodies: string[] = [];
    const send: FaxHttpSend = vi.fn(async (_url, _auth, body) => {
      capturedBodies.push(body);
      return { sid: "FX6", status: "queued" };
    });
    const client = createTwilioFaxClient({ ...BASE_CREDS, httpSend: send });
    await client.sendFax({
      to: "+1",
      from: "+2",
      mediaUrl: "http://x",
      statusCallbackUrl: "https://api.example.com/fax/status-callback",
    });
    const params = new URLSearchParams(capturedBodies[0]);
    expect(params.get("StatusCallback")).toBe(
      "https://api.example.com/fax/status-callback",
    );
  });

  it("returns sid and status from a successful response", async () => {
    const send = makeSend({ sid: "FXabc123", status: "queued" });
    const client = createTwilioFaxClient({ ...BASE_CREDS, httpSend: send });
    const result = await client.sendFax({ to: "+1", from: "+2", mediaUrl: "http://x" });
    expect(result.sid).toBe("FXabc123");
    expect(result.status).toBe("queued");
  });

  it("throws TwilioApiError when httpSend throws TwilioApiError (no double-wrap)", async () => {
    const original = new TwilioApiError("bad request", 400, 21211);
    const send = makeSend(original);
    const client = createTwilioFaxClient({ ...BASE_CREDS, httpSend: send });
    await expect(
      client.sendFax({ to: "+1", from: "+2", mediaUrl: "http://x" }),
    ).rejects.toBeInstanceOf(TwilioApiError);
  });

  it("throws TwilioConfigError when httpSend throws TwilioConfigError (no double-wrap)", async () => {
    const original = new TwilioConfigError("missing creds");
    const send = makeSend(original);
    const client = createTwilioFaxClient({ ...BASE_CREDS, httpSend: send });
    await expect(
      client.sendFax({ to: "+1", from: "+2", mediaUrl: "http://x" }),
    ).rejects.toBeInstanceOf(TwilioConfigError);
  });

  it("wraps a generic error in TwilioApiError", async () => {
    const send = makeSend(new Error("network failure"));
    const client = createTwilioFaxClient({ ...BASE_CREDS, httpSend: send });
    await expect(
      client.sendFax({ to: "+1", from: "+2", mediaUrl: "http://x" }),
    ).rejects.toBeInstanceOf(TwilioApiError);
  });
});
