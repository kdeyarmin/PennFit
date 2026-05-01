import { describe, expect, it } from "vitest";

import { CSRF_COOKIE, CSRF_HEADER } from "./cookies";
import { checkCsrf } from "./csrf";

function makeReq(opts: {
  cookieValue?: string;
  headerValue?: string;
}): import("express").Request {
  const cookie = opts.cookieValue
    ? `${CSRF_COOKIE}=${opts.cookieValue}`
    : undefined;
  return {
    headers: {
      cookie,
      [CSRF_HEADER]: opts.headerValue,
    },
  } as unknown as import("express").Request;
}

describe("checkCsrf", () => {
  it("ok when cookie equals header", () => {
    const r = makeReq({ cookieValue: "abc123", headerValue: "abc123" });
    expect(checkCsrf(r)).toEqual({ ok: true });
  });

  it("fails when cookie missing", () => {
    expect(checkCsrf(makeReq({ headerValue: "abc" }))).toEqual({
      ok: false,
      reason: "missing_cookie",
    });
  });

  it("fails when header missing", () => {
    expect(checkCsrf(makeReq({ cookieValue: "abc" }))).toEqual({
      ok: false,
      reason: "missing_header",
    });
  });

  it("fails on mismatch", () => {
    expect(
      checkCsrf(makeReq({ cookieValue: "abc", headerValue: "def" })),
    ).toEqual({ ok: false, reason: "mismatch" });
  });

  it("fails on length mismatch (no throw)", () => {
    expect(
      checkCsrf(makeReq({ cookieValue: "abc", headerValue: "abcd" })),
    ).toEqual({ ok: false, reason: "mismatch" });
  });
});
