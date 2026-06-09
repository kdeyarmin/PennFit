// Unit tests for the Telnyx Programmable Fax client (telnyx-fax.ts).
//
// Coverage:
//   * TelnyxConfigError thrown when TELNYX_API_KEY is missing
//   * TelnyxConfigError thrown when TELNYX_FAX_CONNECTION_ID is missing
//   * Explicit options override env vars
//   * Happy path: Bearer auth key + correct JSON body
//   * Default quality is "high"
//   * Optional webhook_url included only when statusCallbackUrl provided
//   * Custom quality passed through
//   * Telnyx error envelope → TelnyxApiError with status + code
//   * Non-JSON response → TelnyxApiError
//   * Response missing data.id → TelnyxApiError
//   * TelnyxApiError/TelnyxConfigError re-thrown as-is (no double-wrap)

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createTelnyxFaxClient,
  TelnyxApiError,
  TelnyxConfigError,
  type FaxHttpSend,
  type SendFaxResult,
  type TelnyxFaxRequestBody,
} from "./telnyx-fax";

const BASE_CREDS = { apiKey: "KEYtest", connectionId: "conn-1" };

function makeSend(result: SendFaxResult | Error): FaxHttpSend {
  return vi.fn(async () => {
    if (result instanceof Error) throw result;
    return result;
  });
}

describe("createTelnyxFaxClient — config validation", () => {
  beforeEach(() => {
    delete process.env.TELNYX_API_KEY;
    delete process.env.TELNYX_FAX_CONNECTION_ID;
  });
  afterEach(() => {
    delete process.env.TELNYX_API_KEY;
    delete process.env.TELNYX_FAX_CONNECTION_ID;
  });

  it("throws TelnyxConfigError when TELNYX_API_KEY is missing", () => {
    expect(() => createTelnyxFaxClient()).toThrow(TelnyxConfigError);
  });

  it("throws TelnyxConfigError when TELNYX_FAX_CONNECTION_ID is missing", () => {
    process.env.TELNYX_API_KEY = "KEYenv";
    expect(() => createTelnyxFaxClient()).toThrow(TelnyxConfigError);
  });

  it("reads credentials from env when options are not supplied", async () => {
    process.env.TELNYX_API_KEY = "KEYenv";
    process.env.TELNYX_FAX_CONNECTION_ID = "conn-env";
    const capturedKeys: string[] = [];
    const capturedBodies: TelnyxFaxRequestBody[] = [];
    const send: FaxHttpSend = vi.fn(async (_url, apiKey, body) => {
      capturedKeys.push(apiKey);
      capturedBodies.push(body);
      return { id: "fax-env", status: "queued" };
    });
    const client = createTelnyxFaxClient({ httpSend: send });
    await client.sendFax({ to: "+1", from: "+2", mediaUrl: "http://x" });
    expect(capturedKeys[0]).toBe("KEYenv");
    expect(capturedBodies[0]?.connection_id).toBe("conn-env");
  });

  it("explicit options override env vars", async () => {
    process.env.TELNYX_API_KEY = "KEYenv";
    process.env.TELNYX_FAX_CONNECTION_ID = "conn-env";
    const capturedKeys: string[] = [];
    const capturedBodies: TelnyxFaxRequestBody[] = [];
    const send: FaxHttpSend = vi.fn(async (_url, apiKey, body) => {
      capturedKeys.push(apiKey);
      capturedBodies.push(body);
      return { id: "fax-override", status: "queued" };
    });
    const client = createTelnyxFaxClient({
      apiKey: "KEYoverride",
      connectionId: "conn-override",
      httpSend: send,
    });
    await client.sendFax({ to: "+1", from: "+2", mediaUrl: "http://x" });
    expect(capturedKeys[0]).toBe("KEYoverride");
    expect(capturedBodies[0]?.connection_id).toBe("conn-override");
  });
});

