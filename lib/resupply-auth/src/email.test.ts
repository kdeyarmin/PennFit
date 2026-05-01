import { describe, expect, it } from "vitest";

import { looksLikeEmail, normalizeEmail } from "./email";

describe("looksLikeEmail", () => {
  it("accepts simple addresses", () => {
    expect(looksLikeEmail("alice@example.com")).toBe(true);
    expect(looksLikeEmail("bob.smith+filter@sub.example.co")).toBe(true);
  });

  it("rejects malformed input", () => {
    expect(looksLikeEmail("not an email")).toBe(false);
    expect(looksLikeEmail("a@b")).toBe(false);
    expect(looksLikeEmail("@example.com")).toBe(false);
    expect(looksLikeEmail("alice@")).toBe(false);
    expect(looksLikeEmail("")).toBe(false);
    expect(looksLikeEmail(undefined)).toBe(false);
    expect(looksLikeEmail(123)).toBe(false);
  });
});

describe("normalizeEmail", () => {
  it("lowercases and trims", () => {
    expect(normalizeEmail("  Alice@Example.COM ")).toBe("alice@example.com");
  });

  it("preserves + aliases (does NOT collapse them)", () => {
    expect(normalizeEmail("alice+filter@example.com")).toBe(
      "alice+filter@example.com",
    );
  });

  it("preserves dots in local part (does NOT do gmail-style collapse)", () => {
    expect(normalizeEmail("a.l.i.c.e@example.com")).toBe(
      "a.l.i.c.e@example.com",
    );
  });

  it("throws on malformed input", () => {
    expect(() => normalizeEmail("not an email")).toThrow();
  });
});
