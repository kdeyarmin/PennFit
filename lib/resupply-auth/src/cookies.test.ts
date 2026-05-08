import { describe, expect, it } from "vitest";

import {
  appendSetCookie,
  buildClearCookies,
  buildCsrfCookie,
  buildSessionCookie,
  CSRF_COOKIE,
  readCookie,
  SESSION_COOKIE,
} from "./cookies";

describe("buildSessionCookie", () => {
  it("includes HttpOnly, SameSite=Lax, Secure (when requested), Path, Max-Age", () => {
    const v = buildSessionCookie("abc", { secure: true, maxAgeSeconds: 60 });
    expect(v).toContain(`${SESSION_COOKIE}=abc`);
    expect(v).toContain("HttpOnly");
    expect(v).toContain("Secure");
    expect(v).toContain("SameSite=Lax");
    expect(v).toContain("Path=/");
    expect(v).toContain("Max-Age=60");
  });

  it("omits Secure in development (so cookies survive http://localhost)", () => {
    const v = buildSessionCookie("abc", { secure: false, maxAgeSeconds: 60 });
    expect(v).not.toContain("Secure");
    expect(v).toContain("HttpOnly");
  });
});

describe("buildCsrfCookie", () => {
  it("does NOT include HttpOnly (the SPA must read it)", () => {
    const v = buildCsrfCookie("xyz", { secure: true, maxAgeSeconds: 60 });
    expect(v).not.toContain("HttpOnly");
    expect(v).toContain(`${CSRF_COOKIE}=xyz`);
  });
});

describe("buildClearCookies", () => {
  it("emits two cookies with Max-Age=0", () => {
    const cookies = buildClearCookies({ secure: true });
    expect(cookies).toHaveLength(2);
    for (const c of cookies) {
      expect(c).toContain("Max-Age=0");
    }
  });
});

// Locked-in invariants for the session cookie. Each attribute below
// is load-bearing for one of the auth threats we defend against; the
// asserts use exact strings (rather than `toContain`) so a typo or
// silent downgrade — e.g. `SameSite=None` slipping in for an SDK
// experiment — fails the test instead of looking "still kinda right".
describe("session cookie security invariants", () => {
  // 30 days = the production setting we ship — picked to mirror the
  // resupply auth lib's default rather than to assert a specific
  // duration. The check below just verifies the value passes through.
  const PROD_OPTS = { secure: true, maxAgeSeconds: 60 * 60 * 24 * 30 };

  it("session cookie has HttpOnly, Secure, SameSite=Lax, Path=/, Max-Age", () => {
    const v = buildSessionCookie("token", PROD_OPTS);
    const parts = v.split("; ").map((p) => p.trim());
    // HttpOnly: blocks JS access (xss exfiltration of session token).
    expect(parts).toContain("HttpOnly");
    // Secure: cookie is never sent over plain HTTP in prod.
    expect(parts).toContain("Secure");
    // SameSite=Lax (NOT Strict, NOT None): exact-match — Strict
    // would break our auth UX (sign-in landing nav loses the
    // cookie); None would re-open CSRF on top-level navs.
    expect(parts).toContain("SameSite=Lax");
    expect(parts.some((p) => p === "SameSite=Strict")).toBe(false);
    expect(parts.some((p) => p === "SameSite=None")).toBe(false);
    expect(parts).toContain("Path=/");
    // Max-Age, not Expires — mirrors the buildSessionCookie contract
    // (Max-Age is what the helper writes; Expires is set by clients
    // that mirror legacy headers, and we deliberately don't).
    expect(parts).toContain(`Max-Age=${PROD_OPTS.maxAgeSeconds}`);
    expect(parts.some((p) => p.startsWith("Expires="))).toBe(false);
  });

  it("CSRF cookie omits HttpOnly so the SPA can echo it into X-PF-CSRF", () => {
    const v = buildCsrfCookie("token", PROD_OPTS);
    const parts = v.split("; ").map((p) => p.trim());
    expect(parts).not.toContain("HttpOnly");
    expect(parts).toContain("Secure");
    expect(parts).toContain("SameSite=Lax");
    expect(parts).toContain("Path=/");
  });

  it("the session token never appears outside the value position", () => {
    // Defensive: flag set in any order shouldn't accidentally place
    // the token after a flag (which would mis-name a cookie attribute
    // on lenient clients).
    const v = buildSessionCookie("super-secret-token", PROD_OPTS);
    const firstSemi = v.indexOf(";");
    const head = v.slice(0, firstSemi === -1 ? v.length : firstSemi);
    expect(head).toBe("pf_session=super-secret-token");
  });

  it("clear cookies wipe BOTH session and CSRF and keep Secure when requested", () => {
    const cleared = buildClearCookies({ secure: true });
    expect(cleared).toHaveLength(2);
    expect(cleared[0]).toMatch(/^pf_session=;/);
    expect(cleared[1]).toMatch(/^pf_csrf=;/);
    for (const c of cleared) {
      expect(c).toContain("Max-Age=0");
      expect(c).toContain("Secure");
      expect(c).toContain("SameSite=Lax");
    }
    // The session-clear header MUST keep HttpOnly so a partial cookie
    // (one that survived a botched sign-out) can't be read by JS.
    expect(cleared[0]).toContain("HttpOnly");
    expect(cleared[1]).not.toContain("HttpOnly");
  });
});

describe("readCookie", () => {
  function makeReq(header?: string) {
    return {
      headers: { cookie: header },
    } as unknown as import("express").Request;
  }

  it("returns null when there's no Cookie header", () => {
    expect(readCookie(makeReq(), SESSION_COOKIE)).toBeNull();
  });

  it("returns the value for the named cookie", () => {
    const r = makeReq(`other=1; ${SESSION_COOKIE}=abc; ${CSRF_COOKIE}=xyz`);
    expect(readCookie(r, SESSION_COOKIE)).toBe("abc");
    expect(readCookie(r, CSRF_COOKIE)).toBe("xyz");
  });

  it("preserves '=' inside the cookie value", () => {
    const r = makeReq(`${SESSION_COOKIE}=AAA==BBB`);
    expect(readCookie(r, SESSION_COOKIE)).toBe("AAA==BBB");
  });

  it("returns null for a cookie that's not present", () => {
    const r = makeReq(`other=1`);
    expect(readCookie(r, SESSION_COOKIE)).toBeNull();
  });
});

describe("appendSetCookie", () => {
  function makeRes() {
    const headers = new Map<string, string | string[]>();
    return {
      headers,
      getHeader: (k: string) => headers.get(k.toLowerCase()),
      setHeader: (k: string, v: string | string[]) =>
        headers.set(k.toLowerCase(), v),
    } as unknown as import("express").Response & {
      headers: Map<string, string | string[]>;
    };
  }

  it("appends without clobbering existing Set-Cookie", () => {
    const res = makeRes() as unknown as import("express").Response & {
      headers: Map<string, string | string[]>;
    };
    appendSetCookie(res, "a=1");
    appendSetCookie(res, ["b=2", "c=3"]);
    expect(res.headers.get("set-cookie")).toEqual(["a=1", "b=2", "c=3"]);
  });
});
