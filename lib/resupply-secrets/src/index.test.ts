import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  LINK_HMAC_KEY_ENV,
  LINK_HMAC_KEY_MIN_BYTES,
  getLinkHmacKey,
  hasLinkHmacKey,
} from "./index";

// A 32-byte secret, base64-encoded. Matches the preflight contract
// (`requireBase64Bytes("RESUPPLY_LINK_HMAC_KEY", 32)`) so tests and
// preflight agree on what a "valid" key looks like.
const VALID_KEY_BYTES = Buffer.alloc(LINK_HMAC_KEY_MIN_BYTES, 0x42);
const VALID_KEY_B64 = VALID_KEY_BYTES.toString("base64");

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
    it("decodes the env value from base64 to raw bytes", () => {
      process.env[LINK_HMAC_KEY_ENV] = VALID_KEY_B64;
      expect(getLinkHmacKey().equals(VALID_KEY_BYTES)).toBe(true);
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

    it("throws when the value is not strict base64", () => {
      // URL-safe base64 (- and _) is rejected to match preflight.
      process.env[LINK_HMAC_KEY_ENV] = "abc-def_ghi";
      expect(() => getLinkHmacKey()).toThrow(/not valid base64/);
    });

    it("throws when the decoded value is shorter than the minimum", () => {
      process.env[LINK_HMAC_KEY_ENV] = Buffer.alloc(8, 1).toString("base64");
      expect(() => getLinkHmacKey()).toThrow(
        /at least \d+ bytes are required/,
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
