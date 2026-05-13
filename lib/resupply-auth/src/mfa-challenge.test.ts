// Tests for the MFA challenge-token helper.
//
// Goal: pin tamper-resistance + TTL + domain-separation properties
// so a future refactor can't quietly weaken them.

import { describe, it, expect } from "vitest";
import { randomBytes } from "node:crypto";

import {
  DEFAULT_CHALLENGE_TTL_SECONDS,
  mintMfaChallengeToken,
  verifyMfaChallengeToken,
} from "./mfa-challenge";

const KEY = randomBytes(32);

describe("mintMfaChallengeToken + verifyMfaChallengeToken", () => {
  it("round-trips uid + sets default TTL exp", () => {
    const nowMs = 1_700_000_000_000;
    const tok = mintMfaChallengeToken({
      uid: "user-abc",
      hmacKey: KEY,
      nowMs,
    });
    const verified = verifyMfaChallengeToken(tok, { hmacKey: KEY, nowMs });
    expect(verified.ok).toBe(true);
    if (verified.ok) {
      expect(verified.claims.uid).toBe("user-abc");
      const expectedExp =
        Math.floor(nowMs / 1000) + DEFAULT_CHALLENGE_TTL_SECONDS;
      expect(verified.claims.exp).toBe(expectedExp);
    }
  });

  it("rejects after exp", () => {
    const issueAt = 1_700_000_000_000;
    const tok = mintMfaChallengeToken({
      uid: "user-abc",
      hmacKey: KEY,
      nowMs: issueAt,
      ttlSeconds: 60,
    });
    const verified = verifyMfaChallengeToken(tok, {
      hmacKey: KEY,
      nowMs: issueAt + 61_000,
    });
    expect(verified.ok).toBe(false);
    if (!verified.ok) expect(verified.reason).toBe("expired");
  });

  it("accepts right at the cusp of exp", () => {
    const issueAt = 1_700_000_000_000;
    const tok = mintMfaChallengeToken({
      uid: "u",
      hmacKey: KEY,
      nowMs: issueAt,
      ttlSeconds: 60,
    });
    // exp = issueAt+60s; verify exactly one ms BEFORE that boundary.
    const verified = verifyMfaChallengeToken(tok, {
      hmacKey: KEY,
      nowMs: issueAt + 59_999,
    });
    expect(verified.ok).toBe(true);
  });

  it("rejects malformed (no dot)", () => {
    const r = verifyMfaChallengeToken("not-a-token", { hmacKey: KEY });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("malformed");
  });

  it("rejects empty token", () => {
    const r = verifyMfaChallengeToken("", { hmacKey: KEY });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("malformed");
  });

  it("rejects when signature is tampered", () => {
    const tok = mintMfaChallengeToken({ uid: "u", hmacKey: KEY });
    // Flip one char of the signature (last char) — the verifier
    // should reject with bad_signature, not pass.
    const flipped =
      tok.slice(0, -1) + (tok.slice(-1) === "A" ? "B" : "A");
    const r = verifyMfaChallengeToken(flipped, { hmacKey: KEY });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("bad_signature");
  });

  it("rejects when payload is tampered (different uid → diff HMAC)", () => {
    // We forge a payload with a different uid but reuse the original
    // sig — the recomputed HMAC won't match.
    const orig = mintMfaChallengeToken({ uid: "u", hmacKey: KEY });
    const [, sig] = orig.split(".");
    const forgedPayload = Buffer.from(
      JSON.stringify({ uid: "evil", exp: Date.now() / 1000 + 60 }),
    )
      .toString("base64")
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");
    const forged = `${forgedPayload}.${sig}`;
    const r = verifyMfaChallengeToken(forged, { hmacKey: KEY });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("bad_signature");
  });

  it("rejects when verified with the wrong key", () => {
    const tok = mintMfaChallengeToken({ uid: "u", hmacKey: KEY });
    const other = randomBytes(32);
    const r = verifyMfaChallengeToken(tok, { hmacKey: other });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("bad_signature");
  });

  it("two tokens minted with the same inputs but different timestamps differ", () => {
    const a = mintMfaChallengeToken({
      uid: "u",
      hmacKey: KEY,
      nowMs: 1_000,
    });
    const b = mintMfaChallengeToken({
      uid: "u",
      hmacKey: KEY,
      nowMs: 2_000,
    });
    expect(a).not.toBe(b);
  });

  it("DEFAULT_CHALLENGE_TTL_SECONDS is 5 minutes", () => {
    expect(DEFAULT_CHALLENGE_TTL_SECONDS).toBe(300);
  });
});
