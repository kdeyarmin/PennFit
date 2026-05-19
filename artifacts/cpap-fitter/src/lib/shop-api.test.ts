// Tests for the submitFitterLead API wrapper in shop-api.ts.
//
// Covers the fetch contract for the fitter-consent capture endpoint:
//   * happy path — 200 with { ok: true }
//   * HTTP error with a JSON error code
//   * HTTP error when response.json() throws (no body)
//   * HTTP error when JSON body lacks an `error` string field
//   * correct HTTP method, URL, and Content-Type header
//   * honeypot field is serialised into the request body unchanged

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { Mock } from "vitest";
import { submitFitterLead } from "./shop-api";

const ORIGINAL_FETCH = globalThis.fetch;

let fetchMock: Mock;
beforeEach(() => {
  fetchMock = vi.fn();
  globalThis.fetch = fetchMock as unknown as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = ORIGINAL_FETCH;
  vi.restoreAllMocks();
});

const VALID_INPUT = {
  email: "alice@example.com",
  marketingOptIn: true,
  website: "",
};

describe("submitFitterLead", () => {
  test("returns { ok: true } when the server responds 200", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ ok: true }),
    });

    const result = await submitFitterLead(VALID_INPUT);
    expect(result).toEqual({ ok: true });
  });

  test("posts to /resupply-api/shop/fitter-leads with POST method", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ ok: true }),
    });

    await submitFitterLead(VALID_INPUT);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/resupply-api/shop/fitter-leads");
    expect(init.method).toBe("POST");
  });

  test("sends Content-Type: application/json and Accept: application/json", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ ok: true }),
    });

    await submitFitterLead(VALID_INPUT);

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const headers = init.headers as Record<string, string>;
    expect(headers["Content-Type"]).toBe("application/json");
    expect(headers["Accept"]).toBe("application/json");
  });

  test("serialises the input as JSON in the request body", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ ok: true }),
    });

    await submitFitterLead(VALID_INPUT);

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(init.body as string)).toEqual(VALID_INPUT);
  });

  test("passes the honeypot website field through in the body", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ ok: true }),
    });

    await submitFitterLead({ ...VALID_INPUT, website: "http://spam.example" });

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string) as Record<string, unknown>;
    expect(body.website).toBe("http://spam.example");
  });

  test("throws an Error with the JSON error code on a non-OK response", async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 400,
      json: async () => ({ error: "marketing_opt_in_required" }),
    });

    await expect(submitFitterLead(VALID_INPUT)).rejects.toThrow(
      "marketing_opt_in_required",
    );
  });

  test("throws http_<status> when JSON response has no error string field", async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 400,
      json: async () => ({ message: "some message without error key" }),
    });

    await expect(submitFitterLead(VALID_INPUT)).rejects.toThrow("http_400");
  });

  test("throws http_<status> when response.json() throws (no JSON body)", async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 500,
      json: async () => {
        throw new Error("invalid json");
      },
    });

    await expect(submitFitterLead(VALID_INPUT)).rejects.toThrow("http_500");
  });

  test("throws http_429 on rate-limit response with no JSON body", async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 429,
      json: async () => {
        throw new SyntaxError("unexpected end of JSON");
      },
    });

    await expect(submitFitterLead(VALID_INPUT)).rejects.toThrow("http_429");
  });
});