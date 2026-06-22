// Tests for the shared admin fetch wrapper. Locks in the behaviour the
// 49 per-file `jsonFetch` helpers had drifted away from: prefix, default
// headers, CSRF, credentials, override precedence, and ApiError on failure.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Mock } from "vitest";

import { ApiError } from "@workspace/api-client-react/admin";

import { adminJsonFetch } from "./admin-json-fetch";

const ORIGINAL_FETCH = globalThis.fetch;
const ORIGINAL_DOCUMENT = (globalThis as { document?: unknown }).document;
let fetchMock: Mock;

function okJson(body: unknown) {
  return {
    ok: true,
    status: 200,
    json: async () => body,
  };
}

function headersOf(call: number): Record<string, string> {
  const [, init] = fetchMock.mock.calls[call] as [string, RequestInit];
  return init.headers as Record<string, string>;
}

beforeEach(() => {
  fetchMock = vi.fn();
  globalThis.fetch = fetchMock as unknown as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = ORIGINAL_FETCH;
  if (ORIGINAL_DOCUMENT === undefined) {
    delete (globalThis as { document?: unknown }).document;
  } else {
    (globalThis as { document?: unknown }).document = ORIGINAL_DOCUMENT;
  }
  vi.restoreAllMocks();
});

describe("adminJsonFetch — request shape", () => {
  it("prefixes the path with /resupply-api", async () => {
    fetchMock.mockResolvedValue(okJson({}));
    await adminJsonFetch("/admin/alerts");
    const [url] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/resupply-api/admin/alerts");
  });

  it("defaults Accept and Content-Type to application/json", async () => {
    fetchMock.mockResolvedValue(okJson({}));
    await adminJsonFetch("/admin/alerts");
    const headers = headersOf(0);
    expect(headers["Accept"]).toBe("application/json");
    expect(headers["Content-Type"]).toBe("application/json");
  });

  it("sends credentials: include so the session cookie rides along", async () => {
    fetchMock.mockResolvedValue(okJson({}));
    await adminJsonFetch("/admin/alerts");
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(init.credentials).toBe("include");
  });

  it("forwards method and body from init", async () => {
    fetchMock.mockResolvedValue(okJson({ ok: true }));
    await adminJsonFetch("/admin/alerts", {
      method: "POST",
      body: JSON.stringify({ a: 1 }),
    });
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(init.method).toBe("POST");
    expect(init.body).toBe(JSON.stringify({ a: 1 }));
  });
});

describe("adminJsonFetch — CSRF header", () => {
  it("omits X-PF-CSRF when no pf_csrf cookie is present", async () => {
    fetchMock.mockResolvedValue(okJson({}));
    await adminJsonFetch("/admin/alerts");
    expect(headersOf(0)["X-PF-CSRF"]).toBeUndefined();
  });

  it("includes X-PF-CSRF from the pf_csrf cookie when present", async () => {
    (globalThis as { document?: unknown }).document = {
      cookie: "foo=bar; pf_csrf=token-123; baz=qux",
    };
    fetchMock.mockResolvedValue(okJson({}));
    await adminJsonFetch("/admin/alerts", { method: "POST" });
    expect(headersOf(0)["X-PF-CSRF"]).toBe("token-123");
  });
});

describe("adminJsonFetch — override precedence", () => {
  it("lets caller headers override the defaults", async () => {
    fetchMock.mockResolvedValue(okJson({}));
    await adminJsonFetch("/admin/export", {
      headers: { "Content-Type": "text/csv", Accept: "text/csv" },
    });
    const headers = headersOf(0);
    expect(headers["Content-Type"]).toBe("text/csv");
    expect(headers["Accept"]).toBe("text/csv");
  });
});

describe("adminJsonFetch — responses", () => {
  it("resolves to undefined on a 204 No Content (no JSON parse)", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 204,
      json: async () => {
        throw new Error("204 has no body");
      },
    });
    await expect(
      adminJsonFetch("/admin/reports/presets/p-1", { method: "DELETE" }),
    ).resolves.toBeUndefined();
  });

  it("returns the parsed JSON body on success", async () => {
    const payload = { items: [1, 2, 3], count: 3 };
    fetchMock.mockResolvedValue(okJson(payload));
    const result = await adminJsonFetch<typeof payload>("/admin/alerts");
    expect(result).toEqual(payload);
  });

  it("throws ApiError with the server message on a non-OK response", async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 500,
      statusText: "Internal Server Error",
      headers: new Headers(),
      url: "",
      json: async () => ({ message: "boom" }),
    });
    const err = await adminJsonFetch("/admin/alerts").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).status).toBe(500);
    expect((err as ApiError).message).toContain("boom");
  });

  it("throws ApiError with null data when the error body is not JSON", async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 503,
      statusText: "Service Unavailable",
      headers: new Headers(),
      url: "",
      json: async () => {
        throw new SyntaxError("bad json");
      },
    });
    const err = await adminJsonFetch("/admin/alerts").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).data).toBeNull();
    expect((err as ApiError).status).toBe(503);
  });
});
