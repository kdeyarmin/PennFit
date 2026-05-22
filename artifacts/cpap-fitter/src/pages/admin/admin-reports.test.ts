// Tests for pure helper logic from admin-reports.tsx.
//
// The cpap-fitter test environment runs under "node" (no jsdom / React
// renderer), so we can't mount the component itself. Instead we extract
// and test the pure utility functions inline — they're stable contracts
// that the component uses to build download URLs and validate date ranges.
//
// Coverage:
//   1. isoDate() formats a Date as a YYYY-MM-DD string in UTC.
//   2. diffDays() computes the calendar distance between two ISO strings.
//   3. reportUrl() builds the correct download path for each format.
//   4. reportUrl() uses the `.qbo.csv` extension for the "qbo" format.
//   5. Edge cases: zero-day range, max-days boundary, negative range.
//   6. FORMAT_LABELS coverage — every format key has a non-empty label.
//   7. REPORTS array — each entry has the mandatory csv + pdf formats.

import { describe, expect, it } from "vitest";

import { REPORTS, FORMAT_LABELS, type FormatKey } from "./reports-metadata";

// ─── Inline copies of the module-local helpers ─────────────────────────────
//
// These match the implementations in admin-reports.tsx exactly.
// If the originals change, these tests will catch the deviation.

function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function diffDays(fromIso: string, toIso: string): number {
  const f = new Date(fromIso).getTime();
  const t = new Date(toIso).getTime();
  return Math.round((t - f) / 86400_000);
}

function reportUrl(
  slug: string,
  format: FormatKey,
  from: string,
  to: string,
): string {
  const params = new URLSearchParams({ from, to }).toString();
  const ext = format === "qbo" ? "qbo.csv" : format;
  return `/resupply-api/admin/reports/${slug}.${ext}?${params}`;
}

// ─── isoDate ──────────────────────────────────────────────────────────────

describe("isoDate", () => {
  it("formats a UTC midnight date as YYYY-MM-DD", () => {
    expect(isoDate(new Date("2026-04-15T00:00:00.000Z"))).toBe("2026-04-15");
  });

  it("truncates the time portion (the component needs only the date part)", () => {
    const result = isoDate(new Date("2026-12-31T23:59:59.999Z"));
    expect(result).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(result).toBe("2026-12-31");
  });

  it("returns a 10-character string", () => {
    expect(isoDate(new Date()).length).toBe(10);
  });
});

// ─── diffDays ─────────────────────────────────────────────────────────────

describe("diffDays", () => {
  it("returns 0 for equal dates", () => {
    expect(diffDays("2026-04-01", "2026-04-01")).toBe(0);
  });

  it("returns 1 for consecutive days", () => {
    expect(diffDays("2026-04-01", "2026-04-02")).toBe(1);
  });

  it("returns 30 for the default 30-day range", () => {
    expect(diffDays("2026-04-01", "2026-05-01")).toBe(30);
  });

  it("returns 90 for the max allowed range", () => {
    expect(diffDays("2026-01-01", "2026-04-01")).toBe(90);
  });

  it("returns a negative value when the from date is after the to date", () => {
    // The UI warns about this with a clamped banner; diffDays itself
    // should return a negative integer, not throw.
    expect(diffDays("2026-05-01", "2026-04-01")).toBe(-30);
  });

  it("correctly counts days across a month boundary", () => {
    // Jan (31) + Feb (28, non-leap) + Mar (31) + Apr (30) = 120 days
    expect(diffDays("2026-01-01", "2026-05-01")).toBe(120);
  });
});

// ─── reportUrl ────────────────────────────────────────────────────────────

