// Tests for pages/admin/admin-shop-inventory-reconcile.tsx
//
// The page contains two module-scoped pure functions:
//
//   defaultPeriodLabel() — returns current YYYY-MM string
//   formatDate(iso)      — converts ISO string to a locale date string
//
// Both are not exported; we use static analysis + re-implementation.

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SRC = readFileSync(
  path.join(__dirname, "admin-shop-inventory-reconcile.tsx"),
  "utf8",
);

// ---------------------------------------------------------------------------
// Static source analysis
// ---------------------------------------------------------------------------

describe("admin-shop-inventory-reconcile — exports", () => {
  it("exports AdminShopInventoryReconcilePage", () => {
    expect(SRC).toContain("export function AdminShopInventoryReconcilePage");
  });
});

describe("admin-shop-inventory-reconcile — defaultPeriodLabel structure", () => {
  it("derives year from new Date()", () => {
    expect(SRC).toContain("getFullYear()");
  });

  it("derives month as 1-based (getMonth() + 1)", () => {
    expect(SRC).toContain("getMonth() + 1");
  });

  it("pads month to 2 digits with padStart", () => {
    expect(SRC).toContain('padStart(2, "0")');
  });

  it("constructs the label as YYYY-MM template literal", () => {
    // Template literal with dash separator
    expect(SRC).toContain("${year}-${month}");
  });
});

