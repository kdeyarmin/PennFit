import { createHmac } from "node:crypto";
import { describe, expect, it, vi } from "vitest";

import {
  requireTwilioSignature,
  validateTwilioSignature,
  type SignatureNextFunction,
  type SignatureRequestLike,
  type SignatureResponseLike,
} from "./signature";

// Compute the canonical Twilio signature for a fixture so each test
// asserts on a value it built itself rather than a hard-coded magic
// string. The algorithm under test is the same — we're checking
// "validate accepts what the spec says is valid", which catches a
// regression in either direction (overly permissive OR overly strict).
function computeSig(
  authToken: string,
  url: string,
  params: Record<string, string>,
): string {
  const sortedKeys = Object.keys(params).sort();
  let canonical = url;
  for (const k of sortedKeys) canonical += k + (params[k] ?? "");
  return createHmac("sha1", authToken)
    .update(canonical, "utf8")
    .digest("base64");
}

const TOKEN = "test-auth-token-1234567890";
const URL = "https://example.com/resupply-api/voice/twiml-connect";
const PARAMS = {
  CallSid: "CA00000000000000000000000000000001",
  From: "+12155551212",
  To: "+12158675309",
  AccountSid: "ACzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz",
};

describe("validateTwilioSignature", () => {
  it("accepts a known-good signature computed per the Twilio spec", () => {
    const sig = computeSig(TOKEN, URL, PARAMS);
    const ok = validateTwilioSignature({
      authToken: TOKEN,
      url: URL,
      params: PARAMS,
      signatureHeader: sig,
    });
    expect(ok).toBe(true);
  });

  it("rejects a tampered URL (path-based attack)", () => {
    const sig = computeSig(TOKEN, URL, PARAMS);
    const ok = validateTwilioSignature({
      authToken: TOKEN,
      url: "https://example.com/resupply-api/voice/twiml-connect-attacker",
      params: PARAMS,
      signatureHeader: sig,
    });
    expect(ok).toBe(false);
  });

  it("rejects a tampered param (parameter-injection attack)", () => {
    const sig = computeSig(TOKEN, URL, PARAMS);
    const ok = validateTwilioSignature({
      authToken: TOKEN,
      url: URL,
      params: { ...PARAMS, To: "+19999999999" },
      signatureHeader: sig,
    });
    expect(ok).toBe(false);
  });

  it("rejects when authToken is wrong", () => {
    const sig = computeSig(TOKEN, URL, PARAMS);
    const ok = validateTwilioSignature({
      authToken: "rotated-fake-token",
      url: URL,
      params: PARAMS,
      signatureHeader: sig,
    });
    expect(ok).toBe(false);
  });

  it("rejects when authToken is empty (env unset)", () => {
    const sig = computeSig(TOKEN, URL, PARAMS);
    const ok = validateTwilioSignature({
      authToken: "",
      url: URL,
      params: PARAMS,
      signatureHeader: sig,
    });
    expect(ok).toBe(false);
  });

  it("rejects when the signature header is missing entirely", () => {
    const ok = validateTwilioSignature({
      authToken: TOKEN,
      url: URL,
      params: PARAMS,
      signatureHeader: undefined,
    });
    expect(ok).toBe(false);
  });

  it("rejects when the signature is the empty string", () => {
    const ok = validateTwilioSignature({
      authToken: TOKEN,
      url: URL,
      params: PARAMS,
      signatureHeader: "",
    });
    expect(ok).toBe(false);
  });

  it("rejects when the signature is the wrong LENGTH (length-based shortcut works)", () => {
    // A short string is a different length than a base64-SHA1 digest;
    // this exercises the length pre-check that lets timingSafeEqual
    // be called safely.
    const ok = validateTwilioSignature({
      authToken: TOKEN,
      url: URL,
      params: PARAMS,
      signatureHeader: "abc",
    });
    expect(ok).toBe(false);
  });

  it("matches when params are presented in a different insertion order (sorting is by key, not order)", () => {
    const reordered = {
      To: PARAMS.To,
      AccountSid: PARAMS.AccountSid,
      From: PARAMS.From,
      CallSid: PARAMS.CallSid,
    };
    const sig = computeSig(TOKEN, URL, PARAMS);
    expect(
      validateTwilioSignature({
        authToken: TOKEN,
        url: URL,
        params: reordered,
        signatureHeader: sig,
      }),
    ).toBe(true);
  });
});

