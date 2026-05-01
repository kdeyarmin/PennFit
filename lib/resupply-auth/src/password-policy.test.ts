import { describe, expect, it } from "vitest";

import {
  PASSWORD_MAX_LENGTH,
  PASSWORD_MIN_LENGTH,
  validatePassword,
} from "./password-policy";

describe("validatePassword", () => {
  it("rejects empty / non-string input", () => {
    expect(validatePassword("").ok).toBe(false);
    expect(validatePassword(undefined).ok).toBe(false);
    expect(validatePassword(123 as unknown).ok).toBe(false);
  });

  it("rejects below the minimum length", () => {
    const r = validatePassword("a".repeat(PASSWORD_MIN_LENGTH - 1));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("too_short");
  });

  it("accepts exactly the minimum length", () => {
    const r = validatePassword("a".repeat(PASSWORD_MIN_LENGTH));
    expect(r.ok).toBe(true);
  });

  it("rejects above the maximum length", () => {
    const r = validatePassword("a".repeat(PASSWORD_MAX_LENGTH + 1));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("too_long");
  });

  it("does NOT impose composition rules (no required digit/symbol)", () => {
    expect(validatePassword("aaaaaaaaaaaa").ok).toBe(true); // 12 lowercase letters
  });
});
