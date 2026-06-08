import { createHmac } from "node:crypto";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  FITTER_INVITE_TTL_MS,
  signFitterInviteToken,
  verifyFitterInviteToken,
} from "./fitter-invite-token";

const ORIGINAL_KEY = process.env.RESUPPLY_LINK_HMAC_KEY;

describe("fitter-invite-token", () => {
  beforeEach(() => {
    process.env.RESUPPLY_LINK_HMAC_KEY = "test-link-hmac-key-value-1234567890";
  });
  afterEach(() => {
    if (ORIGINAL_KEY === undefined) delete process.env.RESUPPLY_LINK_HMAC_KEY;
    else process.env.RESUPPLY_LINK_HMAC_KEY = ORIGINAL_KEY;
  });

  it("round-trips a valid token back to its invite id", () => {
    const token = signFitterInviteToken("invite-123");
    const result = verifyFitterInviteToken(token);
    expect(result).toEqual({ valid: true, inviteId: "invite-123" });
  });

  it("rejects a tampered payload", () => {
    const token = signFitterInviteToken("invite-123");
    const [, sig] = token.split(".");
    // Swap the payload for a different invite id, keep the old sig.
    const forgedPayload = Buffer.from("fi|invite-evil|9999999999", "utf8")
      .toString("base64")
      .replaceAll("+", "-")
      .replaceAll("/", "_")
      .replaceAll("=", "");
    const result = verifyFitterInviteToken(`${forgedPayload}.${sig}`);
    expect(result).toEqual({ valid: false, reason: "bad_signature" });
  });

  it("rejects a token signed with a different key", () => {
    const token = signFitterInviteToken("invite-123");
    process.env.RESUPPLY_LINK_HMAC_KEY = "a-totally-different-key-aaaaaaaaaaa";
    const result = verifyFitterInviteToken(token);
    expect(result).toEqual({ valid: false, reason: "bad_signature" });
  });

  it("rejects an expired token", () => {
    const past = new Date(Date.now() - FITTER_INVITE_TTL_MS - 60_000);
    const token = signFitterInviteToken("invite-123", past);
    const result = verifyFitterInviteToken(token);
    expect(result).toEqual({ valid: false, reason: "expired" });
  });

  it("rejects malformed tokens", () => {
    expect(verifyFitterInviteToken("")).toEqual({
      valid: false,
      reason: "malformed",
    });
    expect(verifyFitterInviteToken("no-dot-here")).toEqual({
      valid: false,
      reason: "malformed",
    });
    expect(verifyFitterInviteToken(".onlysig")).toEqual({
      valid: false,
      reason: "malformed",
    });
  });

  it("rejects a token whose payload prefix is from another scope", () => {
    // A fitter-lead unsubscribe-shaped payload ("leadId|expiry", no
    // "fi" prefix) must not verify as an invite even if signed with
    // the same key.
    const expiresSec = Math.floor((Date.now() + FITTER_INVITE_TTL_MS) / 1000);
    const payload = Buffer.from(`lead-1|${expiresSec}`, "utf8")
      .toString("base64")
      .replaceAll("+", "-")
      .replaceAll("/", "_")
      .replaceAll("=", "");
    const sig = createHmac(
      "sha256",
      Buffer.from(process.env.RESUPPLY_LINK_HMAC_KEY as string, "utf8"),
    )
      .update(payload, "utf8")
      .digest()
      .toString("base64")
      .replaceAll("+", "-")
      .replaceAll("/", "_")
      .replaceAll("=", "");
    const result = verifyFitterInviteToken(`${payload}.${sig}`);
    expect(result).toEqual({ valid: false, reason: "malformed" });
  });
});
