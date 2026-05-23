import { generateKeyPairSync, createSign } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  requireSendgridSignature,
  validateSendgridSignature,
  SENDGRID_SIGNATURE_HEADER,
  SENDGRID_TIMESTAMP_HEADER,
} from "./signature";

/**
 * Generate a fresh ECDSA P-256 key pair. SendGrid uses prime256v1
 * (a.k.a. secp256r1 / P-256) so the verifier in production parses
 * exactly the format we mint here.
 */
function freshKeyPair(): {
  publicKeyBase64: string;
  privateKeyPem: string;
} {
  const { publicKey, privateKey } = generateKeyPairSync("ec", {
    namedCurve: "prime256v1",
  });
  const publicKeyDer = publicKey.export({ format: "der", type: "spki" });
  return {
    publicKeyBase64: publicKeyDer.toString("base64"),
    privateKeyPem: privateKey
      .export({ format: "pem", type: "pkcs8" })
      .toString(),
  };
}

function signBody(privateKeyPem: string, timestamp: string, body: string) {
  const signer = createSign("sha256");
  signer.update(timestamp + body);
  signer.end();
  return signer.sign(privateKeyPem).toString("base64");
}

// Anchor every test on the same fixed unix-seconds timestamp by
// passing it as BOTH the header value AND `nowSeconds` to
// validateSendgridSignature. Without nowSeconds the validator would
// compare against real Date.now() and the freshness window check
// would reject the (now-stale) 2024 fixture.
const FIXED_TS = "1719000000";
const FIXED_TS_NUM = Number.parseInt(FIXED_TS, 10);

describe("validateSendgridSignature", () => {
  it("returns true for a freshly-signed body", () => {
    const { publicKeyBase64, privateKeyPem } = freshKeyPair();
    const body = JSON.stringify([{ event: "delivered", email: "p@e.com" }]);
    const sig = signBody(privateKeyPem, FIXED_TS, body);

    const ok = validateSendgridSignature({
      rawBody: body,
      signatureHeader: sig,
      timestampHeader: FIXED_TS,
      publicKeyBase64,
      nowSeconds: FIXED_TS_NUM,
    });
    expect(ok).toBe(true);
  });

  it("returns true when rawBody is a Buffer", () => {
    const { publicKeyBase64, privateKeyPem } = freshKeyPair();
    const body = JSON.stringify([{ event: "delivered" }]);
    const sig = signBody(privateKeyPem, FIXED_TS, body);

    const ok = validateSendgridSignature({
      rawBody: Buffer.from(body, "utf8"),
      signatureHeader: sig,
      timestampHeader: FIXED_TS,
      publicKeyBase64,
      nowSeconds: FIXED_TS_NUM,
    });
    expect(ok).toBe(true);
  });

  it("returns false when the body has been tampered", () => {
    const { publicKeyBase64, privateKeyPem } = freshKeyPair();
    const body = JSON.stringify([{ event: "delivered", email: "p@e.com" }]);
    const sig = signBody(privateKeyPem, FIXED_TS, body);

    const tamperedBody = body.replace("delivered", "bounce");
    const ok = validateSendgridSignature({
      rawBody: tamperedBody,
      signatureHeader: sig,
      timestampHeader: FIXED_TS,
      publicKeyBase64,
      nowSeconds: FIXED_TS_NUM,
    });
    expect(ok).toBe(false);
  });

  it("returns false when the timestamp has been tampered", () => {
    const { publicKeyBase64, privateKeyPem } = freshKeyPair();
    const body = "[]";
    const sig = signBody(privateKeyPem, FIXED_TS, body);

    const ok = validateSendgridSignature({
      rawBody: body,
      signatureHeader: sig,
      timestampHeader: "1719000001",
      publicKeyBase64,
      nowSeconds: FIXED_TS_NUM,
    });
    expect(ok).toBe(false);
  });

  it("returns false when signed with a different key", () => {
    const { publicKeyBase64 } = freshKeyPair();
    const { privateKeyPem: attackerKey } = freshKeyPair();
    const body = "[]";
    const badSig = signBody(attackerKey, FIXED_TS, body);

    const ok = validateSendgridSignature({
      rawBody: body,
      signatureHeader: badSig,
      timestampHeader: FIXED_TS,
      publicKeyBase64,
      nowSeconds: FIXED_TS_NUM,
    });
    expect(ok).toBe(false);
  });

  it("returns false when the signature header is missing", () => {
    const { publicKeyBase64 } = freshKeyPair();
    const ok = validateSendgridSignature({
      rawBody: "[]",
      signatureHeader: undefined,
      timestampHeader: FIXED_TS,
      publicKeyBase64,
      nowSeconds: FIXED_TS_NUM,
    });
    expect(ok).toBe(false);
  });

  it("returns false when the timestamp header is missing", () => {
    const { publicKeyBase64, privateKeyPem } = freshKeyPair();
    const sig = signBody(privateKeyPem, FIXED_TS, "[]");
    const ok = validateSendgridSignature({
      rawBody: "[]",
      signatureHeader: sig,
      timestampHeader: undefined,
      publicKeyBase64,
      nowSeconds: FIXED_TS_NUM,
    });
    expect(ok).toBe(false);
  });

  it("returns false when public key is junk", () => {
    const { privateKeyPem } = freshKeyPair();
    const sig = signBody(privateKeyPem, FIXED_TS, "[]");
    const ok = validateSendgridSignature({
      rawBody: "[]",
      signatureHeader: sig,
      timestampHeader: FIXED_TS,
      publicKeyBase64: "not-a-real-key",
      nowSeconds: FIXED_TS_NUM,
    });
    expect(ok).toBe(false);
  });

  it("returns false when signature is junk", () => {
    const { publicKeyBase64 } = freshKeyPair();
    const ok = validateSendgridSignature({
      rawBody: "[]",
      signatureHeader: "!!!not-base64!!!",
      timestampHeader: FIXED_TS,
      publicKeyBase64,
      nowSeconds: FIXED_TS_NUM,
    });
    expect(ok).toBe(false);
  });

  it("returns false when the timestamp is outside the freshness window", () => {
    // Pins the new replay-protection check: a payload signed 1 hour
    // before `nowSeconds` should be rejected even with a valid
    // signature, defending against indefinite replay of captured
    // event payloads.
    const { publicKeyBase64, privateKeyPem } = freshKeyPair();
    const oldTs = String(FIXED_TS_NUM - 3700);
    const body = "[]";
    const sig = signBody(privateKeyPem, oldTs, body);
    const ok = validateSendgridSignature({
      rawBody: body,
      signatureHeader: sig,
      timestampHeader: oldTs,
      publicKeyBase64,
      nowSeconds: FIXED_TS_NUM,
    });
    expect(ok).toBe(false);
  });

  it("throws when rawBody is null", () => {
    const { publicKeyBase64 } = freshKeyPair();
    expect(() =>
      validateSendgridSignature({
        rawBody: null as unknown as Buffer,
        signatureHeader: "x",
        timestampHeader: "1",
        publicKeyBase64,
      }),
    ).toThrow(/rawBody is required/);
  });
});

