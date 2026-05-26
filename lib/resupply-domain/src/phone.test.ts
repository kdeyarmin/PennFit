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
});
