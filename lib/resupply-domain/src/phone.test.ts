import { describe, expect, it } from "vitest";

import { normalizeE164 } from "./phone";

describe("normalizeE164", () => {
  it("passes through already-E.164 and normalizes NANP shortcuts", () => {
    expect(normalizeE164("+12155551212")).toBe("+12155551212");
    expect(normalizeE164("2155551212")).toBe("+12155551212");
    expect(normalizeE164("12155551212")).toBe("+12155551212");
    expect(normalizeE164("(215) 555-1212")).toBe("+12155551212");
    expect(normalizeE164("+1 (215) 555-1212")).toBe("+12155551212");
  });

  it("returns null for empty / too-short / over-spec input", () => {
    expect(normalizeE164(null)).toBeNull();
    expect(normalizeE164("")).toBeNull();
    expect(normalizeE164("12345")).toBeNull();
    expect(normalizeE164("+1234567890123456")).toBeNull(); // 16 digits
  });

  it("strips a trailing extension to the base line (was folded into the number)", () => {
    // Regression: the +-prefixed path used to fold the extension digits
    // into the E.164 (e.g. "+12155551212" + "99" → "+1215555121299"),
    // while the no-+ path rejected the same input. Both now normalize to
    // the base line.
    expect(normalizeE164("+1 (215) 555-1212 x99")).toBe("+12155551212");
    expect(normalizeE164("(215) 555-1212 x99")).toBe("+12155551212");
    expect(normalizeE164("215-555-1212 ext 4567")).toBe("+12155551212");
    expect(normalizeE164("+1 215 555 1212 ext. 4567")).toBe("+12155551212");
    expect(normalizeE164("215.555.1212 extension 12")).toBe("+12155551212");
    expect(normalizeE164("(215) 555-1212 #5")).toBe("+12155551212");
  });

  it("does not treat an infix 'x' (no separator) as an extension", () => {
    // "800x5551212" stays a 10-digit number (x removed as punctuation),
    // not stripped to "800".
    expect(normalizeE164("800x5551212")).toBe("+18005551212");
  });

  describe("international", () => {
    it("passes a +-prefixed non-NANP number through unchanged", () => {
      expect(normalizeE164("+44 20 7183 8750")).toBe("+442071838750");
    });

    it("rejects a bare non-NANP number without a default country code", () => {
      // 9-digit national number — neither a 10-digit nor 11-leading-1 NANP.
      expect(normalizeE164("2 9374 4000")).toBeNull();
    });

    it("prefixes a bare national number with the default country code", () => {
      expect(normalizeE164("2 9374 4000", { defaultCountryCode: "61" })).toBe(
        "+61293744000",
      );
    });

    it("still prefers the NANP shortcut over the default country code", () => {
      // 10 digits → +1, regardless of a supplied default CC.
      expect(normalizeE164("2155551212", { defaultCountryCode: "44" })).toBe(
        "+12155551212",
      );
    });

    it("rejects when the prefixed result is out of E.164 range", () => {
      expect(normalizeE164("1", { defaultCountryCode: "44" })).toBeNull();
    });
  });
});
