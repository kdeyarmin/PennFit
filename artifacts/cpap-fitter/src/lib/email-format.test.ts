import { describe, expect, it } from "vitest";

import { isValidEmail } from "./email-format";

describe("isValidEmail", () => {
  it("accepts well-formed addresses", () => {
    for (const ok of [
      "you@example.com",
      "a.b+tag@sub.domain.co",
      "  trimmed@example.com  ", // leading/trailing whitespace is trimmed
    ]) {
      expect(isValidEmail(ok)).toBe(true);
    }
  });

  it("rejects malformed addresses", () => {
    for (const bad of [
      "",
      "plainstring",
      "no-at-sign.com",
      "missing@domain",
      "two@@at.com",
      "spa ce@example.com",
      "@example.com",
      "user@",
    ]) {
      expect(isValidEmail(bad)).toBe(false);
    }
  });
});
