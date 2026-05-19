// Tests for the centralized contact constants in lib/contact.ts.
//
// PR change summary
// -----------------
// comfort-guarantee.tsx and returns.tsx were updated to use these
// constants (SUPPORT_EMAIL, SUPPORT_PHONE_E164, SUPPORT_PHONE_DISPLAY)
// instead of hard-coding contact strings inline. This ensures the
// floating chat launcher, footer, comfort-guarantee page, and returns
// page all reflect the same phone/email without drift.
//
// These tests verify the exported constants have the correct format
// and exact values so a copy-paste error or accidental edit is caught
// before it reaches the storefront.

import { describe, expect, it } from "vitest";

import {
  SUPPORT_EMAIL,
  SUPPORT_HOURS,
  SUPPORT_PHONE_DISPLAY,
  SUPPORT_PHONE_E164,
} from "./contact";

describe("SUPPORT_PHONE_E164", () => {
  it("starts with a + (E.164 international prefix)", () => {
    expect(SUPPORT_PHONE_E164).toMatch(/^\+/);
  });

  it("contains only digits after the leading +", () => {
    expect(SUPPORT_PHONE_E164).toMatch(/^\+\d+$/);
  });

  it("has the correct E.164 value (+18144710627)", () => {
    expect(SUPPORT_PHONE_E164).toBe("+18144710627");
  });

  it("starts with the US country code +1", () => {
    expect(SUPPORT_PHONE_E164).toMatch(/^\+1/);
  });

  it("has 12 characters total (+ and 11 digits for a US number)", () => {
    // US E.164: +1 + 10 digit NANP number = 12 chars
    expect(SUPPORT_PHONE_E164).toHaveLength(12);
  });

  it("is suitable for use in a tel: link href", () => {
    const href = `tel:${SUPPORT_PHONE_E164}`;
    expect(href).toBe("tel:+18144710627");
  });
});

describe("SUPPORT_PHONE_DISPLAY", () => {
  it("matches the US NANP display format (NXX) NXX-XXXX", () => {
    expect(SUPPORT_PHONE_DISPLAY).toMatch(/^\(\d{3}\) \d{3}-\d{4}$/);
  });

  it("has the correct display value ((814) 471-0627)", () => {
    expect(SUPPORT_PHONE_DISPLAY).toBe("(814) 471-0627");
  });

  it("encodes the same number as SUPPORT_PHONE_E164 (814 471 0627)", () => {
    // Strip non-digits from the display form and compare with the
    // E.164 form minus the country code prefix (+1).
    const displayDigits = SUPPORT_PHONE_DISPLAY.replace(/\D/g, "");
    const e164Digits = SUPPORT_PHONE_E164.replace(/^\+1/, "");
    expect(displayDigits).toBe(e164Digits);
  });

  it("does NOT contain the country code (display format is domestic)", () => {
    // Display strings like +1 (814) … or 1-(814)-… would be non-standard.
    expect(SUPPORT_PHONE_DISPLAY).not.toMatch(/^\+/);
    expect(SUPPORT_PHONE_DISPLAY).not.toMatch(/^1/);
  });
});

describe("SUPPORT_EMAIL", () => {
  it("is a valid email address (contains @ with characters on both sides)", () => {
    expect(SUPPORT_EMAIL).toMatch(/^[^\s@]+@[^\s@]+\.[^\s@]+$/);
  });

  it("has the correct value (support@pennpaps.com)", () => {
    expect(SUPPORT_EMAIL).toBe("support@pennpaps.com");
  });

  it("uses the pennpaps.com domain", () => {
    expect(SUPPORT_EMAIL).toMatch(/@pennpaps\.com$/);
  });

  it("uses the support@ prefix (not info@, billing@, etc.)", () => {
    expect(SUPPORT_EMAIL).toMatch(/^support@/);
  });

  it("is suitable for use in a mailto: link href", () => {
    const href = `mailto:${SUPPORT_EMAIL}`;
    expect(href).toBe("mailto:support@pennpaps.com");
  });

  it("contains no whitespace", () => {
    expect(SUPPORT_EMAIL).not.toMatch(/\s/);
  });
});

describe("SUPPORT_HOURS", () => {
  it("is a non-empty string", () => {
    expect(typeof SUPPORT_HOURS).toBe("string");
    expect(SUPPORT_HOURS.length).toBeGreaterThan(0);
  });

  it("has the correct business hours value (Mon–Fri 9a–5p ET)", () => {
    expect(SUPPORT_HOURS).toBe("Mon–Fri 9a–5p ET");
  });

  it("mentions ET (Eastern Time zone)", () => {
    expect(SUPPORT_HOURS).toContain("ET");
  });
});

describe("contact constants — internal consistency", () => {
  it("SUPPORT_PHONE_E164 and SUPPORT_PHONE_DISPLAY encode the same phone number", () => {
    const displayDigits = SUPPORT_PHONE_DISPLAY.replace(/\D/g, "");
    // E.164 for a US number is +1 followed by 10 NANP digits.
    expect(SUPPORT_PHONE_E164).toBe(`+1${displayDigits}`);
  });

  it("SUPPORT_EMAIL domain matches the PennPaps brand", () => {
    expect(SUPPORT_EMAIL).toContain("pennpaps");
  });

  it("none of the exported strings are empty", () => {
    expect(SUPPORT_PHONE_E164).not.toBe("");
    expect(SUPPORT_PHONE_DISPLAY).not.toBe("");
    expect(SUPPORT_EMAIL).not.toBe("");
    expect(SUPPORT_HOURS).not.toBe("");
  });
});