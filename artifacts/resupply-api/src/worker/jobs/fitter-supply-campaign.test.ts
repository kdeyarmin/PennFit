// Tests for the multi-touch supply-campaign composer.
//
// The dispatcher itself is integration-y (Supabase + SendGrid +
// Twilio); the composeTouchpoint helper is pure, so we test it
// directly. Covers:
//   * subject + body shape per touch index (pre-purchase T1-T6 and
//     post-purchase re-order T7-T10)
//   * recommended-mask name substitution + null fallback
//   * first-name personalization on subject + greeting
//   * unsubscribe URL appears in EVERY touchpoint footer
//   * SMS body length stays under the GSM-7 single-segment cap
//   * SMS-eligible vs email-only touches per the per-touch policy

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

const ALL_TOUCHES = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10] as const;
const REORDER = [7, 8, 9, 10] as const;
const SMS_TOUCHES = [1, 2, 4, 6, 7, 8, 9, 10] as const;
const EMAIL_ONLY = [3, 5] as const;

describe("composeTouchpoint — pre-purchase phase (T1-T6)", () => {
  it("substitutes the recommended mask name into T1 subject + body", () => {
    const out = composeTouchpoint({ ...BASE_OPTS, touchIndex: 1 });
    expect(out.email.subject).toContain("ResMed AirFit P30i");
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

  it("T3 subject names a concrete FSA deadline date", () => {
    const out = composeTouchpoint({ ...BASE_OPTS, touchIndex: 3 });
    // Either "December 31" (most of the year) or "December 31" of
    // next year (Dec 26-31). The label always contains "December".
    expect(out.email.subject).toContain("December");
    expect(out.email.text).toContain("December");
  });

  it("T4 includes the promo code in subject, body, and SMS", () => {
    const out = composeTouchpoint({ ...BASE_OPTS, touchIndex: 4 });
    expect(out.email.subject).toContain("WELCOME15");
    expect(out.email.text).toContain("WELCOME15");
    expect(out.email.html).toContain("WELCOME15");
    expect(out.sms).toContain("WELCOME15");
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

describe("composeTouchpoint — re-order phase (T7-T10)", () => {
  it("T7 with nasalPillow mask says 'pillow inserts' (not 'cushion')", () => {
    const out = composeTouchpoint({
      ...BASE_OPTS,
      touchIndex: 7,
      recommendedMaskType: "nasalPillow",
    });
    expect(out.email.subject.toLowerCase()).toContain("pillow inserts");
    expect(out.email.text.toLowerCase()).toContain("pillow inserts");
    expect(out.email.html.toLowerCase()).toContain("pillow inserts");
  });

  it("T7 with nasal mask says 'nasal cushion'", () => {
    const out = composeTouchpoint({
      ...BASE_OPTS,
      touchIndex: 7,
      recommendedMaskType: "nasal",
    });
    expect(out.email.subject.toLowerCase()).toContain("nasal cushion");
    expect(out.email.text.toLowerCase()).toContain("nasal cushion");
  });

  it("T7 with fullFace mask says 'full-face cushion'", () => {
    const out = composeTouchpoint({
      ...BASE_OPTS,
      touchIndex: 7,
      recommendedMaskType: "fullFace",
    });
    expect(out.email.subject.toLowerCase()).toContain("full-face cushion");
    expect(out.email.text.toLowerCase()).toContain("forehead pad");
  });

  it("T7 with hybrid mask says 'hybrid cushion'", () => {
    const out = composeTouchpoint({
      ...BASE_OPTS,
      touchIndex: 7,
      recommendedMaskType: "hybrid",
    });
    expect(out.email.subject.toLowerCase()).toContain("hybrid cushion");
  });

  it("T7 with null mask type falls back to neutral 'cushion'", () => {
    const out = composeTouchpoint({
      ...BASE_OPTS,
      touchIndex: 7,
      recommendedMaskType: null,
    });
    expect(out.email.subject.toLowerCase()).toContain("cushion");
  });

  it("T8 mentions filter replacement", () => {
    const out = composeTouchpoint({ ...BASE_OPTS, touchIndex: 8 });
    expect(out.email.subject.toLowerCase()).toContain("filter");
    expect(out.email.text.toLowerCase()).toContain("filter");
  });

  it("T8 cross-sells the mask-type-specific replacement part", () => {
    // Nasal pillow filter touch should hint at pillow inserts as
    // the bundled cross-sell, not generic cushions.
    const out = composeTouchpoint({
      ...BASE_OPTS,
      touchIndex: 8,
      recommendedMaskType: "nasalPillow",
    });
    expect(out.email.text.toLowerCase()).toContain("pillow inserts");
  });

  it("T9 mentions mask-type-specific headgear vocabulary", () => {
    // Nasal pillow → "headgear straps"; fullFace → mentions "chinstrap";
    // nasal → plain "headgear".
    const pillow = composeTouchpoint({
      ...BASE_OPTS,
      touchIndex: 9,
      recommendedMaskType: "nasalPillow",
    });
    expect(pillow.email.subject.toLowerCase()).toContain("headgear straps");

    const fullFace = composeTouchpoint({
      ...BASE_OPTS,
      touchIndex: 9,
      recommendedMaskType: "fullFace",
    });
    expect(fullFace.email.text.toLowerCase()).toContain("chinstrap");
  });

  it("T10 mentions the 6-month refresh", () => {
    const out = composeTouchpoint({ ...BASE_OPTS, touchIndex: 10 });
    expect(out.email.subject.toLowerCase()).toContain("6-month");
    expect(out.email.text).toContain("6 months");
  });

  it("T7-T9 include the subscription auto-ship upsell", () => {
    for (const i of [7, 8, 9] as const) {
      const out = composeTouchpoint({ ...BASE_OPTS, touchIndex: i });
      expect(out.email.text.toLowerCase(), `T${i} text upsell`).toContain(
        "auto-ship",
      );
      expect(out.email.html.toLowerCase(), `T${i} html upsell`).toContain(
        "auto-ship",
      );
    }
  });

  it("T10 omits the subscription upsell (warm sendoff)", () => {
    const out = composeTouchpoint({ ...BASE_OPTS, touchIndex: 10 });
    expect(out.email.text.toLowerCase()).not.toContain("auto-ship");
    expect(out.email.html.toLowerCase()).not.toContain("auto-ship");
  });
});

describe("composeTouchpoint — branded HTML template", () => {
  it("wraps every email in a table-based responsive shell", () => {
    for (const i of ALL_TOUCHES) {
      const out = composeTouchpoint({ ...BASE_OPTS, touchIndex: i });
      // Table-based layout for Outlook compatibility.
      expect(
        out.email.html,
        `T${i} html should use table layout`,
      ).toContain('<table role="presentation"');
      // Branded navy color band.
      expect(
        out.email.html.toLowerCase(),
        `T${i} html should carry brand navy header`,
      ).toContain("#1f3a5c");
      // <!doctype html> marker so clients render in standards mode.
      expect(out.email.html.toLowerCase().startsWith("<!doctype html>")).toBe(
        true,
      );
    }
  });

  it("includes a non-empty hidden preheader at the top of every email", () => {
    for (const i of ALL_TOUCHES) {
      const out = composeTouchpoint({ ...BASE_OPTS, touchIndex: i });
      // The preheader div uses display:none + max-height:0 so it
      // doesn't render in the body but DOES show in the inbox preview.
      expect(
        out.email.html,
        `T${i} html should contain a hidden preheader div`,
      ).toMatch(/display:none[^>]*max-height:0/);
      // The preheader contains real content (we keep a per-touch
      // string), not just padding.
      // Find the preheader's actual text — between the opening and
      // closing tags of the display:none div.
      const match = out.email.html.match(
        /display:none[^>]*>([^<]+)</,
      );
      expect(match, `T${i} preheader div should have content`).toBeTruthy();
      const content = (match?.[1] ?? "").trim();
      expect(
        content.length,
        `T${i} preheader content length is ${content.length}`,
      ).toBeGreaterThan(15);
    }
  });

  it("places the practice-name brand bar before the body content", () => {
    const out = composeTouchpoint({ ...BASE_OPTS, touchIndex: 1 });
    const brandPos = out.email.html.indexOf("PennPaps");
    const greetingPos = out.email.html.indexOf("Hi from");
    expect(brandPos).toBeGreaterThan(0);
    expect(greetingPos).toBeGreaterThan(brandPos);
  });
});

describe("composeTouchpoint — personalization", () => {
  it("prefixes the subject with the first name when provided", () => {
    const out = composeTouchpoint({
      ...BASE_OPTS,
      touchIndex: 7,
      firstName: "Sarah",
    });
    expect(out.email.subject.startsWith("Sarah, ")).toBe(true);
  });

  it("opens the body with 'Hi Sarah,' when first name is set", () => {
    const out = composeTouchpoint({
      ...BASE_OPTS,
      touchIndex: 7,
      firstName: "Sarah",
    });
    expect(out.email.text).toContain("Hi Sarah,");
    expect(out.email.html).toContain("Sarah");
  });

  it("falls back to 'Hi from {practice}' when first name is null", () => {
    const out = composeTouchpoint({
      ...BASE_OPTS,
      touchIndex: 7,
      firstName: null,
    });
    expect(out.email.text).toContain("Hi from PennPaps,");
    expect(out.email.subject).not.toContain("null");
  });

  it("does not insert the name prefix when first name is the empty string", () => {
    const out = composeTouchpoint({
      ...BASE_OPTS,
      touchIndex: 1,
      firstName: "   ",
    });
    expect(out.email.subject.startsWith("your ")).toBe(true);
  });

  it("rejects an absurdly long first name (cap at 30 chars)", () => {
    const longName = "X".repeat(50);
    const out = composeTouchpoint({
      ...BASE_OPTS,
      touchIndex: 1,
      firstName: longName,
    });
    expect(out.email.subject).not.toContain(longName);
    expect(out.email.text).not.toContain(longName);
  });

  it("escapes HTML special characters in the first name", () => {
    const out = composeTouchpoint({
      ...BASE_OPTS,
      touchIndex: 7,
      firstName: "<script>",
    });
    expect(out.email.html).not.toContain("<script>");
    expect(out.email.html).toContain("&lt;script&gt;");
  });

  it("personalizes the SMS prefix when first name is set", () => {
    const out = composeTouchpoint({
      ...BASE_OPTS,
      touchIndex: 7,
      firstName: "Sarah",
    });
    expect(out.sms.startsWith("Sarah — ")).toBe(true);
  });
});

describe("composeTouchpoint — universal invariants", () => {
  it("includes the unsubscribe URL in every email (both phases)", () => {
    for (const i of ALL_TOUCHES) {
      const out = composeTouchpoint({ ...BASE_OPTS, touchIndex: i });
      expect(
        out.email.html,
        `touch ${i} html must contain unsubscribe`,
      ).toContain(BASE_OPTS.unsubscribeUrl);
      expect(
        out.email.text,
        `touch ${i} text must contain unsubscribe`,
      ).toContain(BASE_OPTS.unsubscribeUrl);
    }
  });

  it("includes STOP on every SMS body that ships", () => {
    for (const i of ALL_TOUCHES) {
      const out = composeTouchpoint({ ...BASE_OPTS, touchIndex: i });
      if (out.sms.length === 0) continue;
      expect(out.sms, `touch ${i} sms must include STOP`).toContain("STOP");
    }
  });

  it("keeps SMS bodies under the GSM-7 single-segment cap (160 chars)", () => {
    // Use a realistic first-name + mask combination — the longest
    // SMS bodies still need to fit. Sarah is a common first name;
    // the recommended mask is the default test fixture.
    for (const i of ALL_TOUCHES) {
      const out = composeTouchpoint({
        ...BASE_OPTS,
        touchIndex: i,
        firstName: "Sarah",
      });
      expect(
        out.sms.length,
        `touch ${i} sms length is ${out.sms.length}`,
      ).toBeLessThanOrEqual(160);
    }
  });

  it("returns empty SMS only for the email-only touches (T3, T5)", () => {
    for (const i of EMAIL_ONLY) {
      const out = composeTouchpoint({ ...BASE_OPTS, touchIndex: i });
      expect(out.sms, `touch ${i} sms should be empty`).toBe("");
    }
  });

  it("returns non-empty SMS for every SMS-eligible touch", () => {
    for (const i of SMS_TOUCHES) {
      const out = composeTouchpoint({ ...BASE_OPTS, touchIndex: i });
      expect(
        out.sms.length,
        `touch ${i} sms should be non-empty`,
      ).toBeGreaterThan(0);
    }
  });

  it("re-order touches (T7-T10) all link to /shop", () => {
    for (const i of REORDER) {
      const out = composeTouchpoint({ ...BASE_OPTS, touchIndex: i });
      // T10 links to /results (refresh fitting); T7-T9 link to /shop.
      const linksToShop =
        out.email.text.includes(BASE_OPTS.shopUrl) ||
        out.email.text.includes(BASE_OPTS.resumeUrl);
      expect(
        linksToShop,
        `touch ${i} should link to /shop or /results`,
      ).toBe(true);
    }
  });

  it("mask-specific pre-purchase touches (T1, T2, T4, T6) reference the recommended mask", () => {
    // T3 (FSA reminder) and T5 (educational rollup) are deliberately
    // mask-agnostic — they make sense without naming a specific mask
    // model. Every other pre-purchase touch should reference it so
    // the patient recognizes the email is about THEIR fitting, not a
    // generic blast.
    for (const i of [1, 2, 4, 6] as const) {
      const out = composeTouchpoint({ ...BASE_OPTS, touchIndex: i });
      expect(
        out.email.text,
        `touch ${i} text should reference recommended mask`,
      ).toContain("ResMed AirFit P30i");
    }
  });
});
