import { describe, expect, it } from "vitest";

import {
  formatPhoneDisplay,
  normalizePhoneE164,
  parseInviteContact,
} from "./invite-contact";

describe("parseInviteContact", () => {
  it("treats blank input as empty, not invalid", () => {
    expect(parseInviteContact("").kind).toBe("empty");
    expect(parseInviteContact("   ").kind).toBe("empty");
  });

  it("infers SMS from the phone shapes staff actually type", () => {
    for (const raw of [
      "2155551234",
      "(215) 555-1234",
      "215-555-1234",
      "215.555.1234",
      " 1 215 555 1234 ",
      "+12155551234",
    ]) {
      const parsed = parseInviteContact(raw);
      expect(parsed, raw).toMatchObject({
        kind: "phone",
        channel: "sms",
        phoneE164: "+12155551234",
        display: "(215) 555-1234",
      });
    }
  });

  it("keeps a non-US E.164 number as typed", () => {
    expect(parseInviteContact("+442071234567")).toMatchObject({
      kind: "phone",
      channel: "sms",
      phoneE164: "+442071234567",
      display: "+442071234567",
    });
  });

  it("infers email and lower-cases it for the API", () => {
    expect(parseInviteContact("  Jordan.Lee@Example.COM ")).toMatchObject({
      kind: "email",
      channel: "email",
      email: "jordan.lee@example.com",
      display: "jordan.lee@example.com",
    });
  });

  it("reports an email problem for anything with an @, never a phone one", () => {
    const parsed = parseInviteContact("jordan@example");
    expect(parsed.kind).toBe("invalid");
    expect(parsed.kind === "invalid" && parsed.reason).toMatch(/email/i);
  });

  it("rejects an email past the API's 200-char cap", () => {
    const parsed = parseInviteContact(`${"a".repeat(200)}@example.com`);
    expect(parsed.kind).toBe("invalid");
    expect(parsed.kind === "invalid" && parsed.reason).toMatch(/too long/i);
  });

  // Regression: blanket-stripping non-digits folded an extension into
  // the subscriber number ("+1 (215) 555-1234 ext. 99" → +1215555123499,
  // 13 digits, which passed the E.164 length check) and would have
  // texted a signed patient link to a different number entirely.
  it("refuses a number with an extension rather than folding its digits in", () => {
    for (const raw of [
      "+1 (215) 555-1234 ext. 99",
      "+1 215 555 1234 x99",
      "215-555-1234 ext 99",
      "2155551234x2",
    ]) {
      const parsed = parseInviteContact(raw);
      expect(parsed.kind, raw).toBe("invalid");
      expect(normalizePhoneE164(raw), raw).toBeNull();
    }
  });

  it("rejects an email the server's Zod would reject, so the operator sees why", () => {
    // Verified against the installed zod: each of these fails
    // z.string().email(), which would return a bare `invalid_body`.
    for (const raw of [
      "john..doe@example.com",
      ".john@example.com",
      "john.@example.com",
      "jordan@example..com",
      "jordan@-example.com",
    ]) {
      const parsed = parseInviteContact(raw);
      expect(parsed.kind, raw).toBe("invalid");
      expect(parsed.kind === "invalid" && parsed.reason).toMatch(/email/i);
    }
  });

  it("still accepts the ordinary addresses the server accepts", () => {
    for (const raw of [
      "jordan@example.com",
      "jordan.lee@example.com",
      "a+b@example.co.uk",
      "jordan@sub.example.com",
      "o'brien@example.com",
      "jordan_lee@example.com",
    ]) {
      expect(parseInviteContact(raw).kind, raw).toBe("email");
    }
  });

  it("rejects a number that is the wrong length", () => {
    for (const raw of ["555-1234", "21555512345", "+1234", "abc"]) {
      expect(parseInviteContact(raw).kind, raw).toBe("invalid");
    }
  });
});

describe("normalizePhoneE164", () => {
  it("returns null rather than a malformed number the API would 400 on", () => {
    expect(normalizePhoneE164("+1")).toBeNull();
    expect(normalizePhoneE164("+1234567890123456")).toBeNull();
    expect(normalizePhoneE164("")).toBeNull();
  });
});

describe("formatPhoneDisplay", () => {
  it("groups NANP numbers and leaves others alone", () => {
    expect(formatPhoneDisplay("+12155551234")).toBe("(215) 555-1234");
    expect(formatPhoneDisplay("+442071234567")).toBe("+442071234567");
  });
});
