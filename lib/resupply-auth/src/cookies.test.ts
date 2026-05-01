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

describe("readCookie", () => {
  function makeReq(header?: string) {
    return { headers: { cookie: header } } as unknown as import("express").Request;
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
