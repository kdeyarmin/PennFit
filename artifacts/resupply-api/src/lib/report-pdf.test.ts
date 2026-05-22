// Tests for the tabular report PDF renderer.
//
// We don't render the visual PDF in tests — instead we assert that
// the generator produces a non-empty Buffer with the PDF magic header
// and a sane size for the given row count. Visual correctness is
// verified manually when the format changes.

import { describe, it, expect } from "vitest";

import { renderTablePdf, type PdfReportInput } from "./report-pdf";

function sampleInput(rowCount: number): PdfReportInput {
  const rows: string[][] = [];
  for (let i = 0; i < rowCount; i++) {
    rows.push([
      `ord-${i}`,
      "2026-04-15",
      "paid",
      "250.00",
      "cust-abc123",
      "2026-04-16",
      "UPS 1Z…",
    ]);
  }
  return {
    title: "Cash-pay orders",
    range: "2026-04-01 to 2026-04-30",
    practiceName: "PennPaps",
    columns: [
      { label: "Order #", width: 100 },
      { label: "Date", width: 70 },
      { label: "Status", width: 70 },
      { label: "Total", width: 80, rightAlign: true },
      { label: "Customer", width: 100 },
      { label: "Shipped", width: 70 },
      { label: "Tracking", width: 230 },
    ],
    rows,
    summaryLines: [`Total orders: ${rowCount}`, `Gross: $${(rowCount * 250).toFixed(2)}`],
  };
}

describe("renderTablePdf", () => {
  it("produces a non-empty PDF Buffer with the %PDF magic header", async () => {
    const buf = await renderTablePdf(sampleInput(5));
    expect(buf.length).toBeGreaterThan(500);
    // PDF spec: every PDF starts with the bytes "%PDF-"
    expect(buf.slice(0, 5).toString("ascii")).toBe("%PDF-");
  });

  it("renders an empty rows section without throwing", async () => {
    const buf = await renderTablePdf(sampleInput(0));
    expect(buf.length).toBeGreaterThan(500);
    expect(buf.slice(0, 5).toString("ascii")).toBe("%PDF-");
  });

  it("handles enough rows to trigger pagination", async () => {
    // ~40 rows + summary should overflow a single landscape-letter
    // page (rows are 14pt each and the usable height is ~560pt).
    const buf = await renderTablePdf(sampleInput(60));
    expect(buf.length).toBeGreaterThan(1000);
    expect(buf.slice(0, 5).toString("ascii")).toBe("%PDF-");
  });
});
