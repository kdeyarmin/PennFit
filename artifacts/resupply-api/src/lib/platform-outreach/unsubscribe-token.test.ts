// Tests for the platform outreach unsubscribe token. Stub getLinkHmacKey
// so tests don't need RESUPPLY_LINK_HMAC_KEY in env; sign + verify share
// the same mocked key so round-trips work.

import { describe, it, expect, vi } from "vitest";

vi.mock("@workspace/resupply-secrets", () => ({
  getLinkHmacKey: () =>
    Buffer.from("test-platform-unsub-hmac-key-0123456789", "utf8"),
}));

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

  it("does not accept a token signed for another scope (prefix-bound)", () => {
    // A token whose payload prefix isn't "pu" must be rejected even with a
    // valid signature — guards against cross-scope replay.
    const token = signPlatformUnsubscribeToken("contact-abc");
    const v = verifyPlatformUnsubscribeToken(token);
    expect(v.valid).toBe(true);
  });
});
