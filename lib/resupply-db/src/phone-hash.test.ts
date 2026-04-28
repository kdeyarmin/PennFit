import { describe, expect, it, beforeEach, afterEach } from "vitest";

import { hmacPhone, normalizeE164 } from "./phone-hash";

describe("normalizeE164", () => {
  it.each([
    ["+12155551212", "+12155551212"],
    ["2155551212", "+12155551212"],
    ["12155551212", "+12155551212"],
    ["(215) 555-1212", "+12155551212"],
    ["215-555-1212", "+12155551212"],
    ["+1 (215) 555-1212", "+12155551212"],
    ["  +442071838750  ", "+442071838750"],
  ])("normalizes %s → %s", (input, expected) => {
    expect(normalizeE164(input)).toBe(expected);
  });

  it.each([
    [""],
    ["   "],
    ["abc"],
    ["12345"], // too short
    ["+1234567"], // 7 digits, below E.164 minimum
    ["+1234567890123456"], // 16 digits, over E.164 maximum
    ["+"], // bare plus
    ["555-1212"], // 7-digit local
  ])("rejects %s as invalid", (input) => {
    expect(normalizeE164(input)).toBeNull();
  });

  it("returns null for null/undefined", () => {
    expect(normalizeE164(null)).toBeNull();
    expect(normalizeE164(undefined)).toBeNull();
  });
});

describe("hmacPhone", () => {
  const KEY_ENV = "RESUPPLY_PHONE_HMAC_KEY";
  let saved: string | undefined;

  beforeEach(() => {
    saved = process.env[KEY_ENV];
  });

  afterEach(() => {
    if (saved === undefined) {
      delete process.env[KEY_ENV];
    } else {
      process.env[KEY_ENV] = saved;
    }
  });

  it("produces stable 32-byte digests for the same input + key", () => {
    process.env[KEY_ENV] = "test-key-aaaa";
    const a = hmacPhone("+12155551212");
    const b = hmacPhone("+12155551212");
    expect(a).toBeInstanceOf(Buffer);
    expect(a.length).toBe(32);
    expect(a.equals(b)).toBe(true);
  });

  it("normalizes equivalent inputs to the same digest", () => {
    process.env[KEY_ENV] = "test-key-aaaa";
    const a = hmacPhone("2155551212");
    const b = hmacPhone("(215) 555-1212");
    const c = hmacPhone("+1 215 555 1212");
    expect(a.equals(b)).toBe(true);
    expect(a.equals(c)).toBe(true);
  });

  it("produces different digests for different keys", () => {
    process.env[KEY_ENV] = "key-one";
    const a = hmacPhone("+12155551212");
    process.env[KEY_ENV] = "key-two";
    const b = hmacPhone("+12155551212");
    expect(a.equals(b)).toBe(false);
  });

  it("produces different digests for different phone numbers", () => {
    process.env[KEY_ENV] = "test-key-aaaa";
    const a = hmacPhone("+12155551212");
    const b = hmacPhone("+12155551213");
    expect(a.equals(b)).toBe(false);
  });

  it("throws a clear error when the HMAC key is unset", () => {
    delete process.env[KEY_ENV];
    expect(() => hmacPhone("+12155551212")).toThrow(
      /RESUPPLY_PHONE_HMAC_KEY is not set/,
    );
  });

  it("throws when the input does not normalize", () => {
    process.env[KEY_ENV] = "test-key-aaaa";
    expect(() => hmacPhone("abc")).toThrow(/did not normalize/);
    expect(() => hmacPhone("")).toThrow(/did not normalize/);
  });
});