describe("createTelnyxFaxClient — sendFax", () => {
  it("sends to the Telnyx Faxes API URL", async () => {
    const capturedUrl: string[] = [];
    const send: FaxHttpSend = vi.fn(async (url, _key, _body) => {
      capturedUrl.push(url);
      return { id: "fax-1", status: "queued" };
    });
    const client = createTelnyxFaxClient({ ...BASE_CREDS, httpSend: send });
    await client.sendFax({
      to: "+12155551212",
      from: "+12155550000",
      mediaUrl: "https://example.com/doc.pdf",
    });
    expect(capturedUrl[0]).toBe("https://api.telnyx.com/v2/faxes");
  });

  it("includes to, from, media_url, connection_id in the body", async () => {
    const captured: TelnyxFaxRequestBody[] = [];
    const send: FaxHttpSend = vi.fn(async (_url, _key, body) => {
      captured.push(body);
      return { id: "fax-2", status: "queued" };
    });
    const client = createTelnyxFaxClient({ ...BASE_CREDS, httpSend: send });
    await client.sendFax({
      to: "+12155551212",
      from: "+12155550000",
      mediaUrl: "https://example.com/doc.pdf",
    });
    expect(captured[0]).toMatchObject({
      to: "+12155551212",
      from: "+12155550000",
      media_url: "https://example.com/doc.pdf",
      connection_id: "conn-1",
    });
  });

  it("defaults quality to 'high'", async () => {
    const captured: TelnyxFaxRequestBody[] = [];
    const send: FaxHttpSend = vi.fn(async (_url, _key, body) => {
      captured.push(body);
      return { id: "fax-3", status: "queued" };
    });
    const client = createTelnyxFaxClient({ ...BASE_CREDS, httpSend: send });
    await client.sendFax({ to: "+1", from: "+2", mediaUrl: "http://x" });
    expect(captured[0]?.quality).toBe("high");
  });

  it("passes custom quality through", async () => {
    const captured: TelnyxFaxRequestBody[] = [];
    const send: FaxHttpSend = vi.fn(async (_url, _key, body) => {
      captured.push(body);
      return { id: "fax-4", status: "queued" };
    });
    const client = createTelnyxFaxClient({ ...BASE_CREDS, httpSend: send });
    await client.sendFax({
      to: "+1",
      from: "+2",
      mediaUrl: "http://x",
      quality: "very_high",
    });
    expect(captured[0]?.quality).toBe("very_high");
  });

  it("omits webhook_url when statusCallbackUrl not provided", async () => {
    const captured: TelnyxFaxRequestBody[] = [];
    const send: FaxHttpSend = vi.fn(async (_url, _key, body) => {
      captured.push(body);
      return { id: "fax-5", status: "queued" };
    });
    const client = createTelnyxFaxClient({ ...BASE_CREDS, httpSend: send });
    await client.sendFax({ to: "+1", from: "+2", mediaUrl: "http://x" });
    expect(captured[0]).not.toHaveProperty("webhook_url");
  });

  it("includes webhook_url when statusCallbackUrl provided", async () => {
    const captured: TelnyxFaxRequestBody[] = [];
    const send: FaxHttpSend = vi.fn(async (_url, _key, body) => {
      captured.push(body);
      return { id: "fax-6", status: "queued" };
    });
    const client = createTelnyxFaxClient({ ...BASE_CREDS, httpSend: send });
    await client.sendFax({
      to: "+1",
      from: "+2",
      mediaUrl: "http://x",
      statusCallbackUrl: "https://api.example.com/fax/status-callback",
    });
    expect(captured[0]?.webhook_url).toBe(
      "https://api.example.com/fax/status-callback",
    );
  });

  it("returns id and status from a successful response", async () => {
    const send = makeSend({ id: "fax-abc123", status: "queued" });
    const client = createTelnyxFaxClient({ ...BASE_CREDS, httpSend: send });
    const result = await client.sendFax({
      to: "+1",
      from: "+2",
      mediaUrl: "http://x",
    });
    expect(result.id).toBe("fax-abc123");
    expect(result.status).toBe("queued");
  });

  it("rethrows TelnyxApiError without double-wrap", async () => {
    const original = new TelnyxApiError("bad request", 422, "10009");
    const send = makeSend(original);
    const client = createTelnyxFaxClient({ ...BASE_CREDS, httpSend: send });
    await expect(
      client.sendFax({ to: "+1", from: "+2", mediaUrl: "http://x" }),
    ).rejects.toBe(original);
  });

  it("rethrows TelnyxConfigError without double-wrap", async () => {
    const original = new TelnyxConfigError("missing creds");
    const send = makeSend(original);
    const client = createTelnyxFaxClient({ ...BASE_CREDS, httpSend: send });
    await expect(
      client.sendFax({ to: "+1", from: "+2", mediaUrl: "http://x" }),
    ).rejects.toBeInstanceOf(TelnyxConfigError);
  });

  it("wraps a generic error in TelnyxApiError", async () => {
    const send = makeSend(new Error("network failure"));
    const client = createTelnyxFaxClient({ ...BASE_CREDS, httpSend: send });
    await expect(
      client.sendFax({ to: "+1", from: "+2", mediaUrl: "http://x" }),
    ).rejects.toBeInstanceOf(TelnyxApiError);
  });
});

describe("createTelnyxFaxClient — defaultHttpSend over fetch", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("parses the data envelope on success", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({ data: { id: "fx-9", status: "queued" } }),
            {
              status: 202,
              headers: { "content-type": "application/json" },
            },
          ),
      ),
    );
    const client = createTelnyxFaxClient(BASE_CREDS);
    const result = await client.sendFax({
      to: "+1",
      from: "+2",
      mediaUrl: "http://x",
    });
    expect(result).toEqual({ id: "fx-9", status: "queued" });
  });

  it("maps a Telnyx error envelope to TelnyxApiError", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              errors: [{ code: "10009", title: "Bad", detail: "from invalid" }],
            }),
            { status: 422, headers: { "content-type": "application/json" } },
          ),
      ),
    );
    const client = createTelnyxFaxClient(BASE_CREDS);
    await expect(
      client.sendFax({ to: "+1", from: "+2", mediaUrl: "http://x" }),
    ).rejects.toMatchObject({
      name: "TelnyxApiError",
      status: 422,
      code: "10009",
      message: "from invalid",
    });
  });

  it("throws TelnyxApiError when the response has no data.id", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(JSON.stringify({ data: {} }), {
            status: 202,
            headers: { "content-type": "application/json" },
          }),
      ),
    );
    const client = createTelnyxFaxClient(BASE_CREDS);
    await expect(
      client.sendFax({ to: "+1", from: "+2", mediaUrl: "http://x" }),
    ).rejects.toBeInstanceOf(TelnyxApiError);
  });
});
