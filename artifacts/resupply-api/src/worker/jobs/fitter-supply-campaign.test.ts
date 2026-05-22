// Tests for the multi-touch supply-campaign composer.
//
// The dispatcher itself is integration-y (Supabase + SendGrid +
// Twilio); the composeTouchpoint helper is pure, so we test it
// directly. Covers:
//   * subject + body shape per touch index
//   * recommended-mask name substitution + null fallback
//   * unsubscribe URL appears in EVERY touchpoint footer
//   * SMS body length stays under the GSM-7 single-segment cap
//   * touches without SMS copy return an empty string

import { describe, it, expect } from "vitest";

import { composeTouchpoint } from "./fitter-supply-campaign";

const BASE_OPTS = {
  practiceName: "PennPaps",
  resumeUrl: "https://example.test/results",
  shopUrl: "https://example.test/shop",
  recommendedMaskName: "ResMed AirFit P30i",
  recommendedMaskType: "nasalPillow",
  unsubscribeUrl: "https://example.test/shop/fitter-leads/unsubscribe?t=tok",
};

describe("composeTouchpoint", () => {
  it("substitutes the recommended mask name into T1 subject + body", () => {
    const out = composeTouchpoint({ ...BASE_OPTS, touchIndex: 1 });
    expect(out.email.subject).toBe(
      "your ResMed AirFit P30i is ready when you are",
    );
    expect(out.email.text).toContain("ResMed AirFit P30i");
    expect(out.email.html).toContain("ResMed AirFit P30i");
  });

  it("falls back to a generic phrase when mask name is null", () => {
    const out = composeTouchpoint({
      ...BASE_OPTS,
      touchIndex: 1,
      recommendedMaskName: null,
    });
    expect(out.email.subject).toContain("your recommended mask");
    expect(out.email.text).not.toContain("null");
  });

  it("includes the unsubscribe URL in every touchpoint email", () => {
    for (let i = 1; i <= 6; i++) {
      const out = composeTouchpoint({ ...BASE_OPTS, touchIndex: i });
      expect(out.email.html, `touch ${i} html must contain unsubscribe`).toContain(
        BASE_OPTS.unsubscribeUrl,
      );
      expect(out.email.text, `touch ${i} text must contain unsubscribe`).toContain(
        BASE_OPTS.unsubscribeUrl,
      );
    }
  });

  it("includes a STOP keyword on every SMS body that ships", () => {
    for (let i = 1; i <= 6; i++) {
      const out = composeTouchpoint({ ...BASE_OPTS, touchIndex: i });
      if (out.sms.length === 0) continue;
      expect(out.sms, `touch ${i} sms must include STOP`).toContain("STOP");
    }
  });

  it("keeps SMS bodies under the GSM-7 single-segment cap (160 chars)", () => {
    for (let i = 1; i <= 6; i++) {
      const out = composeTouchpoint({ ...BASE_OPTS, touchIndex: i });
      expect(
        out.sms.length,
        `touch ${i} sms length is ${out.sms.length}`,
      ).toBeLessThanOrEqual(160);
    }
  });

  it("returns empty SMS for touches that are email-only (T2, T3, T5, T6)", () => {
    for (const i of [2, 3, 5, 6]) {
      const out = composeTouchpoint({ ...BASE_OPTS, touchIndex: i });
      expect(out.sms, `touch ${i} sms should be empty`).toBe("");
    }
  });

  it("returns non-empty SMS for the SMS-eligible touches (T1, T4)", () => {
    for (const i of [1, 4]) {
      const out = composeTouchpoint({ ...BASE_OPTS, touchIndex: i });
      expect(out.sms.length, `touch ${i} sms should be non-empty`).toBeGreaterThan(
        0,
      );
    }
  });

  it("includes the promo code in T4", () => {
    const out = composeTouchpoint({ ...BASE_OPTS, touchIndex: 4 });
    // Defaults to WELCOME15 when FITTER_SUPPLY_CAMPAIGN_PROMO is unset.
    expect(out.email.text).toContain("WELCOME15");
    expect(out.email.html).toContain("WELCOME15");
  });

  it("escapes HTML special characters in the practice name", () => {
    const out = composeTouchpoint({
      ...BASE_OPTS,
      touchIndex: 6,
      practiceName: "Penn & Paps <script>",
    });
    expect(out.email.html).toContain("Penn &amp; Paps &lt;script&gt;");
    expect(out.email.html).not.toContain("<script>");
  });
});