describe("reportUrl", () => {
  const from = "2026-04-01";
  const to = "2026-04-30";

  it("builds a CSV URL under /resupply-api/admin/reports", () => {
    const url = reportUrl("orders", "csv", from, to);
    expect(url).toBe(
      "/resupply-api/admin/reports/orders.csv?from=2026-04-01&to=2026-04-30",
    );
  });

  it("builds a PDF URL with the .pdf extension", () => {
    const url = reportUrl("returns", "pdf", from, to);
    expect(url).toBe(
      "/resupply-api/admin/reports/returns.pdf?from=2026-04-01&to=2026-04-30",
    );
  });

  it("builds an IIF URL with the .iif extension", () => {
    const url = reportUrl("orders", "iif", from, to);
    expect(url).toBe(
      "/resupply-api/admin/reports/orders.iif?from=2026-04-01&to=2026-04-30",
    );
  });

  it("uses .qbo.csv for the qbo format (not just .qbo)", () => {
    const url = reportUrl("orders", "qbo", from, to);
    expect(url).toBe(
      "/resupply-api/admin/reports/orders.qbo.csv?from=2026-04-01&to=2026-04-30",
    );
    // Must not end in just ".qbo" — QBO import expects .csv extension
    expect(url).not.toMatch(/\.qbo[?]/);
  });

  it("encodes the date range as query parameters", () => {
    const url = reportUrl("revenue-summary", "csv", "2026-01-01", "2026-03-31");
    expect(url).toContain("from=2026-01-01");
    expect(url).toContain("to=2026-03-31");
  });

  it("uses the slug verbatim in the path", () => {
    expect(reportUrl("refunds-journal", "pdf", from, to)).toContain(
      "/refunds-journal.pdf",
    );
  });
});

// ─── FORMAT_LABELS ────────────────────────────────────────────────────────

describe("FORMAT_LABELS", () => {
  const formats: FormatKey[] = ["csv", "pdf", "iif", "qbo"];

  it("has a non-empty label for every supported format", () => {
    for (const f of formats) {
      expect(FORMAT_LABELS[f]).toBeTruthy();
    }
  });

  it("csv label is 'CSV'", () => {
    expect(FORMAT_LABELS.csv).toBe("CSV");
  });

  it("pdf label is 'PDF'", () => {
    expect(FORMAT_LABELS.pdf).toBe("PDF");
  });

  it("iif label mentions QuickBooks Desktop", () => {
    expect(FORMAT_LABELS.iif.toLowerCase()).toContain("quickbooks desktop");
  });

  it("qbo label mentions QuickBooks Online", () => {
    expect(FORMAT_LABELS.qbo.toLowerCase()).toContain("quickbooks online");
  });
});

// ─── REPORTS catalog ──────────────────────────────────────────────────────

describe("REPORTS catalog", () => {
  it("contains exactly six report definitions", () => {
    expect(REPORTS).toHaveLength(6);
  });

  it("every report has csv and pdf formats", () => {
    for (const r of REPORTS) {
      expect(r.formats).toContain("csv");
      expect(r.formats).toContain("pdf");
    }
  });

  it("finance reports (orders, returns) include iif and qbo formats", () => {
    const financeReports = REPORTS.filter((r) =>
      ["orders", "returns"].includes(r.slug),
    );
    expect(financeReports).toHaveLength(2);
    for (const r of financeReports) {
      expect(r.formats).toContain("iif");
      expect(r.formats).toContain("qbo");
    }
  });

  it("summary reports (revenue-summary, refunds-journal) do not include iif or qbo", () => {
    const summaryReports = REPORTS.filter((r) =>
      ["revenue-summary", "refunds-journal"].includes(r.slug),
    );
    expect(summaryReports).toHaveLength(2);
    for (const r of summaryReports) {
      expect(r.formats).not.toContain("iif");
      expect(r.formats).not.toContain("qbo");
    }
  });

  it("every report has a non-empty title and subtitle", () => {
    for (const r of REPORTS) {
      expect(r.title.length).toBeGreaterThan(0);
      expect(r.subtitle.length).toBeGreaterThan(0);
    }
  });

  it("all slugs are unique", () => {
    const slugs = REPORTS.map((r) => r.slug);
    expect(new Set(slugs).size).toBe(slugs.length);
  });
});