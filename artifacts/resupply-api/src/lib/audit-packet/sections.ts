// Audit-packet generated pages — pdfkit renderers for the system-derived
// sections (cover sheet + table of contents, adherence/compliance report,
// dispensed-equipment detail, claim/billing summary, continued-use
// attestation, replacement-quantity record) and the section dividers that
// precede stored chart documents.
//
// Each renderer returns a self-contained PDF Buffer; the orchestrator
// (build-audit-packet.ts) merges them with the stored documents via
// assemble.ts. Pages are driven by a small block model so a section is just
// data — easy to compose and to unit-test.
//
// PHI posture: these pages carry PHI (patient name, clinical detail). They
// ride the CONFIDENTIAL banner, are streamed/attached, never logged.

import PDFDocument from "pdfkit";
import type PDFKit from "pdfkit";

const MARGIN = 72;
const PAGE_WIDTH = 612;
const USABLE_WIDTH = PAGE_WIDTH - MARGIN * 2;
const CONFIDENTIAL =
  "CONFIDENTIAL — HIPAA PROTECTED HEALTH INFORMATION — FOR PAYER AUDIT USE";

export type Block =
  | { t: "title"; text: string; sub?: string }
  | { t: "heading"; text: string }
  | { t: "field"; label: string; value: string }
  | { t: "paragraph"; text: string }
  | { t: "rule" }
  | { t: "spacer"; n?: number }
  | { t: "list"; items: string[] }
  | { t: "table"; columns: string[]; rows: string[][] };

/** Render a single titled page (the page always starts under the banner). */
export async function renderPdfPage(blocks: readonly Block[]): Promise<Buffer> {
  const doc = new PDFDocument({ size: "LETTER", margin: MARGIN });
  const chunks: Buffer[] = [];
  return new Promise<Buffer>((resolve, reject) => {
    doc.on("data", (c: Buffer) => chunks.push(c));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);
    try {
      drawBanner(doc);
      for (const block of blocks) drawBlock(doc, block);
      doc.end();
    } catch (err) {
      reject(err);
    }
  });
}

function drawBanner(doc: PDFKit.PDFDocument): void {
  doc
    .fontSize(8)
    .font("Helvetica-Bold")
    .fillColor("#cc0000")
    .text(CONFIDENTIAL, MARGIN, MARGIN, {
      width: USABLE_WIDTH,
      align: "center",
    })
    .fillColor("#000000");
  doc.moveDown(0.6);
  rule(doc);
  doc.moveDown(0.8);
}

function drawBlock(doc: PDFKit.PDFDocument, block: Block): void {
  switch (block.t) {
    case "title":
      doc
        .fontSize(18)
        .font("Helvetica-Bold")
        .text(block.text, { width: USABLE_WIDTH });
      if (block.sub) {
        doc
          .fontSize(10)
          .font("Helvetica")
          .fillColor("#555555")
          .text(block.sub, { width: USABLE_WIDTH })
          .fillColor("#000000");
      }
      doc.moveDown(0.6);
      rule(doc);
      doc.moveDown(0.6);
      return;
    case "heading":
      doc.moveDown(0.4);
      doc
        .fontSize(12)
        .font("Helvetica-Bold")
        .text(block.text, { width: USABLE_WIDTH });
      doc.moveDown(0.3);
      return;
    case "field":
      doc
        .fontSize(10)
        .font("Helvetica-Bold")
        .text(`${block.label}: `, { continued: true, width: USABLE_WIDTH });
      doc.font("Helvetica").text(block.value || "—", { width: USABLE_WIDTH });
      doc.moveDown(0.15);
      return;
    case "paragraph":
      doc
        .fontSize(10)
        .font("Helvetica")
        .text(block.text, { width: USABLE_WIDTH, align: "left" });
      doc.moveDown(0.4);
      return;
    case "rule":
      rule(doc);
      doc.moveDown(0.4);
      return;
    case "spacer":
      doc.moveDown(block.n ?? 1);
      return;
    case "list":
      block.items.forEach((item, i) => {
        doc
          .fontSize(10)
          .font("Helvetica")
          .text(`${i + 1}. ${item}`, { width: USABLE_WIDTH });
        doc.moveDown(0.1);
      });
      doc.moveDown(0.2);
      return;
    case "table":
      drawTable(doc, block.columns, block.rows);
      return;
  }
}

function drawTable(
  doc: PDFKit.PDFDocument,
  columns: readonly string[],
  rows: readonly string[][],
): void {
  const colWidth = USABLE_WIDTH / columns.length;
  const startX = MARGIN;
  // Header row.
  let y = doc.y;
  doc.fontSize(9).font("Helvetica-Bold");
  columns.forEach((col, i) => {
    doc.text(col, startX + i * colWidth, y, {
      width: colWidth - 4,
      lineBreak: false,
    });
  });
  doc.moveDown(0.2);
  y = doc.y + 2;
  doc
    .moveTo(MARGIN, y)
    .lineTo(PAGE_WIDTH - MARGIN, y)
    .strokeColor("#aaaaaa")
    .stroke()
    .strokeColor("#000000");
  doc.moveDown(0.3);
  // Body rows.
  doc.fontSize(9).font("Helvetica");
  for (const row of rows) {
    if (doc.y > 720) doc.addPage();
    const rowY = doc.y;
    let maxH = 0;
    row.forEach((cell, i) => {
      const h = doc.heightOfString(cell || "—", { width: colWidth - 4 });
      maxH = Math.max(maxH, h);
      doc.text(cell || "—", startX + i * colWidth, rowY, {
        width: colWidth - 4,
      });
    });
    doc.y = rowY + maxH + 3;
  }
  doc.moveDown(0.3);
}

function rule(doc: PDFKit.PDFDocument): void {
  doc
    .moveTo(MARGIN, doc.y)
    .lineTo(PAGE_WIDTH - MARGIN, doc.y)
    .strokeColor("#aaaaaa")
    .stroke()
    .strokeColor("#000000");
}
