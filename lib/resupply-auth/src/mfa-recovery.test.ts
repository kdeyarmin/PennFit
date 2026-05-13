// Tests for the MFA recovery-code helper.
//
// Goal: pin the entropy + normalization + hashing properties so a
// future refactor can't quietly weaken them (e.g., shrinking the
// alphabet, dropping the rejection sampling, or letting the
// display form leak into the hash).

import { describe, it, expect } from "vitest";
import { createHash } from "node:crypto";

import {
  RECOVERY_CODE_COUNT,
  RECOVERY_CODE_LENGTH,
  generateRecoveryCodeRaw,
  generateRecoveryCodes,
  hashRecoveryCode,
  normalizeRecoveryCode,
  recoveryCodeHashesEqual,
} from "./mfa-recovery";

describe("normalizeRecoveryCode", () => {
  it("strips hyphens and uppercases", () => {
    expect(normalizeRecoveryCode("abcd-efgh")).toBe("ABCDEFGH");
  });
  it("tolerates whitespace", () => {
    expect(normalizeRecoveryCode("  abcd  efgh \n")).toBe("ABCDEFGH");
  });
  it("normalizes hyphen+no-hyphen forms identically", () => {
    expect(normalizeRecoveryCode("ABCD-EFGH")).toBe(
      normalizeRecoveryCode("ABCDEFGH"),
    );
  });
});

describe("generateRecoveryCodeRaw", () => {
  it("returns RECOVERY_CODE_LENGTH chars from the safe alphabet", () => {
    const code = generateRecoveryCodeRaw();
    expect(code.length).toBe(RECOVERY_CODE_LENGTH);
    // No confusable chars.
    expect(code).not.toMatch(/[0O1IL]/);
    // All chars in the documented alphabet.
    expect(code).toMatch(/^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]+$/);
  });

  it("produces high entropy (no fixed-prefix bug)", () => {
    // 500 codes; first-char distribution should hit many alphabet
    // letters. A regression like "always starts with A" would fail.
    const firstChars = new Set<string>();
    for (let i = 0; i < 500; i++) {
      firstChars.add(generateRecoveryCodeRaw()[0]!);
    }
    // We expect >10 distinct first characters in 500 draws across a
    // 31-char alphabet.
    expect(firstChars.size).toBeGreaterThan(10);
  });
});

describe("generateRecoveryCodes", () => {
  it("returns RECOVERY_CODE_COUNT codes by default", () => {
    const batch = generateRecoveryCodes();
    expect(batch.length).toBe(RECOVERY_CODE_COUNT);
  });

  it("respects a custom count", () => {
    expect(generateRecoveryCodes(3).length).toBe(3);
  });

  it("displays as ABCD-EFGH (hyphen at position 4)", () => {
    for (const { display, normalized } of generateRecoveryCodes(3)) {
      expect(display.length).toBe(RECOVERY_CODE_LENGTH + 1);
      expect(display.charAt(4)).toBe("-");
      // Display and normalized agree once the hyphen is stripped.
      expect(display.replace("-", "")).toBe(normalized);
    }
  });

  it("hash matches SHA-256 of the normalized form", () => {
    for (const { normalized, hash } of generateRecoveryCodes(3)) {
      const expected = createHash("sha256")
        .update(normalized, "utf8")
        .digest("hex");
      expect(hash).toBe(expected);
    }
  });

  it("does not duplicate codes within a batch", () => {
    const batch = generateRecoveryCodes(10);
    const normalized = new Set(batch.map((c) => c.normalized));
    expect(normalized.size).toBe(batch.length);
  });
});

describe("hashRecoveryCode", () => {
  it("is deterministic", () => {
    expect(hashRecoveryCode("ABCDEFGH")).toBe(hashRecoveryCode("ABCDEFGH"));
  });
  it("differs across inputs", () => {
    expect(hashRecoveryCode("ABCDEFGH")).not.toBe(
      hashRecoveryCode("ABCDEFGJ"),
    );
  });
  it("treats display form as a different input (caller MUST normalize)", () => {
    // Stored hashes use the normalized (no-hyphen) form. The
    // display form has a hyphen and therefore hashes differently —
    // this test is here so a refactor that hashes the display form
    // by accident will fail loudly.
    expect(hashRecoveryCode("ABCD-EFGH")).not.toBe(
      hashRecoveryCode("ABCDEFGH"),
    );
  });
});

describe("recoveryCodeHashesEqual", () => {
  it("true on matching hashes", () => {
    const h = hashRecoveryCode("ABCDEFGH");
    expect(recoveryCodeHashesEqual(h, h)).toBe(true);
  });
  it("false on differing hashes", () => {
    expect(
      recoveryCodeHashesEqual(
        hashRecoveryCode("ABCDEFGH"),
        hashRecoveryCode("ABCDEFGJ"),
      ),
    ).toBe(false);
  });
  it("false on differing lengths (without throwing)", () => {
    expect(recoveryCodeHashesEqual("abc", "abcd")).toBe(false);
  });
});
