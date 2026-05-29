import { describe, it, expect } from "vitest";
import { redactPiiForOutbound, containsLikelyPii } from "./chatbotPii";

describe("redactPiiForOutbound", () => {
  it("redacts a US phone number in parens / dash format", () => {
    const r = redactPiiForOutbound("Call me at (814) 471-0627 anytime.");
    expect(r.text).not.toContain("471-0627");
    expect(r.text).toContain("[redacted-phone]");
    expect(r.counts.phone).toBe(1);
  });

  it("redacts a 10-digit unformatted phone number", () => {
    const r = redactPiiForOutbound("My number is 5555551234.");
    // 10-digit run could match either the phone or id pattern;
    // either way it should be scrubbed.
    expect(r.text).not.toContain("5555551234");
  });

  it("redacts an email address", () => {
    const r = redactPiiForOutbound("Reach me at jane.doe+test@example.co.uk!");
    expect(r.text).not.toContain("jane.doe+test@example.co.uk");
    expect(r.text).toContain("[redacted-email]");
    expect(r.counts.email).toBe(1);
  });

  it("redacts an SSN-shaped number", () => {
    const r = redactPiiForOutbound("My SSN is 123-45-6789.");
    expect(r.text).not.toContain("123-45-6789");
    expect(r.text).toContain("[redacted-ssn]");
  });

  it("redacts a Medicare-style long member id", () => {
    const r = redactPiiForOutbound(
      "Member id 1AB2-CD3-EF45 — uh, 1234567890123.",
    );
    // The all-digit run is what we catch; alpha-numeric mixed ids
    // are left for the model to interpret as just "an identifier".
    expect(r.text).not.toContain("1234567890123");
    expect(Object.keys(r.counts)).toContain("id");
  });

  it("redacts a date of birth in MM/DD/YYYY form", () => {
    const r = redactPiiForOutbound("Born 12/03/1965, fyi.");
    expect(r.text).not.toContain("12/03/1965");
    expect(r.text).toContain("[redacted-dob]");
  });

  it("redacts a date of birth in YYYY-MM-DD form", () => {
    const r = redactPiiForOutbound("DOB 1965-03-12.");
    expect(r.text).not.toContain("1965-03-12");
    expect(r.text).toContain("[redacted-dob]");
  });

  it("preserves prose that doesn't match any pattern", () => {
    const text = "Which mask is best for side sleepers with high pressure?";
    const r = redactPiiForOutbound(text);
    expect(r.text).toBe(text);
    expect(Object.keys(r.counts)).toHaveLength(0);
  });

  it("does not catch ordinary numbers like AHI 5 or 4 hours", () => {
    const r = redactPiiForOutbound(
      "My AHI was 12 last night and I used CPAP 4 hours.",
    );
    expect(r.text).toContain("AHI was 12");
    expect(r.text).toContain("4 hours");
    expect(Object.keys(r.counts)).toHaveLength(0);
  });

  it("counts multiple matches separately", () => {
    const r = redactPiiForOutbound(
      "Call me at 555-123-4567 or 555-987-6543, or email me@x.com.",
    );
    expect(r.counts.phone).toBe(2);
    expect(r.counts.email).toBe(1);
  });

  it("is idempotent — running twice does not over-redact", () => {
    const once = redactPiiForOutbound("Phone (814) 471-0627").text;
    const twice = redactPiiForOutbound(once).text;
    expect(twice).toBe(once);
  });

  it("does not mangle catalog ids that look numeric", () => {
    const r = redactPiiForOutbound("Show me the resmed-airfit-p10.");
    expect(r.text).toContain("resmed-airfit-p10");
  });
});

describe("containsLikelyPii", () => {
  it("returns true for an email", () => {
    expect(containsLikelyPii("foo@bar.com")).toBe(true);
  });

  it("returns true for an SSN", () => {
    expect(containsLikelyPii("123-45-6789")).toBe(true);
  });

  it("returns false for ordinary prose", () => {
    expect(containsLikelyPii("which mask is best?")).toBe(false);
  });
});
