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

// ---------------------------------------------------------------------------
// PR change: dynamic PAD width (Math.max(128, len_cookie, len_header))
// ---------------------------------------------------------------------------
// Before the PR, both sides were padded to exactly 128 bytes. A token longer
// than 128 bytes would have been silently truncated so that, e.g., two
// distinct tokens that shared a 128-byte prefix were indistinguishable to
// timingSafeEqual. The PR widens the pad to max(128, cookie_bytes,
// header_bytes). The tests below verify:
//   1. Tokens that are exactly 128 bytes still work.
//   2. Tokens longer than 128 bytes are compared in full (no truncation match).
//   3. The length check uses byte length, not character count — relevant for
//      multibyte UTF-8 where character count < byte count.

describe("checkCsrf — dynamic PAD (PR change)", () => {
  it("accepts a token that is exactly 128 bytes long", () => {
    const token = "a".repeat(128);
    const r = makeReq({ cookieValue: token, headerValue: token });
    expect(checkCsrf(r)).toEqual({ ok: true });
  });

  it("accepts a token longer than 128 bytes when both sides match", () => {
    // 200 ASCII bytes — both sides identical, must pass.
    const token = "x".repeat(200);
    const r = makeReq({ cookieValue: token, headerValue: token });
    expect(checkCsrf(r)).toEqual({ ok: true });
  });

  it("rejects tokens > 128 bytes that share a 128-byte prefix but differ at byte 129", () => {
    // Before the PR fix the truncation-to-128 would make these two tokens
    // appear identical. The dynamic PAD prevents that.
    const base = "z".repeat(128);
    const cookie = base + "A";
    const header = base + "B";
    const r = makeReq({ cookieValue: cookie, headerValue: header });
    expect(checkCsrf(r)).toEqual({ ok: false, reason: "mismatch" });
  });

  it("rejects when the 129th byte differs even though the first 128 bytes match", () => {
    const shared = "q".repeat(128);
    const r = makeReq({
      cookieValue: shared + "X",
      headerValue: shared + "Y",
    });
    expect(checkCsrf(r)).toEqual({ ok: false, reason: "mismatch" });
  });

  it("uses byte length for the length check — multibyte chars make byte length > char length", () => {
    // The two-byte UTF-8 sequence \u00e9 ('é') has byte length 2 but char
    // length 1. A 64-char string of these is 128 bytes (passes the PAD floor)
    // and must be treated as equal to itself.
    const token = "\u00e9".repeat(64); // 64 chars, 128 bytes
    expect(
      checkCsrf(makeReq({ cookieValue: token, headerValue: token })),
    ).toEqual({
      ok: true,
    });
  });

  it("detects a length mismatch that only shows up in byte length, not char count", () => {
    // cookie:  64 × '\u00e9' = 128 bytes
    // header:  65 × '\u00e9' = 130 bytes
    // Byte lengths differ → length check fails → mismatch.
    const cookie = "\u00e9".repeat(64);
    const header = "\u00e9".repeat(65);
    expect(
      checkCsrf(makeReq({ cookieValue: cookie, headerValue: header })),
    ).toEqual({ ok: false, reason: "mismatch" });
  });

  it("still rejects a mismatched short token (< 128 bytes) — regression guard", () => {
    // Ensures the dynamic PAD floor of 128 doesn't break the common-case
    // short-token path that the original tests already validated.
    expect(
      checkCsrf(
        makeReq({ cookieValue: "short-token-1", headerValue: "short-token-2" }),
      ),
    ).toEqual({ ok: false, reason: "mismatch" });
  });
});
