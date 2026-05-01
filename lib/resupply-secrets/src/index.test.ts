import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { LINK_HMAC_KEY_ENV, getLinkHmacKey, hasLinkHmacKey } from "./index";

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
    it("returns the env value as raw UTF-8 bytes", () => {
      process.env[LINK_HMAC_KEY_ENV] = "test-link-key";
      expect(getLinkHmacKey().toString("utf8")).toBe("test-link-key");
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
