// Tests for the platform outreach unsubscribe token. Stub getLinkHmacKey
// so tests don't need RESUPPLY_LINK_HMAC_KEY in env; sign + verify share
// the same mocked key so round-trips work.

import { createHmac } from "node:crypto";

import { describe, it, expect, vi } from "vitest";

const TEST_KEY = Buffer.from("test-platform-unsub-hmac-key-0123456789", "utf8");

vi.mock("@workspace/resupply-secrets", () => ({
  getLinkHmacKey: () => TEST_KEY,
}));

// Mint a VALIDLY-SIGNED token with an arbitrary scope prefix, using the
// same encoding + key as the real signer — so we can prove the verifier
// rejects a correctly-signed token from another scope (replay defense),
// not merely a tampered/garbage one.
function signWithPrefix(prefix: string, id: string): string {
  const expiresSec = Math.floor(Date.now() / 1000) + 3600;
  const payload = `${prefix}|${id}|${expiresSec}`;
  const enc = (b: Buffer) =>
    b
      .toString("base64")
      .replaceAll("+", "-")
      .replaceAll("/", "_")
      .replaceAll("=", "");
  const payloadEncoded = enc(Buffer.from(payload, "utf8"));
  const sig = createHmac("sha256", TEST_KEY)
    .update(payloadEncoded, "utf8")
    .digest();
  return `${payloadEncoded}.${enc(sig)}`;
}

import {
  signPlatformUnsubscribeToken,
  verifyPlatformUnsubscribeToken,
  PLATFORM_UNSUBSCRIBE_TTL_MS,
} from "./unsubscribe-token";

describe("platform unsubscribe token", () => {
  it("round-trips a contact id", () => {
    const token = signPlatformUnsubscribeToken("contact-abc");
    expect(verifyPlatformUnsubscribeToken(token)).toEqual({
      valid: true,
      contactId: "contact-abc",
    });
  });

  it("rejects a tampered payload", () => {
    const token = signPlatformUnsubscribeToken("contact-abc");
    const [payload, sig] = token.split(".");
    // Flip the payload but keep the original signature.
    const forged = `${payload}x.${sig}`;
    expect(verifyPlatformUnsubscribeToken(forged).valid).toBe(false);
  });

  it("rejects an expired token", () => {
    const past = new Date(Date.now() - PLATFORM_UNSUBSCRIBE_TTL_MS - 1000);
    const token = signPlatformUnsubscribeToken("contact-abc", past);
    const v = verifyPlatformUnsubscribeToken(token);
    expect(v).toEqual({ valid: false, reason: "expired" });
  });

  it("rejects malformed input", () => {
    expect(verifyPlatformUnsubscribeToken("").valid).toBe(false);
    expect(verifyPlatformUnsubscribeToken("no-dot").valid).toBe(false);
  });

  it("rejects a validly-signed token from another scope (prefix-bound)", () => {
    // A token with a correct signature but a non-"pu" prefix (e.g. the
    // fitter-invite "fi" scope) must be rejected — guards against
    // cross-scope replay of a leaked-but-valid token.
    const fitterScoped = signWithPrefix("fi", "contact-abc");
    expect(verifyPlatformUnsubscribeToken(fitterScoped)).toEqual({
      valid: false,
      reason: "malformed",
    });
    // Sanity: the SAME encoding with the correct "pu" prefix IS accepted,
    // proving the rejection above is due to the prefix, not the encoding.
    expect(
      verifyPlatformUnsubscribeToken(signWithPrefix("pu", "contact-abc")),
    ).toEqual({ valid: true, contactId: "contact-abc" });
  });
});
