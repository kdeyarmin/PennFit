// Tests for the feature-flags API client (feature-flags-api.ts).
//
// Coverage:
//   1. listFeatureFlags() calls the correct URL with credentials + Accept header.
//   2. toggleFeatureFlag() uses PATCH with the correct body and Content-Type.
//   3. jsonFetch extracts the error message from the JSON body (`message` field).
//   4. jsonFetch extracts the error message from the JSON body (`error` field).
//   5. jsonFetch falls back to `${status} ${statusText}` when the body has no
//      known field and when res.json() throws.
//   6. Successful responses are returned as the resolved value.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Mock } from "vitest";

import { listFeatureFlags, toggleFeatureFlag } from "./feature-flags-api";

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

// ─── listFeatureFlags ──────────────────────────────────────────────────────

describe("listFeatureFlags", () => {
  it("fetches /resupply-api/admin/feature-flags with credentials:include", async () => {
    const flags = [
      {
        key: "sms.reminders",
        enabled: true,
        description: "SMS reminders",
        category: "Messaging",
        updatedByEmail: null,
        updatedAt: "2026-01-01T00:00:00.000Z",
      },
    ];
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ flags }),
    });

    const result = await listFeatureFlags();

    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/resupply-api/admin/feature-flags");
    expect(init.credentials).toBe("include");
    expect((init.headers as Record<string, string>)["Accept"]).toBe(
      "application/json",
    );
    expect(result.flags).toEqual(flags);
  });

  it("throws when the server returns a non-ok status", async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 403,
      statusText: "Forbidden",
      json: async () => ({ message: "insufficient permissions" }),
    });

    await expect(listFeatureFlags()).rejects.toThrow("insufficient permissions");
  });
});

// ─── toggleFeatureFlag ────────────────────────────────────────────────────

describe("toggleFeatureFlag", () => {
  it("sends PATCH with the encoded key and the enabled boolean in the body", async () => {
    const updatedFlag = {
      key: "voice.agent",
      enabled: false,
      description: "Voice agent",
      category: "Voice & AI",
      updatedByEmail: "ops@example.com",
      updatedAt: "2026-05-22T12:00:00.000Z",
    };
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ flag: updatedFlag }),
    });

    const result = await toggleFeatureFlag("voice.agent", false);

    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/resupply-api/admin/feature-flags/voice.agent");
    expect(init.method).toBe("PATCH");
    expect((init.headers as Record<string, string>)["Content-Type"]).toBe(
      "application/json",
    );
    expect(JSON.parse(init.body as string)).toEqual({ enabled: false });
    expect(result.flag).toEqual(updatedFlag);
  });

  it("URL-encodes keys that contain special characters", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ flag: { key: "key with spaces", enabled: true } }),
    });

    await toggleFeatureFlag("key with spaces", true);

    const [url] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toContain("key%20with%20spaces");
  });

  it("sends enabled:true when toggling on", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ flag: { key: "sms.reminders", enabled: true } }),
    });

    await toggleFeatureFlag("sms.reminders", true);

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(init.body as string)).toEqual({ enabled: true });
  });
});

// ─── Error handling ───────────────────────────────────────────────────────

describe("jsonFetch error handling", () => {
  it("uses the `message` field from the error JSON body", async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 422,
      statusText: "Unprocessable Entity",
      json: async () => ({ message: "body validation failed" }),
    });

    await expect(listFeatureFlags()).rejects.toThrow("body validation failed");
  });

  it("falls back to the `error` field when `message` is absent", async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 404,
      statusText: "Not Found",
      json: async () => ({ error: "unknown_flag" }),
    });

    await expect(listFeatureFlags()).rejects.toThrow("unknown_flag");
  });

  it("falls back to `${status} ${statusText}` when the JSON body has no known field", async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 500,
      statusText: "Internal Server Error",
      json: async () => ({ unexpected: "field" }),
    });

    await expect(listFeatureFlags()).rejects.toThrow(
      "500 Internal Server Error",
    );
  });

  it("falls back to `${status} ${statusText}` when res.json() throws", async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 502,
      statusText: "Bad Gateway",
      json: async () => {
        throw new SyntaxError("Unexpected token");
      },
    });

    await expect(listFeatureFlags()).rejects.toThrow("502 Bad Gateway");
  });

  it("prefers `message` over `error` when both are present in the body", async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 400,
      statusText: "Bad Request",
      json: async () => ({
        message: "the message field",
        error: "the error field",
      }),
    });

    // The implementation coalesces: message ?? error ?? fallback
    await expect(listFeatureFlags()).rejects.toThrow("the message field");
  });
});