// Tests for the i18n/locales module after the Spanish-locale retirement.
//
// The PR retired the "es" locale (AI-drafted, never reviewed) and left the
// module English-only. These tests assert the new shape of the exported
// constants so any accidental re-introduction of unreviewed translations, or
// a drift in the SUPPORTED_LOCALES array, surfaces at test time.

import { describe, expect, it } from "vitest";

import {
  LOCALE_LABEL,
  SUPPORTED_LOCALES,
  TRANSLATIONS,
  type Locale,
  type TranslationKey,
} from "./locales";

// ---------------------------------------------------------------------------
// SUPPORTED_LOCALES
// ---------------------------------------------------------------------------
describe("SUPPORTED_LOCALES", () => {
  it("contains exactly one locale", () => {
    expect(SUPPORTED_LOCALES).toHaveLength(1);
  });

  it("contains 'en' as the sole supported locale", () => {
    expect(SUPPORTED_LOCALES).toContain("en");
  });

  it("does not contain 'es'", () => {
    // Regression: the 'es' locale was retired in this PR.
    expect(SUPPORTED_LOCALES).not.toContain("es");
  });

  it("is readonly (tuple does not mutate with push)", () => {
    // The array is typed as `readonly Locale[]`; verify the runtime value
    // is the exact array we expect and doesn't silently grow.
    expect([...SUPPORTED_LOCALES]).toStrictEqual(["en"]);
  });
});

// ---------------------------------------------------------------------------
// LOCALE_LABEL
// ---------------------------------------------------------------------------
describe("LOCALE_LABEL", () => {
  it("has exactly one key: 'en'", () => {
    expect(Object.keys(LOCALE_LABEL)).toStrictEqual(["en"]);
  });

  it("maps 'en' to a non-empty display label", () => {
    expect(LOCALE_LABEL.en).toBeTruthy();
    expect(typeof LOCALE_LABEL.en).toBe("string");
  });

  it("maps 'en' to 'English'", () => {
    expect(LOCALE_LABEL.en).toBe("English");
  });

  it("does not contain an 'es' key", () => {
    // Regression: the Spanish display label was removed.
    expect(Object.keys(LOCALE_LABEL)).not.toContain("es");
  });
});

// ---------------------------------------------------------------------------
// TRANSLATIONS
// ---------------------------------------------------------------------------
describe("TRANSLATIONS", () => {
  it("has exactly one locale key: 'en'", () => {
    expect(Object.keys(TRANSLATIONS)).toStrictEqual(["en"]);
  });

  it("does not contain an 'es' translation dictionary", () => {
    // Regression: the Spanish translations were retired in this PR.
    expect(Object.keys(TRANSLATIONS)).not.toContain("es");
  });

  it("TRANSLATIONS['en'] is defined", () => {
    expect(TRANSLATIONS.en).toBeDefined();
    expect(typeof TRANSLATIONS.en).toBe("object");
  });

  it("TRANSLATIONS['en'] contains all required translation keys", () => {
    const required: TranslationKey[] = [
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
      "track.formSubtitleAccountPrefix",
      "track.formSubtitleAccountLink",
      "track.fieldReference",
      "track.fieldEmail",
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

    for (const key of required) {
      expect(
        TRANSLATIONS.en[key],
        `TRANSLATIONS.en["${key}"] should be present`,
      ).toBeDefined();
    }
  });

  it("every English translation value is a non-empty string", () => {
    for (const [key, value] of Object.entries(TRANSLATIONS.en)) {
      expect(
        typeof value,
        `TRANSLATIONS.en["${key}"] should be a string`,
      ).toBe("string");
      expect(
        (value as string).length,
        `TRANSLATIONS.en["${key}"] should not be empty`,
      ).toBeGreaterThan(0);
    }
  });

  it("home page translation keys have meaningful copy (smoke)", () => {
    expect(TRANSLATIONS.en["home.headline"]).toContain("CPAP");
    expect(TRANSLATIONS.en["home.ctaPrimary"].length).toBeGreaterThan(5);
  });

  it("track page translation keys are present and non-empty (smoke)", () => {
    expect(TRANSLATIONS.en["track.headline"]).toContain("order");
    expect(TRANSLATIONS.en["track.errorNotFound"].length).toBeGreaterThan(10);
  });
});

// ---------------------------------------------------------------------------
// Locale type narrowness
// ---------------------------------------------------------------------------
describe("Locale type (runtime shape)", () => {
  it("SUPPORTED_LOCALES entries satisfy Locale union at runtime", () => {
    // Every entry in the array should be a valid Locale value.
    for (const locale of SUPPORTED_LOCALES) {
      // TypeScript already enforces this at compile time; at runtime we
      // verify no stray value slipped through a type assertion.
      const validLocales: string[] = ["en"];
      expect(validLocales).toContain(locale as string);
    }
  });

  it("SUPPORTED_LOCALES[0] is 'en'", () => {
    const first: Locale = SUPPORTED_LOCALES[0]!;
    expect(first).toBe("en");
  });
});