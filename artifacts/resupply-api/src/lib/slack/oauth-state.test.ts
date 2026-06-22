import { beforeAll, describe, expect, it } from "vitest";

import {
  signSlackOAuthState,
  verifySlackOAuthState,
  SLACK_OAUTH_STATE_TTL_MS,
} from "./oauth-state";

beforeAll(() => {
  // getLinkHmacKey() reads RESUPPLY_LINK_HMAC_KEY.
  process.env.RESUPPLY_LINK_HMAC_KEY =
    process.env.RESUPPLY_LINK_HMAC_KEY ??
    "test-link-hmac-key-at-least-32-bytes-long!!";
});

describe("slack oauth state", () => {
  it("round-trips a valid state to its orgId", () => {
    const token = signSlackOAuthState("org-123");
    expect(verifySlackOAuthState(token)).toEqual({
      valid: true,
      orgId: "org-123",
    });
  });

  it("rejects a tampered payload", () => {
    const token = signSlackOAuthState("org-123");
    const tampered = "x" + token.slice(1);
    const result = verifySlackOAuthState(tampered);
    expect(result.valid).toBe(false);
  });

  it("rejects a forged signature", () => {
    const token = signSlackOAuthState("org-123");
    const [payload] = token.split(".");
    const result = verifySlackOAuthState(`${payload}.AAAA`);
    expect(result).toEqual({ valid: false, reason: "bad_signature" });
  });

  it("rejects an expired state", () => {
    const past = new Date(Date.now() - SLACK_OAUTH_STATE_TTL_MS - 1000);
    const token = signSlackOAuthState("org-123", past);
    expect(verifySlackOAuthState(token)).toEqual({
      valid: false,
      reason: "expired",
    });
  });

  it("rejects malformed input", () => {
    expect(verifySlackOAuthState("")).toEqual({
      valid: false,
      reason: "malformed",
    });
    expect(verifySlackOAuthState("nodot")).toEqual({
      valid: false,
      reason: "malformed",
    });
  });
});
