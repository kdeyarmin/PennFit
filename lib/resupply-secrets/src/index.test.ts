import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  LINK_HMAC_KEY_ENV,
  getLinkHmacKey,
  hasLinkHmacKey,
} from "./index";

describe("resupply-secrets", () => {
  let saved: string | undefined;

  beforeEach(() => {
    saved = process.env[LINK_HMAC_KEY_ENV];
    delete process.env[LINK_HMAC_KEY_ENV];
  });

  afterEach(() => {
    if (saved === undefined) delete process.env[LINK_HMAC_KEY_ENV];
    else process.env[LINK_HMAC_KEY_ENV] = saved;
  });

  describe("getLinkHmacKey", () => {
    // The env value is used as raw UTF-8 bytes — deliberately NOT
    // base64-decoded at runtime. base64-decoding here would change the
    // key material versus every signed token already in flight,
    // invalidating reminder/portal/Rx links across a deploy. Preflight
    // (scripts/preflight-prod-env.ts) is the deploy-time gate that
    // base64-decodes and enforces the minimum entropy.
    it("returns the env value as raw UTF-8 bytes (not base64-decoded)", () => {
      process.env[LINK_HMAC_KEY_ENV] = "my-secret-key-value";
      expect(
        getLinkHmacKey().equals(Buffer.from("my-secret-key-value", "utf8")),
      ).toBe(true);
    });

    it("does not base64-validate the value (any non-empty string is accepted)", () => {
      // URL-safe-base64 chars (- and _) are not strict base64; a runtime
      // base64 check would reject this, but we treat it as raw bytes.
      process.env[LINK_HMAC_KEY_ENV] = "abc-def_ghi";
      expect(() => getLinkHmacKey()).not.toThrow();
      expect(
        getLinkHmacKey().equals(Buffer.from("abc-def_ghi", "utf8")),
      ).toBe(true);
    });

    it("does not enforce a minimum length at runtime (preflight is the gate)", () => {
      process.env[LINK_HMAC_KEY_ENV] = "short";
      expect(() => getLinkHmacKey()).not.toThrow();
      expect(getLinkHmacKey().equals(Buffer.from("short", "utf8"))).toBe(true);
    });

    it("treats whitespace-only values as unset", () => {
      process.env[LINK_HMAC_KEY_ENV] = "   ";
      expect(hasLinkHmacKey()).toBe(false);
      expect(() => getLinkHmacKey()).toThrow(/RESUPPLY_LINK_HMAC_KEY/);
    });

    it("throws a clear error when the env var is unset", () => {
      expect(() => getLinkHmacKey()).toThrow(
        /RESUPPLY_LINK_HMAC_KEY is not set/,
      );
    });
  });

  describe("hasLinkHmacKey", () => {
    it("returns false when the env var is unset", () => {
      expect(hasLinkHmacKey()).toBe(false);
    });

    it("returns true when the env var is set", () => {
      process.env[LINK_HMAC_KEY_ENV] = "anything";
      expect(hasLinkHmacKey()).toBe(true);
    });

    it("supports an explicit env override (hermetic for tests)", () => {
      expect(hasLinkHmacKey({ [LINK_HMAC_KEY_ENV]: "x" })).toBe(true);
      expect(hasLinkHmacKey({})).toBe(false);
    });
  });
});