describe("requireSendgridSignature middleware", () => {
  let saved: string | undefined;
  beforeEach(() => {
    saved = process.env.SENDGRID_EVENT_WEBHOOK_PUBLIC_KEY;
    delete process.env.SENDGRID_EVENT_WEBHOOK_PUBLIC_KEY;
  });
  afterEach(() => {
    if (saved === undefined)
      delete process.env.SENDGRID_EVENT_WEBHOOK_PUBLIC_KEY;
    else process.env.SENDGRID_EVENT_WEBHOOK_PUBLIC_KEY = saved;
  });

  function fakeRes() {
    const res: {
      statusCode?: number;
      sent?: string;
      mime?: string;
      status: (code: number) => typeof res;
      type: (mime: string) => typeof res;
      send: (body: string) => typeof res;
    } = {
      status(code: number) {
        this.statusCode = code;
        return this;
      },
      type(mime: string) {
        this.mime = mime;
        return this;
      },
      send(body: string) {
        this.sent = body;
        return this;
      },
    };
    return res;
  }

  it("503s when public key is unset", () => {
    const mw = requireSendgridSignature();
    const next = vi.fn();
    const res = fakeRes();
    const req = {
      header: () => undefined,
      body: Buffer.from("[]"),
    };
    mw(req, res, next);
    expect(res.statusCode).toBe(503);
    expect(next).not.toHaveBeenCalled();
  });

  it("400s when raw body is missing", () => {
    const { publicKeyBase64 } = freshKeyPair();
    const mw = requireSendgridSignature({ publicKeyBase64 });
    const next = vi.fn();
    const res = fakeRes();
    const req = { header: () => undefined };
    mw(req, res, next);
    expect(res.statusCode).toBe(400);
  });

  it("401s when signature is bad", () => {
    const { publicKeyBase64 } = freshKeyPair();
    const mw = requireSendgridSignature({ publicKeyBase64 });
    const next = vi.fn();
    const res = fakeRes();
    const req = {
      header: (n: string) => {
        if (n === SENDGRID_SIGNATURE_HEADER) return "deadbeef";
        if (n === SENDGRID_TIMESTAMP_HEADER) return "1719000000";
        return undefined;
      },
      body: Buffer.from("[]"),
    };
    mw(req, res, next);
    expect(res.statusCode).toBe(401);
    expect(next).not.toHaveBeenCalled();
  });

  it("calls next() on a valid signature", () => {
    const { publicKeyBase64, privateKeyPem } = freshKeyPair();
    // Use a fresh timestamp inside the new replay-protection
    // freshness window — the middleware doesn't expose nowSeconds.
    const ts = String(Math.floor(Date.now() / 1000));
    const body = "[]";
    const sig = signBody(privateKeyPem, ts, body);

    const mw = requireSendgridSignature({ publicKeyBase64 });
    const next = vi.fn();
    const res = fakeRes();
    const req = {
      header: (n: string) => {
        if (n === SENDGRID_SIGNATURE_HEADER) return sig;
        if (n === SENDGRID_TIMESTAMP_HEADER) return ts;
        return undefined;
      },
      body: Buffer.from(body),
    };
    mw(req, res, next);
    expect(next).toHaveBeenCalledWith();
    expect(res.statusCode).toBeUndefined();
  });
});
