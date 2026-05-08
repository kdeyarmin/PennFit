// Behavioural test for the storefront customFetch CSRF auto-attach.
//
// The helper itself lives in `@workspace/api-client-react/storefront`
// but that package has no test infrastructure of its own — its
// consumer is cpap-fitter, so the test lives here. Vitest's `node`
// environment doesn't ship a `document`, so we shim one and stub
// `globalThis.fetch` to capture the headers the request would have
// sent.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Import from the storefront package entrypoint used by consumers.
// This test lives in cpap-fitter because that package provides the
// test infrastructure for exercising the helper's runtime behavior.
import { customFetch } from "@workspace/api-client-react/storefront";

const ORIGINAL_FETCH = globalThis.fetch;

interface CapturedRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
}

function setupMocks(cookie: string | null) {
  if (cookie === null) {
    delete (globalThis as unknown as { document?: unknown }).document;
  } else {
    (globalThis as unknown as { document?: unknown }).document = { cookie };
  }
  const captured: CapturedRequest[] = [];
  const fetchMock = vi.fn(
    async (input: unknown, init: RequestInit = {}) => {
      const headersObj: Record<string, string> = {};
      if (init.headers instanceof Headers) {
        init.headers.forEach((value, key) => {
          headersObj[key.toLowerCase()] = value;
        });
      } else if (Array.isArray(init.headers)) {
        for (const [k, v] of init.headers) headersObj[k.toLowerCase()] = v;
      } else if (init.headers && typeof init.headers === "object") {
        for (const [k, v] of Object.entries(
          init.headers as Record<string, string>,
        )) {
          headersObj[k.toLowerCase()] = v;
        }
      }
      captured.push({
        url: typeof input === "string" ? input : String(input),
        method: (init.method ?? "GET").toUpperCase(),
        headers: headersObj,
      });
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
  );
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (globalThis as any).fetch = fetchMock;
  return { captured, fetchMock };
}

describe("storefront customFetch CSRF auto-attach", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });
  afterEach(() => {
    globalThis.fetch = ORIGINAL_FETCH;
    delete (globalThis as unknown as { document?: unknown }).document;
    vi.restoreAllMocks();
  });

  it("attaches X-PF-CSRF on POST when pf_csrf cookie is present", async () => {
    const { captured } = setupMocks("pf_csrf=abc123; other=foo");
    await customFetch("/api/something", {
      method: "POST",
      body: JSON.stringify({ a: 1 }),
    });
    expect(captured).toHaveLength(1);
    expect(captured[0]!.headers["x-pf-csrf"]).toBe("abc123");
  });

  it("URL-decodes the cookie value before attaching", async () => {
    const { captured } = setupMocks("pf_csrf=hello%20world");
    await customFetch("/api/x", { method: "POST" });
    expect(captured[0]!.headers["x-pf-csrf"]).toBe("hello world");
  });

  it("does NOT attach X-PF-CSRF on GET", async () => {
    const { captured } = setupMocks("pf_csrf=abc");
    await customFetch("/api/x", { method: "GET" });
    expect("x-pf-csrf" in captured[0]!.headers).toBe(false);
  });

  it("does NOT attach X-PF-CSRF on HEAD or OPTIONS", async () => {
    const { captured } = setupMocks("pf_csrf=abc");
    await customFetch("/api/x", { method: "HEAD" });
    await customFetch("/api/x", { method: "OPTIONS" });
    expect(captured.every((c) => !("x-pf-csrf" in c.headers))).toBe(true);
  });

  it("preserves an explicit X-PF-CSRF header set by the caller", async () => {
    const { captured } = setupMocks("pf_csrf=auto");
    await customFetch("/api/x", {
      method: "POST",
      headers: { "x-pf-csrf": "manual-override" },
    });
    expect(captured[0]!.headers["x-pf-csrf"]).toBe("manual-override");
  });

  it("skips when the cookie is missing", async () => {
    const { captured } = setupMocks("other=foo");
    await customFetch("/api/x", { method: "POST" });
    expect("x-pf-csrf" in captured[0]!.headers).toBe(false);
  });

  it("skips when document is unavailable (SSR / RN)", async () => {
    const { captured } = setupMocks(null);
    await customFetch("/api/x", { method: "POST" });
    expect("x-pf-csrf" in captured[0]!.headers).toBe(false);
  });
});
