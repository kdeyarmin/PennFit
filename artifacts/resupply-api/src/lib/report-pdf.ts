// Tabular PDF rendering for the admin reports surface.
//
// Single entry point: `renderTablePdf({ title, range, columns, rows })`
// emits a multi-page landscape-letter PDF with a fixed header, a
// title block, a header row of column labels, and the data rows in a
// monospaced numeric / proportional text mix. Designed for finance-
// style reports: orders, returns, revenue summary, refunds journal.
//
// Why landscape: most rows have 10+ columns. Portrait fits the title
// page but truncates a per-order row.
//
// What we deliberately don't do:
//   * No charts. The current operator workflow is "open the PDF,
//     skim totals, file the export." Sparklines add bytes and a
//     chart library dependency we don't otherwise need.
//   * No images / logos. The PDF goes to finance + bookkeepers, who
//     already know the supplier name from the file headers.
//   * No per-row coloring. Negative amounts get a leading minus and
//     that's it — the bookkeeper sorts and filters in their own tool.

import PDFDocument from "pdfkit";
import type PDFKit from "pdfkit";

export interface PdfReportColumn {
  /** Header label printed on the column. */
  label: string;
  /** Width in PDF points. Sum should match USABLE_WIDTH below. */
  width: number;
  /** Right-align flag — used for money / numeric columns. */
  rightAlign?: boolean;
}

export interface PdfReportInput {
  title: string;
  /** Free-form sub-heading line (e.g. "2026-04-01 to 2026-04-30"). */
  range: string;
  /** Practice name shown as the report footer / preparer. */
  practiceName: string;
  columns: PdfReportColumn[];
  rows: ReadonlyArray<ReadonlyArray<string>>;
  /**
   * Optional summary lines printed under the table (totals,
   * counts). One line per entry.
   */
  summaryLines?: string[];
}

// Landscape Letter: 11" wide x 8.5" tall. PDFKit expresses sizes in
// points (1/72").
const PAGE_WIDTH = 792;
const PAGE_HEIGHT = 612;
const MARGIN = 36;
const USABLE_WIDTH = PAGE_WIDTH - MARGIN * 2;
const HEADER_FONT_SIZE = 9;
const BODY_FONT_SIZE = 8;
const ROW_HEIGHT = 14;

/**
 * Render the input report and resolve with the full PDF buffer.
 *
 * The function returns a Buffer (vs. streaming) because the route
 * needs to know the byte length up front for `Content-Length` (some
 * proxies strip the header off a chunked response and the user agent
 * shows "downloading 0 bytes"). The reports we generate are small —
 * a 90-day orders export rarely exceeds 200 KB — so the buffer cost
 * is bounded.
 */
export async function renderTablePdf(input: PdfReportInput): Promise<Buffer> {
  const doc = new PDFDocument({
    size: [PAGE_WIDTH, PAGE_HEIGHT],
    margin: MARGIN,
  });
  const chunks: Buffer[] = [];
  return new Promise<Buffer>((resolve, reject) => {
    doc.on("data", (c: Buffer) => chunks.push(c));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);
    try {
      drawReport(doc, input);
      doc.end();
    } catch (err) {
      reject(err);
    }
  });
}

