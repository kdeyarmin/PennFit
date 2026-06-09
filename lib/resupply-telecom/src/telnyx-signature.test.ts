// Unit tests for Telnyx Ed25519 webhook signature validation.
//
// We generate a real Ed25519 keypair, sign `${timestamp}|${body}` the
// way Telnyx does, and assert the validator accepts genuine signatures
// and rejects everything else (wrong key, tampered body, tampered
// timestamp, bad base64, missing headers, stale timestamp).

import { describe, it, expect, vi } from "vitest";
import {
  generateKeyPairSync,
  sign as cryptoSign,
  type KeyObject,
} from "node:crypto";

import {
  validateTelnyxSignature,
  requireTelnyxSignature,
  type TelnyxSignatureRequestLike,
} from "./telnyx-signature";

/** Export a public KeyObject as the raw 32-byte base64 Telnyx hands out. */
function publicKeyBase64(pub: KeyObject): string {
  const der = pub.export({ type: "spki", format: "der" });
  // The raw 32-byte Ed25519 key is the SPKI DER tail.
  return Buffer.from(der.subarray(der.length - 32)).toString("base64");
}

function signTelnyx(priv: KeyObject, timestamp: string, body: string): string {
  const message = Buffer.from(`${timestamp}|${body}`, "utf8");
  return cryptoSign(null, message, priv).toString("base64");
}

const { publicKey, privateKey } = generateKeyPairSync("ed25519");
const PUBLIC_B64 = publicKeyBase64(publicKey);

describe("validateTelnyxSignature", () => {
  const body = JSON.stringify({ data: { event_type: "fax.delivered" } });
  const timestamp = "1700000000";

  it("accepts a genuine signature", () => {
    const sig = signTelnyx(privateKey, timestamp, body);
    expect(
      validateTelnyxSignature({
        publicKey: PUBLIC_B64,
        payload: body,
        signatureHeader: sig,
        timestampHeader: timestamp,
      }),
    ).toBe(true);
  });

  it("accepts when payload is passed as a Buffer", () => {
    const sig = signTelnyx(privateKey, timestamp, body);
    expect(
      validateTelnyxSignature({
        publicKey: PUBLIC_B64,
        payload: Buffer.from(body, "utf8"),
        signatureHeader: sig,
        timestampHeader: timestamp,
      }),
    ).toBe(true);
  });

  it("rejects a tampered body", () => {
    const sig = signTelnyx(privateKey, timestamp, body);
    expect(
      validateTelnyxSignature({
        publicKey: PUBLIC_B64,
        payload: body + " ",
        signatureHeader: sig,
        timestampHeader: timestamp,
      }),
    ).toBe(false);
  });

  it("rejects a tampered timestamp (timestamp is part of the signed message)", () => {
    const sig = signTelnyx(privateKey, timestamp, body);
    expect(
      validateTelnyxSignature({
        publicKey: PUBLIC_B64,
        payload: body,
        signatureHeader: sig,
        timestampHeader: "1700000001",
      }),
    ).toBe(false);
  });

  it("rejects a signature from a different key", () => {
    const other = generateKeyPairSync("ed25519");
    const sig = signTelnyx(other.privateKey, timestamp, body);
    expect(
      validateTelnyxSignature({
        publicKey: PUBLIC_B64,
        payload: body,
        signatureHeader: sig,
        timestampHeader: timestamp,
      }),
    ).toBe(false);
  });

  it("rejects when the signature header is missing", () => {
    expect(
      validateTelnyxSignature({
        publicKey: PUBLIC_B64,
        payload: body,
        signatureHeader: undefined,
        timestampHeader: timestamp,
      }),
    ).toBe(false);
  });

  it("rejects when the public key is the wrong length", () => {
    const sig = signTelnyx(privateKey, timestamp, body);
    expect(
      validateTelnyxSignature({
        publicKey: Buffer.from("too short").toString("base64"),
        payload: body,
        signatureHeader: sig,
        timestampHeader: timestamp,
      }),
    ).toBe(false);
  });

  it("rejects a non-64-byte signature", () => {
    expect(
      validateTelnyxSignature({
        publicKey: PUBLIC_B64,
        payload: body,
        signatureHeader: Buffer.from("nope").toString("base64"),
        timestampHeader: timestamp,
      }),
    ).toBe(false);
  });

  it("enforces the freshness window when toleranceSeconds is set", () => {
    const sig = signTelnyx(privateKey, timestamp, body);
    // now is 10 min after the timestamp; tolerance 300s → reject.
    expect(
      validateTelnyxSignature({
        publicKey: PUBLIC_B64,
        payload: body,
        signatureHeader: sig,
        timestampHeader: timestamp,
        toleranceSeconds: 300,
        nowSeconds: Number(timestamp) + 600,
      }),
    ).toBe(false);
    // within the window → accept.
    expect(
      validateTelnyxSignature({
        publicKey: PUBLIC_B64,
        payload: body,
        signatureHeader: sig,
        timestampHeader: timestamp,
        toleranceSeconds: 300,
        nowSeconds: Number(timestamp) + 60,
      }),
    ).toBe(true);
  });
});

describe("requireTelnyxSignature middleware", () => {
  function makeRes() {
    const res = {
      statusCode: 0,
      body: "",
      status(code: number) {
        this.statusCode = code;
        return this;
      },
      type() {
        return this;
      },
      send(b: string) {
        this.body = b;
        return this;
      },
    };
    return res;
  }

  const bodyObj = {
    data: { event_type: "fax.received", payload: { fax_id: "f1" } },
  };
  const bodyStr = JSON.stringify(bodyObj);
  const timestamp = "1700000000";

  function makeReq(
    rawBody: Buffer | undefined,
    sig: string | undefined,
    ts: string | undefined,
  ): TelnyxSignatureRequestLike {
    return {
      body: rawBody,
      header(name: string) {
        const n = name.toLowerCase();
        if (n === "telnyx-signature-ed25519") return sig;
        if (n === "telnyx-timestamp") return ts;
        return undefined;
      },
    };
  }

  it("calls next() and replaces req.body with parsed JSON on a valid signature", () => {
    const sig = signTelnyx(privateKey, timestamp, bodyStr);
    const req = makeReq(Buffer.from(bodyStr, "utf8"), sig, timestamp);
    const res = makeRes();
    const next = vi.fn();
    requireTelnyxSignature({ getPublicKey: () => PUBLIC_B64 })(
      req,
      res as never,
      next,
    );
    expect(next).toHaveBeenCalledOnce();
    expect(req.body).toEqual(bodyObj);
  });

  it("403s when the public key is unset", () => {
    const req = makeReq(Buffer.from(bodyStr), "sig", timestamp);
    const res = makeRes();
    const next = vi.fn();
    requireTelnyxSignature({ getPublicKey: () => undefined })(
      req,
      res as never,
      next,
    );
    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(403);
  });

  it("403s when there is no raw body to verify", () => {
    const req = makeReq(undefined, "sig", timestamp);
    const res = makeRes();
    const next = vi.fn();
    requireTelnyxSignature({ getPublicKey: () => PUBLIC_B64 })(
      req,
      res as never,
      next,
    );
    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(403);
  });

  it("403s on a bad signature", () => {
    const req = makeReq(Buffer.from(bodyStr), "AAAA", timestamp);
    const res = makeRes();
    const next = vi.fn();
    requireTelnyxSignature({ getPublicKey: () => PUBLIC_B64 })(
      req,
      res as never,
      next,
    );
    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(403);
  });
});
