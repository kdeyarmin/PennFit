// Tests for the shared CSRF header helper (csrf.ts).
//
// The helper reads the `pf_csrf` cookie from `document.cookie` and
// returns `{ "X-PF-CSRF": <token> }` when the cookie is present, or
// `{}` when it is absent. Vitest's node environment has no DOM, so we
// shim `document` onto `globalThis` exactly as custom-fetch-csrf.test.ts
// does.

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { csrfHeader } from "./csrf";

// ─── Helpers ────────────────────────────────────────────────────────────────

function setDocumentCookie(cookie: string | null) {
  if (cookie === null) {
    delete (globalThis as unknown as { document?: unknown }).document;
  } else {
    (globalThis as unknown as { document?: unknown }).document = { cookie };
  }
}

// ─── Teardown ───────────────────────────────────────────────────────────────

beforeEach(() => {
  // Start each test with no document shim so state doesn't leak between tests.
  delete (globalThis as unknown as { document?: unknown }).document;
});

afterEach(() => {
  delete (globalThis as unknown as { document?: unknown }).document;
});

// ─── csrfHeader — cookie present ────────────────────────────────────────────

describe("csrfHeader — pf_csrf cookie present", () => {
  it("returns { 'X-PF-CSRF': <token> } when the cookie is the only one", () => {
    setDocumentCookie("pf_csrf=abc123");
    expect(csrfHeader()).toEqual({ "X-PF-CSRF": "abc123" });
  });

  it("returns the token when pf_csrf is the first of several cookies", () => {
    setDocumentCookie("pf_csrf=tok1; other=foo; another=bar");
    expect(csrfHeader()).toEqual({ "X-PF-CSRF": "tok1" });
  });

  it("returns the token when pf_csrf is a middle cookie", () => {
    setDocumentCookie("first=a; pf_csrf=mid-token; last=z");
    expect(csrfHeader()).toEqual({ "X-PF-CSRF": "mid-token" });
  });

  it("returns the token when pf_csrf is the last cookie", () => {
    setDocumentCookie("first=a; second=b; pf_csrf=last-token");
    expect(csrfHeader()).toEqual({ "X-PF-CSRF": "last-token" });
  });

  it("URL-decodes a percent-encoded token value", () => {
    setDocumentCookie("pf_csrf=hello%20world");
    expect(csrfHeader()).toEqual({ "X-PF-CSRF": "hello world" });
  });

  it("URL-decodes special characters in the token", () => {
    setDocumentCookie("pf_csrf=a%2Bb%3Dc");
    expect(csrfHeader()).toEqual({ "X-PF-CSRF": "a+b=c" });
  });

  it("handles tokens that contain no percent-encoding (plain alphanumeric)", () => {
    setDocumentCookie("pf_csrf=ABCDEF0123456789");
    expect(csrfHeader()).toEqual({ "X-PF-CSRF": "ABCDEF0123456789" });
  });

  it("strips leading whitespace around the cookie name (multi-cookie string)", () => {
    // Some browsers emit "; pf_csrf=value" with a leading space after the semicolon.
    setDocumentCookie("session=xyz;  pf_csrf=trimmed; foo=bar");
    expect(csrfHeader()).toEqual({ "X-PF-CSRF": "trimmed" });
  });

  it("does not confuse a cookie whose name contains 'pf_csrf' as a suffix", () => {
    // e.g. "not_pf_csrf=sneaky" must not match.
    setDocumentCookie("not_pf_csrf=sneaky; pf_csrf=real");
    expect(csrfHeader()["X-PF-CSRF"]).toBe("real");
  });
});

// ─── csrfHeader — cookie absent ─────────────────────────────────────────────

describe("csrfHeader — pf_csrf cookie absent", () => {
  it("returns {} when the cookie string contains no pf_csrf cookie", () => {
    setDocumentCookie("session=abc; other=foo");
    expect(csrfHeader()).toEqual({});
  });

  it("returns {} when document.cookie is an empty string", () => {
    setDocumentCookie("");
    expect(csrfHeader()).toEqual({});
  });

  it("returns {} when document is undefined (SSR / non-browser)", () => {
    setDocumentCookie(null);
    expect(csrfHeader()).toEqual({});
  });
});

// ─── csrfHeader — malformed percent-encoding ────────────────────────────────

describe("csrfHeader — malformed percent-encoded token", () => {
  it("returns {} when the cookie value contains an invalid percent sequence", () => {
    // decodeURIComponent('%ZZ') throws; the helper should catch it and return {}.
    setDocumentCookie("pf_csrf=%ZZ");
    expect(csrfHeader()).toEqual({});
  });

  it("returns {} when the cookie value ends with a lone percent sign", () => {
    setDocumentCookie("pf_csrf=abc%");
    expect(csrfHeader()).toEqual({});
  });
});

// ─── csrfHeader — return-value contract ─────────────────────────────────────

describe("csrfHeader — return-value shape", () => {
  it("returns a plain object (not a Headers instance)", () => {
    setDocumentCookie("pf_csrf=tok");
    const result = csrfHeader();
    // Must be spreadable into a plain-object headers dict.
    expect(result).not.toBeInstanceOf(Headers);
    expect(typeof result).toBe("object");
    expect(result).not.toBeNull();
  });

  it("the returned object is safe to spread even when the cookie is absent", () => {
    setDocumentCookie("other=foo");
    const merged = { Accept: "application/json", ...csrfHeader() };
    expect(merged).toEqual({ Accept: "application/json" });
    expect("X-PF-CSRF" in merged).toBe(false);
  });

  it("the returned object is safe to spread when the token is present", () => {
    setDocumentCookie("pf_csrf=mytoken");
    const merged = {
      Accept: "application/json",
      "Content-Type": "application/json",
      ...csrfHeader(),
    };
    expect(merged["X-PF-CSRF"]).toBe("mytoken");
    expect(merged["Accept"]).toBe("application/json");
    expect(merged["Content-Type"]).toBe("application/json");
  });

  it("each call to csrfHeader() returns a fresh object", () => {
    setDocumentCookie("pf_csrf=tok");
    const a = csrfHeader();
    const b = csrfHeader();
    expect(a).not.toBe(b); // different references
    expect(a).toEqual(b); // same content
  });
});