function drawReport(
  doc: PDFKit.PDFDocument,
  input: PdfReportInput,
): void {
  drawTitle(doc, input);
  drawHeaderRow(doc, input.columns);
  let y = doc.y;
  const bottom = PAGE_HEIGHT - MARGIN - 28; // reserve for footer

  for (let i = 0; i < input.rows.length; i++) {
    if (y + ROW_HEIGHT > bottom) {
      drawFooter(doc, input);
      doc.addPage({ size: [PAGE_WIDTH, PAGE_HEIGHT], margin: MARGIN });
      drawTitle(doc, input);
      drawHeaderRow(doc, input.columns);
      y = doc.y;
    }
    drawDataRow(doc, input.columns, input.rows[i]!, y);
    y += ROW_HEIGHT;
  }

  // Summary block sits directly under the last row, with a divider.
  if (input.summaryLines && input.summaryLines.length > 0) {
    if (y + 24 + input.summaryLines.length * 12 > bottom) {
      drawFooter(doc, input);
      doc.addPage({ size: [PAGE_WIDTH, PAGE_HEIGHT], margin: MARGIN });
      drawTitle(doc, input);
      y = doc.y;
    }
    y += 6;
    doc
      .moveTo(MARGIN, y)
      .lineTo(PAGE_WIDTH - MARGIN, y)
      .lineWidth(0.5)
      .stroke();
    y += 8;
    doc.font("Helvetica-Bold").fontSize(BODY_FONT_SIZE);
    for (const line of input.summaryLines) {
      doc.text(line, MARGIN, y);
      y += 12;
    }
  }

  drawFooter(doc, input);
}

function drawTitle(
  doc: PDFKit.PDFDocument,
  input: PdfReportInput,
): void {
  doc
    .font("Helvetica-Bold")
    .fontSize(16)
    .text(input.title, MARGIN, MARGIN, { width: USABLE_WIDTH });
  doc
    .font("Helvetica")
    .fontSize(10)
    .text(input.range, MARGIN, doc.y + 2, { width: USABLE_WIDTH });
  // Push the cursor down so the column header has visual breathing
  // room from the title block.
  doc.y += 8;
}

function drawHeaderRow(
  doc: PDFKit.PDFDocument,
  columns: PdfReportColumn[],
): void {
  const y = doc.y;
  doc
    .moveTo(MARGIN, y - 2)
    .lineTo(PAGE_WIDTH - MARGIN, y - 2)
    .lineWidth(0.5)
    .stroke();
  let x = MARGIN;
  doc.font("Helvetica-Bold").fontSize(HEADER_FONT_SIZE).fillColor("#000");
  for (const col of columns) {
    doc.text(col.label, x + 2, y + 2, {
      width: col.width - 4,
      align: col.rightAlign ? "right" : "left",
      // PDFKit's auto-flow can move the cursor down when text wraps;
      // we want a flat header so we disable.
      lineBreak: false,
    });
    x += col.width;
  }
  doc.y = y + ROW_HEIGHT;
  doc
    .moveTo(MARGIN, doc.y - 2)
    .lineTo(PAGE_WIDTH - MARGIN, doc.y - 2)
    .lineWidth(0.5)
    .stroke();
}

function drawDataRow(
  doc: PDFKit.PDFDocument,
  columns: PdfReportColumn[],
  row: ReadonlyArray<string>,
  y: number,
): void {
  let x = MARGIN;
  doc.font("Helvetica").fontSize(BODY_FONT_SIZE);
  for (let i = 0; i < columns.length; i++) {
    const col = columns[i]!;
    const cell = row[i] ?? "";
    doc.text(cell, x + 2, y + 3, {
      width: col.width - 4,
      align: col.rightAlign ? "right" : "left",
      lineBreak: false,
      // Single line; PDFKit truncates with an ellipsis when the
      // text wouldn't fit.
      ellipsis: true,
    });
    x += col.width;
  }
}

function drawFooter(
  doc: PDFKit.PDFDocument,
  input: PdfReportInput,
): void {
  const y = PAGE_HEIGHT - MARGIN - 12;
  doc
    .font("Helvetica")
    .fontSize(7)
    .fillColor("#555")
    .text(
      `${input.practiceName} • Generated ${new Date().toISOString().slice(0, 19)}Z`,
      MARGIN,
      y,
      { width: USABLE_WIDTH, align: "left" },
    );
  doc.text(
    `Page ${doc.bufferedPageRange().count}`,
    MARGIN,
    y,
    { width: USABLE_WIDTH, align: "right" },
  );
  doc.fillColor("#000");
}

/** Re-exported so reports.ts can stick to one import. */
export { USABLE_WIDTH as REPORT_USABLE_WIDTH };
