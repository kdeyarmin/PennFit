import { describe, expect, it } from "vitest";

import {
  signParachutePayload,
  verifyParachuteSignature,
} from "./verify-signature";

const SECRET = "shhh-this-is-a-test-secret";
const BODY = `{"event":"order.created","id":"PCH-123"}`;

describe("verifyParachuteSignature", () => {
  it("accepts a well-formed signature within tolerance", () => {
    const now = 1_800_000_000;
    const header = signParachutePayload(BODY, SECRET, now);
    expect(
      verifyParachuteSignature({
        rawBody: BODY,
        signatureHeader: header,
        signingSecret: SECRET,
        nowSeconds: now + 30,
      }),
    ).toEqual({ ok: true });
  });

  it("rejects a missing header", () => {
    expect(
      verifyParachuteSignature({
        rawBody: BODY,
        signatureHeader: null,
        signingSecret: SECRET,
      }),
    ).toEqual({ ok: false, reason: "missing_header" });
    expect(
      verifyParachuteSignature({
        rawBody: BODY,
        signatureHeader: "",
        signingSecret: SECRET,
      }),
    ).toEqual({ ok: false, reason: "missing_header" });
  });

  it("rejects a header missing t or v1", () => {
    expect(
      verifyParachuteSignature({
        rawBody: BODY,
        signatureHeader: "v1=abc",
        signingSecret: SECRET,
      }),
    ).toEqual({ ok: false, reason: "malformed_header" });
    expect(
      verifyParachuteSignature({
        rawBody: BODY,
        signatureHeader: "t=1700000000",
        signingSecret: SECRET,
      }),
    ).toEqual({ ok: false, reason: "malformed_header" });
  });

  it("rejects a v1 value that is not 64 hex chars", () => {
    expect(
      verifyParachuteSignature({
        rawBody: BODY,
        signatureHeader: "t=1700000000,v1=not-hex",
        signingSecret: SECRET,
      }),
    ).toEqual({ ok: false, reason: "malformed_header" });
  });

  it("rejects a stale timestamp outside tolerance", () => {
    const now = 1_800_000_000;
    const header = signParachutePayload(BODY, SECRET, now);
    expect(
      verifyParachuteSignature({
        rawBody: BODY,
        signatureHeader: header,
        signingSecret: SECRET,
        nowSeconds: now + 301,
      }),
    ).toEqual({ ok: false, reason: "stale_timestamp" });
  });

  it("rejects a payload tampered after signing", () => {
    const now = 1_800_000_000;
    const header = signParachutePayload(BODY, SECRET, now);
    expect(
      verifyParachuteSignature({
        rawBody: BODY + "x",
        signatureHeader: header,
        signingSecret: SECRET,
        nowSeconds: now,
      }),
    ).toEqual({ ok: false, reason: "bad_signature" });
  });

  it("rejects a signature produced with a different secret", () => {
    const now = 1_800_000_000;
    const header = signParachutePayload(BODY, "wrong-secret", now);
    expect(
      verifyParachuteSignature({
        rawBody: BODY,
        signatureHeader: header,
        signingSecret: SECRET,
        nowSeconds: now,
      }),
    ).toEqual({ ok: false, reason: "bad_signature" });
  });

  it("accepts a future timestamp within tolerance (clock skew)", () => {
    const now = 1_800_000_000;
    const header = signParachutePayload(BODY, SECRET, now + 60);
    expect(
      verifyParachuteSignature({
        rawBody: BODY,
        signatureHeader: header,
        signingSecret: SECRET,
        nowSeconds: now,
      }),
    ).toEqual({ ok: true });
  });
});
