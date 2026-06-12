// First tests for the hand-maintained admin fetch client. This file
// covers the auth/CSRF header attachment and the error-mapping paths —
// the parts whose silent breakage would take every admin page down at
// once. The storefront variant is kept in lockstep with this one; its
// own spec mirrors the CSRF cases.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  ApiError,
  customFetch,
  setAuthTokenGetter,
  setBaseUrl,
} from "./custom-fetch";

function mockFetchOnce(response: Response): ReturnType<typeof vi.fn> {
  const fn = vi.fn().mockResolvedValue(response);
  vi.stubGlobal("fetch", fn);
  return fn;
}

function jsonResponse(
  body: unknown,
  init: { status?: number; statusText?: string } = {},
): Response {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    statusText: init.statusText ?? "",
    headers: { "content-type": "application/json" },
  });
}

function sentHeaders(fn: ReturnType<typeof vi.fn>): Headers {
  const init = fn.mock.calls[0]![1] as RequestInit;
  return new Headers(init.headers);
}

afterEach(() => {
  vi.unstubAllGlobals();
  setBaseUrl(null);
  setAuthTokenGetter(null);
});

describe("customFetch — success/error body handling", () => {
  it("parses a JSON success body", async () => {
    mockFetchOnce(jsonResponse({ ok: true }));
    await expect(customFetch("/resupply-api/me")).resolves.toEqual({
      ok: true,
    });
  });

  it("returns null for a 204 no-content response", async () => {
    mockFetchOnce(new Response(null, { status: 204 }));
    await expect(customFetch("/x")).resolves.toBeNull();
  });

  it("throws ApiError carrying parsed JSON data + message on non-2xx", async () => {
    mockFetchOnce(
      jsonResponse(
        { message: "Not allowed." },
        { status: 403, statusText: "Forbidden" },
      ),
    );
    const err = await customFetch("/x").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    const apiErr = err as ApiError<{ message: string }>;
    expect(apiErr.status).toBe(403);
    expect(apiErr.data).toEqual({ message: "Not allowed." });
    expect(apiErr.message).toContain("Not allowed.");
  });

  it("throws ApiError with null data on an empty error body", async () => {
    mockFetchOnce(
      new Response(null, { status: 500, statusText: "Internal Server Error" }),
    );
    const err = await customFetch("/x").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).data).toBeNull();
  });

  it("rejects GET requests with a body before hitting the network", async () => {
    const fn = mockFetchOnce(jsonResponse({}));
    await expect(
      customFetch("/x", { method: "GET", body: "{}" }),
    ).rejects.toThrow(TypeError);
    expect(fn).not.toHaveBeenCalled();
  });
});

describe("customFetch — base URL", () => {
  it("prepends the base URL to relative paths only", async () => {
    const fn = mockFetchOnce(jsonResponse({}));
    setBaseUrl("https://api.example.test///");
    await customFetch("/resupply-api/me");
    expect(fn.mock.calls[0]![0]).toBe(
      "https://api.example.test/resupply-api/me",
    );

    const fn2 = mockFetchOnce(jsonResponse({}));
    await customFetch("https://other.example.test/x");
    expect(fn2.mock.calls[0]![0]).toBe("https://other.example.test/x");
  });
});

describe("customFetch — Authorization header", () => {
  it("attaches a Bearer token from the configured getter", async () => {
    const fn = mockFetchOnce(jsonResponse({}));
    setAuthTokenGetter(() => "tok-123");
    await customFetch("/x");
    expect(sentHeaders(fn).get("authorization")).toBe("Bearer tok-123");
  });

  it("does not override an explicit Authorization header", async () => {
    const fn = mockFetchOnce(jsonResponse({}));
    setAuthTokenGetter(() => "tok-123");
    await customFetch("/x", { headers: { Authorization: "Bearer explicit" } });
    expect(sentHeaders(fn).get("authorization")).toBe("Bearer explicit");
  });

  it("omits the header when the getter returns null", async () => {
    const fn = mockFetchOnce(jsonResponse({}));
    setAuthTokenGetter(() => null);
    await customFetch("/x");
    expect(sentHeaders(fn).has("authorization")).toBe(false);
  });
});

describe("customFetch — CSRF double-submit header", () => {
  beforeEach(() => {
    vi.stubGlobal("document", { cookie: "" });
  });

  it("attaches x-pf-csrf from the pf_csrf cookie on state-changing methods", async () => {
    const fn = mockFetchOnce(jsonResponse({}));
    (globalThis.document as { cookie: string }).cookie =
      "other=1; pf_csrf=abc%2F123; trailing=2";
    await customFetch("/x", { method: "POST", body: "{}" });
    expect(sentHeaders(fn).get("x-pf-csrf")).toBe("abc/123");
  });

  it("does not attach the header on GET", async () => {
    const fn = mockFetchOnce(jsonResponse({}));
    (globalThis.document as { cookie: string }).cookie = "pf_csrf=abc";
    await customFetch("/x");
    expect(sentHeaders(fn).has("x-pf-csrf")).toBe(false);
  });

  it("skips cleanly when the cookie value is malformed percent-encoding", async () => {
    const fn = mockFetchOnce(jsonResponse({}));
    (globalThis.document as { cookie: string }).cookie = "pf_csrf=%E0%A4%A";
    await customFetch("/x", { method: "POST", body: "{}" });
    expect(sentHeaders(fn).has("x-pf-csrf")).toBe(false);
  });

  it("never overrides an explicitly provided x-pf-csrf header", async () => {
    const fn = mockFetchOnce(jsonResponse({}));
    (globalThis.document as { cookie: string }).cookie = "pf_csrf=from-cookie";
    await customFetch("/x", {
      method: "POST",
      body: "{}",
      headers: { "x-pf-csrf": "explicit" },
    });
    expect(sentHeaders(fn).get("x-pf-csrf")).toBe("explicit");
  });
});