// Minimal req/res fakes so we can drive the middleware without booting
// Express. Keeping them in this file avoids pulling supertest/express
// into the resupply-telecom devDeps just for one path. The middleware
// only uses `req.header()`, `req.body`, `res.status().type().send()`,
// and the `next()` callback — everything else can be undefined.
interface FakeResHandle {
  res: SignatureResponseLike;
  readonly status: number | undefined;
  readonly body: string | undefined;
}

function fakeRes(): FakeResHandle {
  const state: { status: number | undefined; body: string | undefined } = {
    status: undefined,
    body: undefined,
  };
  const res: SignatureResponseLike = {
    status(code: number) {
      state.status = code;
      return res;
    },
    type() {
      return res;
    },
    send(body: string) {
      state.body = body;
      return res;
    },
  };
  return {
    res,
    get status() {
      return state.status;
    },
    get body() {
      return state.body;
    },
  };
}

function fakeReq(opts: {
  signature?: string;
  body?: Record<string, unknown>;
}): SignatureRequestLike {
  return {
    header: (name: string) =>
      name.toLowerCase() === "x-twilio-signature" ? opts.signature : undefined,
    body: opts.body ?? {},
  };
}

describe("requireTwilioSignature middleware", () => {
  it("rejects with reason='auth_token_unset' if env is not configured", () => {
    const onReject = vi.fn();
    const next = vi.fn();
    const mw = requireTwilioSignature({
      getAuthToken: () => undefined,
      buildPublicUrl: () => URL,
      onReject,
    });
    const { res } = fakeRes();
    mw(fakeReq({ body: PARAMS }), res, next as SignatureNextFunction);
    expect(next).not.toHaveBeenCalled();
    expect(onReject).toHaveBeenCalledTimes(1);
    expect(onReject.mock.calls[0]![2]).toBe("auth_token_unset");
  });

  it("rejects with reason='signature_mismatch' on a forged signature", () => {
    const onReject = vi.fn();
    const next = vi.fn();
    const mw = requireTwilioSignature({
      getAuthToken: () => TOKEN,
      buildPublicUrl: () => URL,
      onReject,
    });
    const { res } = fakeRes();
    mw(
      fakeReq({ signature: "totally-bogus", body: PARAMS }),
      res,
      next as SignatureNextFunction,
    );
    expect(next).not.toHaveBeenCalled();
    expect(onReject.mock.calls[0]![2]).toBe("signature_mismatch");
  });

  it("calls next() on a correctly-signed request", () => {
    const sig = computeSig(TOKEN, URL, PARAMS);
    const onReject = vi.fn();
    const next = vi.fn();
    const mw = requireTwilioSignature({
      getAuthToken: () => TOKEN,
      buildPublicUrl: () => URL,
      onReject,
    });
    const { res } = fakeRes();
    mw(
      fakeReq({ signature: sig, body: PARAMS }),
      res,
      next as SignatureNextFunction,
    );
    expect(next).toHaveBeenCalledTimes(1);
    expect(onReject).not.toHaveBeenCalled();
  });

  it("default onReject (no override) sends a 403", () => {
    const next = vi.fn();
    const mw = requireTwilioSignature({
      getAuthToken: () => TOKEN,
      buildPublicUrl: () => URL,
    });
    const captured = fakeRes();
    mw(
      fakeReq({ signature: "bad", body: PARAMS }),
      captured.res,
      next as SignatureNextFunction,
    );
    expect(next).not.toHaveBeenCalled();
    expect(captured.status).toBe(403);
    expect(captured.body).toContain("Forbidden");
  });

  it("fails closed when a body param is non-string (e.g. a repeated/array key) rather than dropping it", () => {
    // Twilio only ever sends flat string form fields. express/qs turns a
    // repeated key (a=1&a=2) into an array — a parser anomaly or a forged
    // request. The middleware used to silently drop such values, which
    // computed the HMAC over a DIFFERENT param set than Twilio signed; it
    // now fails closed so the validated canonical string is always exact.
    const sig = computeSig(TOKEN, URL, PARAMS);
    const next = vi.fn();
    const onReject = vi.fn();
    const mw = requireTwilioSignature({
      getAuthToken: () => TOKEN,
      buildPublicUrl: () => URL,
      onReject,
    });
    const { res } = fakeRes();
    mw(
      fakeReq({
        signature: sig,
        body: { ...PARAMS, smuggled: ["a", "b"] as unknown as string },
      }),
      res,
      next as SignatureNextFunction,
    );
    expect(next).not.toHaveBeenCalled();
    expect(onReject).toHaveBeenCalledTimes(1);
    expect(onReject.mock.calls[0]![2]).toBe("non_string_param");
  });
});
