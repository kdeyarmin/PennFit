// Unit tests for the Rx-renewal copy renderers.
//
// Pure-function tests: no DB, no network. We pin the user-facing
// details that conversion depends on (urgency wording, channel-
// specific length budgets, segment-safe SMS) so an A/B copy edit
// can't accidentally regress the production behaviour.

import { describe, it, expect } from "vitest";

import {
  rxRenewalHtml,
  rxRenewalPushTitle,
  rxRenewalSms,
  rxRenewalSubject,
  rxRenewalText,
} from "./renderers";

describe("rxRenewalSubject", () => {
  it("uses 'has expired' wording when daysUntilExpiry === 0", () => {
    expect(rxRenewalSubject(0)).toBe("Your CPAP prescription has expired");
  });

  it("uses singular 'day' for exactly 1 day", () => {
    expect(rxRenewalSubject(1)).toBe("Your CPAP prescription expires in 1 day");
  });

  it("pluralizes for >1 day", () => {
    expect(rxRenewalSubject(7)).toBe(
      "Your CPAP prescription expires in 7 days",
    );
    expect(rxRenewalSubject(30)).toBe(
      "Your CPAP prescription expires in 30 days",
    );
  });
});

describe("rxRenewalPushTitle", () => {
  it("clears the iOS lock-screen budget (≈ 60 chars)", () => {
    // Lock screen truncates aggressively; keep the title short.
    expect(rxRenewalPushTitle(0).length).toBeLessThanOrEqual(60);
    expect(rxRenewalPushTitle(30).length).toBeLessThanOrEqual(60);
  });

  it("expired vs not-yet-expired wording", () => {
    expect(rxRenewalPushTitle(0)).toBe("Your CPAP Rx has expired");
    expect(rxRenewalPushTitle(7)).toBe("Rx expires in 7 days");
    expect(rxRenewalPushTitle(1)).toBe("Rx expires in 1 day");
  });
});

describe("rxRenewalSms", () => {
  it("fits a single ASCII Twilio segment for typical inputs", () => {
    // 160-char segment limit; we want headroom below that.
    expect(rxRenewalSms("Anna", 7).length).toBeLessThanOrEqual(160);
    expect(rxRenewalSms("", 30).length).toBeLessThanOrEqual(160);
  });

  it("includes STOP keyword for opt-out compliance", () => {
    expect(rxRenewalSms("Bob", 7)).toContain("STOP");
  });

  it("greets without name when firstName is empty", () => {
    expect(rxRenewalSms("", 7)).toMatch(/^Hi, /);
  });

  it("greets with first name when supplied", () => {
    expect(rxRenewalSms("Anna", 7)).toMatch(/^Hi Anna, /);
  });

  it("uses 'tomorrow' wording for 1 day", () => {
    expect(rxRenewalSms("Anna", 1)).toContain("expires tomorrow");
    expect(rxRenewalSms("Anna", 1)).not.toContain("1 day");
  });

  it("uses 'just expired' wording for 0 days", () => {
    expect(rxRenewalSms("Anna", 0)).toContain("just expired");
  });
});

describe("rxRenewalText", () => {
  it("includes the headline + the renewal CTA", () => {
    const text = rxRenewalText("Hi Anna", 7);
    expect(text).toContain("Hi Anna");
    expect(text).toContain("expires in 7 days");
    expect(text).toContain("ask your prescribing physician");
  });
});

describe("rxRenewalHtml", () => {
  it("escapes <, >, & in the greeting (XSS hardening)", () => {
    const html = rxRenewalHtml("Hi <script>alert(1)</script>", 7);
    expect(html).not.toContain("<script>");
  });

  it("renders the headline with bold day-count", () => {
    const html = rxRenewalHtml("Hi Anna", 7);
    expect(html).toContain("<strong>7 days</strong>");
  });

  it("omits the bold tag for the expired-already case", () => {
    const html = rxRenewalHtml("Hi Anna", 0);
    expect(html).toContain("just expired");
    expect(html).not.toContain("<strong>0");
  });
});
