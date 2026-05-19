// Tests for the PR change that retires the Spanish locale and makes
// the app English-only.
//
// PR change summary
// -----------------
// - `Locale` type narrowed from "en" | "es" to "en".
// - `SUPPORTED_LOCALES` reduced from ["en", "es"] to ["en"].
// - `LOCALE_LABEL` now only holds the "en" → "English" entry.
// - The `es` translation dictionary and its entry in TRANSLATIONS
//   were deleted entirely.
// - TRANSLATIONS still carries the full English dictionary under the
//   "en" key so existing `t(key)` call sites are unaffected.
//
// Why test this here (not in a React/DOM test)?
// The vitest config runs in "node" environment. locales.ts is pure
// TypeScript with no DOM dependencies, so it can be imported and
// exercised directly.

import { describe, expect, it } from "vitest";

import {
  LOCALE_LABEL,
  SUPPORTED_LOCALES,
  TRANSLATIONS,
  type Locale,
  type TranslationKey,
} from "./locales";

// ── Locale type fixtures ─────────────────────────────────────────────────────

/** Valid locale value (the only one that should exist post-PR). */
const EN_LOCALE: Locale = "en";

describe("SUPPORTED_LOCALES — PR change: English-only", () => {
  it("contains exactly one entry", () => {
    expect(SUPPORTED_LOCALES).toHaveLength(1);
  });

  it('contains "en" as the sole supported locale', () => {
    expect(SUPPORTED_LOCALES).toContain(EN_LOCALE);
  });

  it('does NOT contain "es" (Spanish locale was retired)', () => {
    // This is the regression guard: the es locale was AI-drafted and
    // never reviewed, so it must not silently slip back in.
    expect(SUPPORTED_LOCALES).not.toContain("es");
  });

  it("is a non-empty readonly array", () => {
    expect(SUPPORTED_LOCALES.length).toBeGreaterThan(0);
  });

  it("contains only strings (no nulls or undefined)", () => {
    for (const locale of SUPPORTED_LOCALES) {
      expect(typeof locale).toBe("string");
      expect(locale).toBeTruthy();
    }
  });
});

describe("LOCALE_LABEL — PR change: English-only", () => {
  it('maps "en" to "English"', () => {
    expect(LOCALE_LABEL[EN_LOCALE]).toBe("English");
  });

  it('does NOT have an "es" key (Spanish label was removed)', () => {
    // Cast to access a potentially absent key without a TS error.
    expect((LOCALE_LABEL as Record<string, string>)["es"]).toBeUndefined();
  });

  it("has exactly one entry", () => {
    expect(Object.keys(LOCALE_LABEL)).toHaveLength(1);
  });

  it("produces a non-empty display label for the English locale", () => {
    expect(LOCALE_LABEL["en"].length).toBeGreaterThan(0);
  });
});

describe("TRANSLATIONS — PR change: English-only", () => {
  it('has an "en" top-level key', () => {
    expect(TRANSLATIONS).toHaveProperty("en");
  });

  it('does NOT have an "es" top-level key', () => {
    expect(TRANSLATIONS).not.toHaveProperty("es");
  });

  it("has exactly one locale entry", () => {
    expect(Object.keys(TRANSLATIONS)).toHaveLength(1);
  });

  it('TRANSLATIONS["en"] is a non-empty object', () => {
    const enDict = TRANSLATIONS["en"];
    expect(typeof enDict).toBe("object");
    expect(Object.keys(enDict).length).toBeGreaterThan(0);
  });

  it('every TRANSLATIONS["en"] value is a non-empty string', () => {
    const enDict = TRANSLATIONS["en"];
    for (const [key, value] of Object.entries(enDict)) {
      expect(typeof value, `key "${key}" should be a string`).toBe("string");
      expect(value.length, `key "${key}" should be non-empty`).toBeGreaterThan(
        0,
      );
    }
  });
});

describe("TranslationKey coverage — spot-check known keys", () => {
  // These are the keys that existed in both en and es before the PR;
  // verifying them here ensures the en dictionary is intact after the
  // Spanish entries were removed.

  const knownKeys: TranslationKey[] = [
    "common.languageToggle",
    "common.changeLanguage",
    "home.eyebrow",
    "home.headline",
    "home.subhead",
    "home.ctaPrimary",
    "home.ctaSecondary",
    "track.badge",
    "track.headline",
    "track.intro",
    "track.formTitle",
    "track.submit",
    "track.submitting",
    "track.lookupAnother",
    "track.errorNotFound",
    "track.errorRateLimited",
    "track.errorGeneric",
    "track.resultLabelStatus",
    "track.resultLabelReference",
    "track.resultLabelMask",
    "track.resultLabelSubmitted",
    "track.statusReceived.label",
    "track.statusReceived.description",
    "track.statusProcessing.label",
    "track.statusProcessing.description",
    "track.statusDeliveryIssue.label",
    "track.statusDeliveryIssue.description",
  ];

  it.each(knownKeys)('TRANSLATIONS["en"] has key "%s"', (key) => {
    expect(TRANSLATIONS["en"]).toHaveProperty(key);
  });

  it("no key in the English dictionary has an empty string value", () => {
    const enDict = TRANSLATIONS["en"];
    for (const [key, value] of Object.entries(enDict)) {
      expect(
        value,
        `"${key}" must have a non-empty translation`,
      ).not.toBe("");
    }
  });

  it("home CTA strings are distinct (primary ≠ secondary)", () => {
    const en = TRANSLATIONS["en"];
    expect(en["home.ctaPrimary"]).not.toBe(en["home.ctaSecondary"]);
  });

  it("track.submit and track.submitting are distinct strings", () => {
    const en = TRANSLATIONS["en"];
    expect(en["track.submit"]).not.toBe(en["track.submitting"]);
  });

  it("all three track error keys are distinct", () => {
    const en = TRANSLATIONS["en"];
    const errors = [
      en["track.errorNotFound"],
      en["track.errorRateLimited"],
      en["track.errorGeneric"],
    ];
    expect(new Set(errors).size).toBe(3);
  });

  it("order-status label/description pairs are distinct within each status", () => {
    const en = TRANSLATIONS["en"];
    expect(en["track.statusReceived.label"]).not.toBe(
      en["track.statusReceived.description"],
    );
    expect(en["track.statusProcessing.label"]).not.toBe(
      en["track.statusProcessing.description"],
    );
    expect(en["track.statusDeliveryIssue.label"]).not.toBe(
      en["track.statusDeliveryIssue.description"],
    );
  });
});