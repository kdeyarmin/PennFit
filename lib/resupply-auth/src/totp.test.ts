// RFC 6238 test vectors + edge-case tests for the inline TOTP helper.
//
// The TOTP spec's test vectors use an 8-digit code and SHA-1/256/512
// variants of HMAC. Our helper is SHA-1 + 6 digits (the
// authenticator-app default). To exercise the math against the
// canonical reference we test the underlying HOTP primitive
// (RFC 4226) which TOTP wraps — same HMAC kernel, no time math —
// then layer TOTP-specific tests (clock skew, replay rejection)
// on top.

import { describe, it, expect } from "vitest";

import {
  TOTP_STEP_SECONDS,
  base32Decode,
  base32Encode,
  buildOtpauthUri,
  generateBase32Secret,
  hotpCode,
  verifyTotpCode,
} from "./totp";

describe("hotpCode — RFC 4226 §5 test vectors", () => {
  // RFC 4226 Appendix D — secret "12345678901234567890" (ASCII).
  // Expected 6-digit codes for counters 0..9.
  const ASCII_SECRET = Buffer.from("12345678901234567890", "ascii");
  const RFC_4226_VECTORS = [
    { counter: 0, code: "755224" },
    { counter: 1, code: "287082" },
    { counter: 2, code: "359152" },
    { counter: 3, code: "969429" },
    { counter: 4, code: "338314" },
    { counter: 5, code: "254676" },
    { counter: 6, code: "287922" },
    { counter: 7, code: "162583" },
    { counter: 8, code: "399871" },
    { counter: 9, code: "520489" },
  ];

  for (const v of RFC_4226_VECTORS) {
    it(`counter=${v.counter} → ${v.code}`, () => {
      expect(hotpCode(ASCII_SECRET, v.counter)).toBe(v.code);
    });
  }
});

describe("verifyTotpCode", () => {
  const SECRET_BASE32 = base32Encode(
    Buffer.from("12345678901234567890", "ascii"),
  );

  // Pick a known instant. nowMs / 1000 / 30 = counter 1000 means
  // unix_seconds = 30_000.
  const NOW_AT_COUNTER_1000 = 30_000 * 1000;
  const expectedAt1000 = hotpCode(
    Buffer.from("12345678901234567890", "ascii"),
    1000,
  );

  it("accepts the current-window code", () => {
    const r = verifyTotpCode(SECRET_BASE32, expectedAt1000, {
      nowMs: NOW_AT_COUNTER_1000,
    });
    expect(r.ok).toBe(true);
    expect(r.counter).toBe(1000);
  });

  it("accepts a code from one step ago (clock skew)", () => {
    const expectedAt999 = hotpCode(
      Buffer.from("12345678901234567890", "ascii"),
      999,
    );
    const r = verifyTotpCode(SECRET_BASE32, expectedAt999, {
      nowMs: NOW_AT_COUNTER_1000,
      window: 1,
    });
    expect(r.ok).toBe(true);
    expect(r.counter).toBe(999);
  });

  it("accepts a code from one step in the future (clock skew)", () => {
    const expectedAt1001 = hotpCode(
      Buffer.from("12345678901234567890", "ascii"),
      1001,
    );
    const r = verifyTotpCode(SECRET_BASE32, expectedAt1001, {
      nowMs: NOW_AT_COUNTER_1000,
      window: 1,
    });
    expect(r.ok).toBe(true);
    expect(r.counter).toBe(1001);
  });

  it("rejects a code from outside the ± window", () => {
    const expectedAt998 = hotpCode(
      Buffer.from("12345678901234567890", "ascii"),
      998,
    );
    const r = verifyTotpCode(SECRET_BASE32, expectedAt998, {
      nowMs: NOW_AT_COUNTER_1000,
      window: 1,
    });
    expect(r.ok).toBe(false);
    expect(r.counter).toBeNull();
  });

  it("rejects a replay (counter <= minCounter)", () => {
    // Same code that worked above; but with minCounter=1000 the
    // verify must refuse because the matched counter is exactly
    // the previously-used one.
    const r = verifyTotpCode(SECRET_BASE32, expectedAt1000, {
      nowMs: NOW_AT_COUNTER_1000,
      minCounter: 1000,
    });
    expect(r.ok).toBe(false);
  });

  it("accepts a future code after minCounter", () => {
    const expectedAt1001 = hotpCode(
      Buffer.from("12345678901234567890", "ascii"),
      1001,
    );
    const r = verifyTotpCode(SECRET_BASE32, expectedAt1001, {
      // 1001 falls in window [999..1001] from baseCounter=1000.
      nowMs: NOW_AT_COUNTER_1000,
      window: 1,
      minCounter: 1000,
    });
    expect(r.ok).toBe(true);
    expect(r.counter).toBe(1001);
  });

  it("rejects malformed codes", () => {
    expect(verifyTotpCode(SECRET_BASE32, "").ok).toBe(false);
    expect(verifyTotpCode(SECRET_BASE32, "abcdef").ok).toBe(false);
    expect(verifyTotpCode(SECRET_BASE32, "12345").ok).toBe(false); // 5 digits
    expect(verifyTotpCode(SECRET_BASE32, "1234567").ok).toBe(false); // 7 digits
  });

  it("rejects when the base32 secret is malformed", () => {
    const r = verifyTotpCode("not_valid_base32!!!", "123456", {
      nowMs: NOW_AT_COUNTER_1000,
    });
    expect(r.ok).toBe(false);
  });

  it("TOTP_STEP_SECONDS is 30", () => {
    expect(TOTP_STEP_SECONDS).toBe(30);
  });
});

