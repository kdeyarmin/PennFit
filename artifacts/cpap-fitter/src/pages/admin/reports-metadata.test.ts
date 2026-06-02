// Tests for the static reports-metadata module.
//
// Coverage:
//   * FORMAT_LABELS — all four format keys present; QuickBooks labels
//     include the product-edition phrase (IIF = Desktop, QBO = Online)
//     so users always know which file to pick for which QB edition.
//   * REPORTS — exactly six reports, required slugs exist, every report
//     has at least csv + pdf formats, and only the finance-bearing
//     reports carry iif/qbo.

import { describe, it, expect } from "vitest";

import { FORMAT_LABELS, REPORTS, type FormatKey } from "./reports-metadata";

// ─────────────────────────────────────────────────────────────────
// FORMAT_LABELS
// ─────────────────────────────────────────────────────────────────

describe("FORMAT_LABELS", () => {
  const ALL_KEYS: FormatKey[] = ["csv", "pdf", "iif", "qbo"];

  it("defines a label for every format key", () => {
    for (const k of ALL_KEYS) {
      expect(FORMAT_LABELS[k], `label for '${k}'`).toBeTruthy();
    }
  });

  it("csv label is 'CSV'", () => {
    expect(FORMAT_LABELS.csv).toBe("CSV");
  });

  it("pdf label is 'PDF'", () => {
    expect(FORMAT_LABELS.pdf).toBe("PDF");
  });

  it("iif label contains 'QuickBooks Desktop'", () => {
    expect(FORMAT_LABELS.iif).toContain("QuickBooks Desktop");
  });

  it("qbo label contains 'QuickBooks Online'", () => {
    expect(FORMAT_LABELS.qbo).toContain("QuickBooks Online");
  });

  it("has no extra keys beyond the four defined FormatKeys", () => {
    expect(Object.keys(FORMAT_LABELS).sort()).toEqual(
      ["csv", "iif", "pdf", "qbo"].sort(),
    );
  });
});

// ─────────────────────────────────────────────────────────────────
// REPORTS
// ─────────────────────────────────────────────────────────────────

describe("REPORTS", () => {
  it("contains exactly eight report definitions", () => {
    expect(REPORTS).toHaveLength(8);
  });

  it("every report has a non-empty slug, title, and subtitle", () => {
    for (const r of REPORTS) {
      expect(r.slug, `slug on '${r.title}'`).toBeTruthy();
      expect(r.title, `title on '${r.slug}'`).toBeTruthy();
      expect(r.subtitle, `subtitle on '${r.slug}'`).toBeTruthy();
    }
  });

  it("every report includes csv and pdf formats (mandatory pair)", () => {
    for (const r of REPORTS) {
      expect(r.formats, `'${r.slug}' must have csv`).toContain("csv");
      expect(r.formats, `'${r.slug}' must have pdf`).toContain("pdf");
    }
  });

  it("contains the expected report slugs", () => {
    const slugs = REPORTS.map((r) => r.slug);
    for (const expected of [
      "all-financial",
      "orders",
      "returns",
      "revenue-summary",
      "refunds-journal",
      "insurance-claims",
      "patient-payments",
      "customer-activity",
    ]) {
      expect(slugs, `slug '${expected}' must be present`).toContain(expected);
    }
  });

  it("finance-bearing reports have iif and qbo formats", () => {
    // orders/returns/insurance-claims plus the patient-payments stream
    // and the combined all-financial bundle all carry QuickBooks
    // exports.
    const financeReports = [
      "orders",
      "returns",
      "insurance-claims",
      "patient-payments",
      "all-financial",
    ];
    for (const slug of financeReports) {
      const r = REPORTS.find((x) => x.slug === slug);
      expect(r, `report '${slug}' must exist`).toBeDefined();
      expect(r!.formats, `'${slug}' must have iif`).toContain("iif");
      expect(r!.formats, `'${slug}' must have qbo`).toContain("qbo");
    }
  });

  it("all-financial is the first card (the headline export-everything button)", () => {
    expect(REPORTS[0]!.slug).toBe("all-financial");
  });

  it("revenue-summary and customer-activity reports do NOT have iif or qbo", () => {
    const nonFinanceReports = ["revenue-summary", "customer-activity"];
    for (const slug of nonFinanceReports) {
      const r = REPORTS.find((x) => x.slug === slug);
      expect(r, `report '${slug}' must exist`).toBeDefined();
      expect(r!.formats, `'${slug}' must not have iif`).not.toContain("iif");
      expect(r!.formats, `'${slug}' must not have qbo`).not.toContain("qbo");
    }
  });

  it("refunds-journal report does NOT have iif or qbo", () => {
    const r = REPORTS.find((x) => x.slug === "refunds-journal");
    expect(r).toBeDefined();
    expect(r!.formats).not.toContain("iif");
    expect(r!.formats).not.toContain("qbo");
  });

  it("every slug is unique", () => {
    const slugs = REPORTS.map((r) => r.slug);
    const unique = new Set(slugs);
    expect(unique.size).toBe(slugs.length);
  });

  it("every report's formats list only contains valid FormatKey values", () => {
    const validKeys = new Set<string>(["csv", "pdf", "iif", "qbo"]);
    for (const r of REPORTS) {
      for (const f of r.formats) {
        expect(
          validKeys,
          `'${f}' in '${r.slug}' is not a valid FormatKey`,
        ).toContain(f);
      }
    }
  });
});
