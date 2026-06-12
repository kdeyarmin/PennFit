// The storefront fetch client is kept in lockstep with the admin
// variant (see src/admin/custom-fetch.test.ts for the full matrix).
// This spec pins the storefront copy's own CSRF + error behavior so a
// divergence between the two hand-maintained files fails a test
// instead of shipping silently.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ApiError, customFetch } from "./custom-fetch";

function mockFetchOnce(response: Response): ReturnType<typeof vi.fn> {
  const fn = vi.fn().mockResolvedValue(response);
  vi.stubGlobal("fetch", fn);
  return fn;
}

function sentHeaders(fn: ReturnType<typeof vi.fn>): Headers {
  const init = fn.mock.calls[0]![1] as RequestInit;
  return new Headers(init.headers);
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("storefront customFetch", () => {
  beforeEach(() => {
    vi.stubGlobal("document", { cookie: "" });
  });

  it("attaches x-pf-csrf from the pf_csrf cookie on POST, not on GET", async () => {
    const fn = mockFetchOnce(
      new Response("{}", {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    (globalThis.document as { cookie: string }).cookie = "pf_csrf=tok%3D1";
    await customFetch("/api/x", { method: "POST", body: "{}" });
    expect(sentHeaders(fn).get("x-pf-csrf")).toBe("tok=1");

    const fn2 = mockFetchOnce(
      new Response("{}", {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    await customFetch("/api/x");
    expect(sentHeaders(fn2).has("x-pf-csrf")).toBe(false);
  });

  it("maps non-2xx JSON bodies onto ApiError", async () => {
    mockFetchOnce(
      new Response(JSON.stringify({ error: "rate_limited" }), {
        status: 429,
        statusText: "Too Many Requests",
        headers: { "content-type": "application/json" },
      }),
    );
    const err = await customFetch("/api/x").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).status).toBe(429);
    expect((err as ApiError).data).toEqual({ error: "rate_limited" });
  });
});