describe("generateBase32Secret + base32 round-trip", () => {
  it("returns 32 chars for the default 20-byte secret", () => {
    // 20 bytes × 8 bits = 160 bits = 32 base32 chars (no padding).
    expect(generateBase32Secret().length).toBe(32);
  });

  it("returns characters from the RFC 4648 alphabet", () => {
    const s = generateBase32Secret();
    expect(/^[A-Z2-7]+$/.test(s)).toBe(true);
  });

  it("round-trips encode→decode losslessly", () => {
    // Pin against a known input/output.
    const input = Buffer.from("12345678901234567890", "ascii");
    const encoded = base32Encode(input);
    const decoded = base32Decode(encoded);
    expect(decoded.equals(input)).toBe(true);
  });

  it("decodes case-insensitively + tolerates whitespace + padding", () => {
    const input = Buffer.from("hi there", "ascii");
    const encoded = base32Encode(input);
    const lowered = encoded.toLowerCase();
    const padded = encoded + "===";
    const spaced = encoded.split("").join(" ");
    expect(base32Decode(lowered).equals(input)).toBe(true);
    expect(base32Decode(padded).equals(input)).toBe(true);
    expect(base32Decode(spaced).equals(input)).toBe(true);
  });

  it("rejects byteLength outside [10, 64]", () => {
    expect(() => generateBase32Secret(9)).toThrow(RangeError);
    expect(() => generateBase32Secret(65)).toThrow(RangeError);
    expect(() => generateBase32Secret(20)).not.toThrow();
  });
});

describe("buildOtpauthUri", () => {
  it("emits the canonical otpauth:// shape", () => {
    const uri = buildOtpauthUri({
      label: "csr@penn.example",
      issuer: "PennPaps",
      secret: "JBSWY3DPEHPK3PXP",
    });
    // Standard authenticator apps require: issuer in the label
    // segment AND in the query, algorithm=SHA1, digits=6, period=30.
    expect(
      uri.startsWith("otpauth://totp/PennPaps%3Acsr%40penn.example?"),
    ).toBe(true);
    expect(uri).toContain("secret=JBSWY3DPEHPK3PXP");
    expect(uri).toContain("issuer=PennPaps");
    expect(uri).toContain("algorithm=SHA1");
    expect(uri).toContain("digits=6");
    expect(uri).toContain("period=30");
  });
});
