import { describe, it, expect } from "vitest";
import { DOB_MIN, isPlausibleDob } from "./dob-validation";
import { appDateIsoOffset, todayAppDateIso } from "./utils";

// ---------------------------------------------------------------------------
// isPlausibleDob
// ---------------------------------------------------------------------------
describe("isPlausibleDob", () => {
  describe("valid dates within range", () => {
    it("accepts a typical adult birth date", () => {
      expect(isPlausibleDob("1985-06-15")).toBe(true);
    });

    it("accepts the minimum boundary date 1900-01-01", () => {
      expect(isPlausibleDob(DOB_MIN)).toBe(true);
    });

    it("accepts a birth date in the year 2000", () => {
      expect(isPlausibleDob("2000-01-01")).toBe(true);
    });

    it("accepts today's date (same-day newborn registration)", () => {
      expect(isPlausibleDob(todayAppDateIso())).toBe(true);
    });

    it("accepts a leap-year date that actually exists (2000-02-29)", () => {
      expect(isPlausibleDob("2000-02-29")).toBe(true);
    });

    it("accepts the last day of a 31-day month (2000-01-31)", () => {
      expect(isPlausibleDob("2000-01-31")).toBe(true);
    });

    it("accepts the last day of a 30-day month (2000-04-30)", () => {
      expect(isPlausibleDob("2000-04-30")).toBe(true);
    });
  });

  describe("dates before the minimum boundary", () => {
    it("rejects 1899-12-31 (one day before DOB_MIN)", () => {
      expect(isPlausibleDob("1899-12-31")).toBe(false);
    });

    it("rejects year 0001", () => {
      expect(isPlausibleDob("0001-01-01")).toBe(false);
    });

    it("rejects 1899-01-01", () => {
      expect(isPlausibleDob("1899-01-01")).toBe(false);
    });
  });

  describe("future dates", () => {
    it("rejects tomorrow's date", () => {
      expect(isPlausibleDob(appDateIsoOffset(1))).toBe(false);
    });

    it("rejects a year far in the future", () => {
      expect(isPlausibleDob("2099-01-01")).toBe(false);
    });

    it("rejects next year's date", () => {
      const nextYear = new Date().getUTCFullYear() + 1;
      expect(isPlausibleDob(`${nextYear}-06-15`)).toBe(false);
    });
  });

  describe("calendar-invalid dates (Date.UTC rollover trap)", () => {
    it("rejects 2000-02-30 (Feb has at most 29 days even in a leap year)", () => {
      // Date.UTC(2000, 1, 30) silently rolls over to 2000-03-01;
      // the round-trip check must catch this.
      expect(isPlausibleDob("2000-02-30")).toBe(false);
    });

    it("rejects 2001-02-29 (2001 is not a leap year)", () => {
      expect(isPlausibleDob("2001-02-29")).toBe(false);
    });

    it("rejects 2000-13-01 (month 13 does not exist)", () => {
      expect(isPlausibleDob("2000-13-01")).toBe(false);
    });

    it("rejects 2000-04-31 (April has only 30 days)", () => {
      expect(isPlausibleDob("2000-04-31")).toBe(false);
    });

    it("rejects 2000-00-01 (month 0 does not exist)", () => {
      expect(isPlausibleDob("2000-00-01")).toBe(false);
    });

    it("rejects 2000-01-00 (day 0 does not exist)", () => {
      expect(isPlausibleDob("2000-01-00")).toBe(false);
    });
  });

  describe("malformed / non-date input", () => {
    it("rejects an empty string", () => {
      expect(isPlausibleDob("")).toBe(false);
    });

    it("rejects a string with no dashes (YYYYMMDD format)", () => {
      expect(isPlausibleDob("19850615")).toBe(false);
    });

    it("rejects a US-format date (MM/DD/YYYY)", () => {
      expect(isPlausibleDob("06/15/1985")).toBe(false);
    });

    it("rejects a partial date (YYYY-MM only)", () => {
      expect(isPlausibleDob("1985-06")).toBe(false);
    });

    it("rejects non-canonical date parts (must be zero-padded YYYY-MM-DD)", () => {
      expect(isPlausibleDob("1985-6-15")).toBe(false);
    });

    it("rejects non-numeric year", () => {
      expect(isPlausibleDob("abcd-06-15")).toBe(false);
    });

    it("rejects non-numeric month", () => {
      expect(isPlausibleDob("1985-ab-15")).toBe(false);
    });

    it("rejects non-numeric day", () => {
      expect(isPlausibleDob("1985-06-ab")).toBe(false);
    });

    it("rejects a plain text string", () => {
      expect(isPlausibleDob("not-a-date")).toBe(false);
    });

    it("rejects an ISO datetime string (has time component)", () => {
      // The Zod regex rejects these before isPlausibleDob is called, but the
      // function itself should still return false rather than silently accept.
      expect(isPlausibleDob("1985-06-15T00:00:00.000Z")).toBe(false);
    });
  });

  describe("edge cases around today boundary", () => {
    it("accepts a date 1 day before today", () => {
      expect(isPlausibleDob(appDateIsoOffset(-1))).toBe(true);
    });

    it("uses the New York date at the UTC-midnight boundary", () => {
      const fixed = new Date("2025-03-15T00:00:00.000Z");
      const realDate = globalThis.Date;
      const MockDate = class extends realDate {
        constructor(...args: unknown[]) {
          if (args.length === 0) {
            super(fixed.getTime());
          } else {
            // @ts-expect-error spread over constructor overloads
            super(...args);
          }
        }
        static override UTC = realDate.UTC;
        static override now() {
          return fixed.getTime();
        }
      } as typeof Date;
      globalThis.Date = MockDate;
      try {
        expect(isPlausibleDob("2025-03-14")).toBe(true);
        expect(isPlausibleDob("2025-03-15")).toBe(false);
      } finally {
        globalThis.Date = realDate;
      }
    });
  });

  describe("regression: zero-component values produced by parseInt on non-numeric input", () => {
    it("rejects '0000-01-01' (year 0 parses as 0 which is falsy)", () => {
      // y=0 is falsy in JS, so the early !y guard must reject it.
      expect(isPlausibleDob("0000-01-01")).toBe(false);
    });
  });
});
