// Tests for display formatters in format.ts.
//
// The key regression this covers: `formatDate("2026-05-22")` was
// previously implemented as `new Date("2026-05-22")`, which parses as
// UTC midnight.  In a US timezone (negative UTC offset) that renders as
// the *previous* calendar day.  The fix builds the Date from the
// year/month/day parts in local time so the display is always correct
// regardless of the local offset.
//
// The tests are timezone-sensitive by design: they assert the
// *day/month/year* components of the formatted string rather than the
// exact locale string, so they pass in any locale's timezone.

import { describe, expect, it } from "vitest";
import { formatDate, formatDateTime, fullName } from "./format";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Given a formatted date string produced by Intl.DateTimeFormat, extract the
 * numeric day.  We intentionally avoid asserting the exact locale string (e.g.
 * "May 22, 2026") because the Node.js process locale may differ across CI
 * environments, causing fragile failures.  The numeric day is locale-invariant.
 */
function extractDay(formatted: string): number {
  // Handles: "May 22, 2026", "22 May 2026", "22/05/2026", etc.
  const match = formatted.match(/\b(\d{1,2})\b/);
  if (!match) throw new Error(`Cannot extract day from: ${formatted}`);
  return Number(match[1]);
}

function extractYear(formatted: string): number {
  const match = formatted.match(/\b(20\d{2})\b/);
  if (!match) throw new Error(`Cannot extract year from: ${formatted}`);
  return Number(match[1]);
}

// ---------------------------------------------------------------------------
// formatDate — null / undefined / empty
// ---------------------------------------------------------------------------

describe("formatDate — null/undefined/empty guard", () => {
  it("returns '—' for null", () => {
    expect(formatDate(null)).toBe("—");
  });

  it("returns '—' for undefined", () => {
    expect(formatDate(undefined)).toBe("—");
  });

  it("returns '—' for an empty string", () => {
    expect(formatDate("")).toBe("—");
  });
});

// ---------------------------------------------------------------------------
// formatDate — invalid input
// ---------------------------------------------------------------------------

describe("formatDate — invalid date strings", () => {
  it("returns '—' for a garbage string", () => {
    expect(formatDate("not-a-date")).toBe("—");
  });

  it("returns '—' for a partially-valid string", () => {
    expect(formatDate("2026-13-01")).toBe("—");
  });
});

// ---------------------------------------------------------------------------
// formatDate — date-only (YYYY-MM-DD) timezone regression
// ---------------------------------------------------------------------------

describe("formatDate — date-only YYYY-MM-DD (timezone regression)", () => {
  // Before the fix, `new Date("2026-05-22")` parsed as UTC midnight, and a
  // US-west timezone (UTC-7/8) would render it as "May 21".  The fix builds
  // the Date in local time so the displayed day always matches the input day.

  it("displays the correct calendar day for a YYYY-MM-DD string (not the day before)", () => {
    const formatted = formatDate("2026-05-22");
    expect(formatted).not.toBe("—");
    // The numeric day present in the output must be 22 (not 21, as the old
    // UTC-parse bug would produce in a UTC-7 or earlier timezone).
    expect(extractDay(formatted)).toBe(22);
  });

  it("displays the correct year for a YYYY-MM-DD string", () => {
    const formatted = formatDate("2026-05-22");
    expect(extractYear(formatted)).toBe(2026);
  });

  it("renders Jan 1 correctly (month boundary)", () => {
    const formatted = formatDate("2026-01-01");
    expect(formatted).not.toBe("—");
    expect(extractDay(formatted)).toBe(1);
    expect(extractYear(formatted)).toBe(2026);
  });

  it("renders Dec 31 correctly (year boundary)", () => {
    const formatted = formatDate("2025-12-31");
    expect(formatted).not.toBe("—");
    expect(extractDay(formatted)).toBe(31);
    expect(extractYear(formatted)).toBe(2025);
  });

  it("renders Feb 29 on a leap year", () => {
    // 2024 is a leap year; Feb 29 is valid.
    const formatted = formatDate("2024-02-29");
    expect(formatted).not.toBe("—");
    expect(extractDay(formatted)).toBe(29);
    expect(extractYear(formatted)).toBe(2024);
  });

  it("returns '—' for a YYYY-MM-DD with an out-of-range month", () => {
    // Month 13 is invalid; the Date constructor produces NaN.
    expect(formatDate("2026-13-01")).toBe("—");
  });
});

// ---------------------------------------------------------------------------
// formatDate — full ISO timestamp (instant-based parse preserved)
// ---------------------------------------------------------------------------

describe("formatDate — full ISO timestamp", () => {
  // Full ISO strings include a time component so they are already unambiguous
  // instants.  The fix must NOT change how they are handled — they still go
  // through `new Date(value)` and then the local timezone renders the date.

  it("accepts an ISO timestamp without returning '—'", () => {
    // We can't assert the exact day because it depends on the local timezone,
    // but we can assert it returns something valid and doesn't regress to '—'.
    const formatted = formatDate("2026-05-22T12:00:00.000Z");
    expect(formatted).not.toBe("—");
  });

  it("returns '—' for an invalid ISO timestamp", () => {
    expect(formatDate("2026-05-22T99:00:00.000Z")).toBe("—");
  });
});

// ---------------------------------------------------------------------------
// formatDateTime — basic smoke tests (unchanged code)
// ---------------------------------------------------------------------------

describe("formatDateTime", () => {
  it("returns '—' for null", () => {
    expect(formatDateTime(null)).toBe("—");
  });

  it("returns '—' for undefined", () => {
    expect(formatDateTime(undefined)).toBe("—");
  });

  it("returns a non-empty string for a valid ISO timestamp", () => {
    const formatted = formatDateTime("2026-05-22T15:30:00.000Z");
    expect(formatted).not.toBe("—");
    expect(typeof formatted).toBe("string");
  });

  it("returns '—' for a garbage string", () => {
    expect(formatDateTime("not-a-date")).toBe("—");
  });
});

// ---------------------------------------------------------------------------
// fullName
// ---------------------------------------------------------------------------

describe("fullName", () => {
  it("combines first and last names", () => {
    expect(fullName("Jane", "Doe")).toBe("Jane Doe");
  });

  it("returns just the first name when last name is null", () => {
    expect(fullName("Jane", null)).toBe("Jane");
  });

  it("returns just the last name when first name is null", () => {
    expect(fullName(null, "Doe")).toBe("Doe");
  });

  it("returns '—' when both names are null", () => {
    expect(fullName(null, null)).toBe("—");
  });

  it("trims whitespace", () => {
    expect(fullName("  Jane  ", "  Doe  ")).toBe("Jane Doe");
  });

  it("returns '—' when both names are empty strings", () => {
    expect(fullName("", "")).toBe("—");
  });
});