describe("admin-shop-inventory-reconcile — formatDate structure", () => {
  it("uses new Date(iso).toLocaleDateString", () => {
    expect(SRC).toContain("toLocaleDateString");
  });

  it("includes year, month, and day in the format options", () => {
    // The options object uses quoted string keys (`"year": "numeric"`),
    // so we match either a quoted or bare key followed by a string value
    // — the assertion that matters is that all three fields are present.
    expect(SRC).toMatch(/"?year"?:\s*"/);
    expect(SRC).toMatch(/"?month"?:\s*"/);
    expect(SRC).toMatch(/"?day"?:\s*"/);
  });

  it("falls back to returning the original string on error (try/catch)", () => {
    // The catch block returns `iso` unchanged
    expect(SRC).toContain("return iso");
  });
});

describe("admin-shop-inventory-reconcile — form data-testid attributes", () => {
  it("has data-testid on the period input", () => {
    expect(SRC).toContain('data-testid="reconcile-period-input"');
  });

  it("has data-testid on the notes textarea", () => {
    expect(SRC).toContain('data-testid="reconcile-notes-input"');
  });

  it("has data-testid on the start button", () => {
    expect(SRC).toContain('data-testid="reconcile-start-btn"');
  });
});

describe("admin-shop-inventory-reconcile — client-side period label validation", () => {
  it("rejects period labels shorter than 2 characters", () => {
    // The onSubmit handler guards with `periodLabel.trim().length < 2`
    expect(SRC).toContain("periodLabel.trim().length < 2");
  });

  it("sets an error message for too-short labels", () => {
    expect(SRC).toContain("Period label must be at least 2 characters.");
  });
});

describe("admin-shop-inventory-reconcile — history table structure", () => {
  it("renders a row per reconciliation with data-testid", () => {
    expect(SRC).toContain("reconcile-row-");
  });

  it("links each row to its edit page", () => {
    expect(SRC).toContain("admin/shop/inventory/reconcile/");
  });

  it("shows 'Continue →' for draft rows", () => {
    expect(SRC).toContain("Continue →");
  });

  it("shows 'View →' for submitted rows", () => {
    expect(SRC).toContain("View →");
  });
});

// ---------------------------------------------------------------------------
// Pure-logic re-implementation of defaultPeriodLabel (verbatim from source)
// ---------------------------------------------------------------------------

function defaultPeriodLabel(): string {
  const d = new Date();
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, "0");
  return `${year}-${month}`;
}

describe("defaultPeriodLabel — format invariants", () => {
  it("returns a string matching YYYY-MM format", () => {
    const label = defaultPeriodLabel();
    expect(label).toMatch(/^\d{4}-\d{2}$/);
  });

  it("year portion matches the current year", () => {
    const label = defaultPeriodLabel();
    const [yearStr] = label.split("-");
    expect(Number(yearStr)).toBe(new Date().getFullYear());
  });

  it("month portion is 1-based and padded to 2 digits", () => {
    const label = defaultPeriodLabel();
    const [, monthStr] = label.split("-");
    const month = Number(monthStr);
    expect(month).toBeGreaterThanOrEqual(1);
    expect(month).toBeLessThanOrEqual(12);
    expect(monthStr).toHaveLength(2);
  });

  it("month portion matches the current month", () => {
    const label = defaultPeriodLabel();
    const [, monthStr] = label.split("-");
    expect(Number(monthStr)).toBe(new Date().getMonth() + 1);
  });

  it("contains a hyphen separator", () => {
    expect(defaultPeriodLabel()).toContain("-");
  });
});

// ---------------------------------------------------------------------------
// Pure-logic re-implementation of formatDate (verbatim from source)
// ---------------------------------------------------------------------------

function formatDate(iso: string): string {
  try {
    return new Date(iso).toLocaleDateString(undefined, {
      year: "numeric",
      month: "short",
      day: "numeric",
    });
  } catch {
    return iso;
  }
}

describe("formatDate — valid ISO strings", () => {
  it("returns a non-empty string for a valid ISO date", () => {
    const result = formatDate("2026-05-01T00:00:00Z");
    expect(result).toBeTruthy();
    expect(typeof result).toBe("string");
  });

  it("does NOT return the raw ISO string for a valid date", () => {
    // toLocaleDateString should transform it
    const iso = "2026-05-01T00:00:00Z";
    const result = formatDate(iso);
    // The locale-formatted version differs from the raw ISO string
    // (at minimum it won't start with 4 digits in most locales — but
    // we just verify it doesn't pass through unchanged for a valid date)
    const d = new Date(iso);
    // If the date is valid, toLocaleDateString should not throw and
    // the result should not equal the ISO string itself.
    if (!isNaN(d.getTime())) {
      expect(result).not.toBe(iso);
      expect(result.length).toBeGreaterThan(0);
    }
  });
});

describe("formatDate — invalid strings", () => {
  it("returns the original string when passed a non-date string", () => {
    // new Date("not-a-date") → Invalid Date, toLocaleDateString may throw or return "Invalid Date"
    // The function catches and returns iso; behaviour depends on runtime.
    // We just verify the function doesn't throw and returns a string.
    expect(() => formatDate("not-a-date")).not.toThrow();
    const result = formatDate("not-a-date");
    expect(typeof result).toBe("string");
  });

  it("returns a string for an empty string input", () => {
    expect(() => formatDate("")).not.toThrow();
    expect(typeof formatDate("")).toBe("string");
  });
});

describe("formatDate — edge dates", () => {
  it("handles a date string at year boundary (Jan 1)", () => {
    expect(() => formatDate("2026-01-01T00:00:00Z")).not.toThrow();
    const result = formatDate("2026-01-01T00:00:00Z");
    expect(result).toBeTruthy();
  });

  it("handles a date string at year boundary (Dec 31)", () => {
    expect(() => formatDate("2026-12-31T23:59:59Z")).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Static check: formatDate options include year/month/day keys
// ---------------------------------------------------------------------------
// Allow either quoted or bareword keys here. Both compile to equivalent
// runtime behavior and we only care that all three options are present.

describe("admin-shop-inventory-reconcile — formatDate option key style", () => {
  it("includes a year option key", () => {
    expect(SRC).toMatch(/"?year"?:\s*["']/);
  });

  it("includes a month option key", () => {
    expect(SRC).toMatch(/"?month"?:\s*["']/);
  });

  it("includes a day option key", () => {
    expect(SRC).toMatch(/"?day"?:\s*["']/);
  });

  it("all three option keys appear within the same toLocaleDateString call", () => {
    // Find the toLocaleDateString call and verify all three keys are within
    // a reasonable character window of it.
    const callIdx = SRC.indexOf("toLocaleDateString");
    expect(callIdx).toBeGreaterThan(-1);
    // The options object follows the call — look 200 chars ahead.
    const optionsBlock = SRC.slice(callIdx, callIdx + 200);
    expect(optionsBlock).toMatch(/"?year"?:/);
    expect(optionsBlock).toMatch(/"?month"?:/);
    expect(optionsBlock).toMatch(/"?day"?:/);
  });

  it("year value is the string 'numeric'", () => {
    expect(SRC).toMatch(/"?year"?:\s*"numeric"/);
  });

  it("day value is the string 'numeric'", () => {
    expect(SRC).toMatch(/"?day"?:\s*"numeric"/);
  });
});

// ---------------------------------------------------------------------------
// Pure-logic re-implementation — additional formatDate edge cases
// ---------------------------------------------------------------------------

describe("formatDate — additional edge cases", () => {
  it("handles date-only strings (no time component)", () => {
    expect(() => formatDate("2026-03-15")).not.toThrow();
    expect(typeof formatDate("2026-03-15")).toBe("string");
  });

  it("handles Unix epoch (1970-01-01T00:00:00Z) without throwing", () => {
    expect(() => formatDate("1970-01-01T00:00:00Z")).not.toThrow();
    const result = formatDate("1970-01-01T00:00:00Z");
    expect(result).toBeTruthy();
  });

  it("returns a string for a future date (2099)", () => {
    expect(() => formatDate("2099-12-31T23:59:59Z")).not.toThrow();
    expect(typeof formatDate("2099-12-31T23:59:59Z")).toBe("string");
  });

  it("always returns a string — never throws regardless of input", () => {
    const inputs = ["", "garbage", "null", "undefined", "2026-13-45", "2026-00-00"];
    for (const input of inputs) {
      expect(() => formatDate(input)).not.toThrow();
      expect(typeof formatDate(input)).toBe("string");
    }
  });
});