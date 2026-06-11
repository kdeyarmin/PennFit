// Manual-document packet PDF renderer.
//
// Renders a packet — an ordered bundle of staff-authored manual
// documents — to ONE combined PDF: an optional generated cover sheet
// (packet title, recipient, contents list) followed by each member
// document starting on a fresh page. Reuses drawManualDocument from
// pdf.ts so a document's pages inside a packet are laid out exactly
// like its individual render (including the signature-tracking
// barcode), and a signed page faxed back can still be scanned and
// filed against the right document.
//
// No external PDF merging (pdf-lib) is needed: every member document
// is drawn from structured data, so the whole packet renders in a
// single PDFKit pass.
//
// PHI posture: same as pdf.ts — content can contain PHI; the cover
// sheet carries the CONFIDENTIAL banner when any member document is a
// PHI kind. Bytes are streamed/attached, never logged.

import PDFDocument from "pdfkit";
import type PDFKit from "pdfkit";

import { getManualDocumentTypeDef } from "./catalog";
import { drawManualDocument, type ManualDocumentPdfInput } from "./pdf";

const MARGIN = 72;
const PAGE_WIDTH = 612;
const USABLE_WIDTH = PAGE_WIDTH - MARGIN * 2;

export interface ManualDocumentPacketPdfInput {
  title: string;
  recipient: {
    name?: string | null;
    address?: string | null;
    email?: string | null;
    fax?: string | null;
  };
  /** Member documents, in packet order. Must be non-empty. */
  documents: ManualDocumentPdfInput[];
  /** Render the generated cover sheet as page one. */
  includeCoverSheet: boolean;
  /** Practice / supplier name for the cover-sheet letterhead. */
  supplierName: string;
  /** Passed in (not derived) so tests are deterministic. */
  generatedOn: Date;
}

/** Render the packet to a Buffer (same pattern as renderManualDocumentPdf). */
export async function renderManualDocumentPacketPdf(
  input: ManualDocumentPacketPdfInput,
): Promise<Buffer> {
  if (input.documents.length === 0) {
    throw new Error("Cannot render an empty packet");
  }
  const doc = new PDFDocument({ size: "LETTER", margin: MARGIN });
  const chunks: Buffer[] = [];
  return new Promise<Buffer>((resolve, reject) => {
    doc.on("data", (c: Buffer) => chunks.push(c));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);
    try {
      let first = true;
      if (input.includeCoverSheet) {
        drawPacketCoverSheet(doc, input);
        first = false;
      }
      for (const member of input.documents) {
        if (!first) doc.addPage();
        first = false;
        drawManualDocument(doc, member);
      }
      doc.end();
    } catch (err) {
      reject(err);
    }
  });
}

function drawPacketCoverSheet(
  doc: PDFKit.PDFDocument,
  input: ManualDocumentPacketPdfInput,
): void {
  const anyPhi = input.documents.some(
    (m) => getManualDocumentTypeDef(m.documentType).phi,
  );

  if (anyPhi) {
    doc
      .fontSize(9)
      .font("Helvetica-Bold")
      .fillColor("#cc0000")
      .text(
        "CONFIDENTIAL — HIPAA PROTECTED HEALTH INFORMATION",
        MARGIN,
        MARGIN,
        { width: USABLE_WIDTH, align: "center" },
      )
      .fillColor("#000000");
    doc.moveDown(0.5);
    rule(doc);
    doc.moveDown(0.8);
  } else {
    doc.y = MARGIN;
  }

  // ── Letterhead ──────────────────────────────────────────────────
  doc
    .fontSize(16)
    .font("Helvetica-Bold")
    .text(input.supplierName, { width: USABLE_WIDTH });
  doc
    .fontSize(10)
    .font("Helvetica")
    .fillColor("#555555")
    .text("Home Medical Equipment & CPAP Supply Services", {
      width: USABLE_WIDTH,
    })
    .fillColor("#000000");
  doc.moveDown(1);

  // ── Title + date ────────────────────────────────────────────────
  doc.fontSize(18).font("Helvetica-Bold").text(input.title, {
    width: USABLE_WIDTH,
  });
  doc
    .fontSize(10)
    .font("Helvetica")
    .fillColor("#555555")
    .text(`Document Packet · ${formatDate(input.generatedOn)}`, {
      width: USABLE_WIDTH,
    })
    .fillColor("#000000");
  doc.moveDown(0.8);
  rule(doc);
  doc.moveDown(0.8);

  // ── Recipient block (only when any part is filled) ──────────────
  const hasRecipient = Boolean(
    input.recipient.name ||
    input.recipient.address ||
    input.recipient.email ||
    input.recipient.fax,
  );
  if (hasRecipient) {
    header(doc, "Recipient");
    if (input.recipient.name) field(doc, "Name", input.recipient.name);
    if (input.recipient.address) {
      field(doc, "Address", input.recipient.address);
    }
    if (input.recipient.email) field(doc, "Email", input.recipient.email);
    if (input.recipient.fax) field(doc, "Fax", input.recipient.fax);
    doc.moveDown(0.6);
    rule(doc);
    doc.moveDown(0.8);
  }

  // ── Contents ────────────────────────────────────────────────────
  header(doc, `Contents (${input.documents.length})`);
  input.documents.forEach((m, i) => {
    const def = getManualDocumentTypeDef(m.documentType);
    doc
      .fontSize(10)
      .font("Helvetica-Bold")
      .text(`${i + 1}. ${m.title}`, { continued: true, width: USABLE_WIDTH });
    doc
      .font("Helvetica")
      .fillColor("#555555")
      .text(`  — ${def.label}`, { width: USABLE_WIDTH })
      .fillColor("#000000");
    doc.moveDown(0.2);
  });

  // ── Footer ──────────────────────────────────────────────────────
  if (anyPhi) {
    const footerY = 720;
    doc
      .moveTo(MARGIN, footerY)
      .lineTo(PAGE_WIDTH - MARGIN, footerY)
      .strokeColor("#aaaaaa")
      .stroke()
      .strokeColor("#000000");
    // The footer sits below the bottom margin (720 = 792 − 72); lift the
    // margin while drawing it or PDFKit auto-appends a blank page.
    const savedBottomMargin = doc.page.margins.bottom;
    doc.page.margins.bottom = 0;
    doc
      .fontSize(8)
      .font("Helvetica")
      .fillColor("#555555")
      .text(
        "This packet contains protected health information governed by " +
          "HIPAA. It is intended only for the named recipient.",
        MARGIN,
        footerY + 6,
        { width: USABLE_WIDTH, align: "center" },
      )
      .fillColor("#000000");
    doc.page.margins.bottom = savedBottomMargin;
  }
}

function header(doc: PDFKit.PDFDocument, label: string): void {
  doc.fontSize(11).font("Helvetica-Bold").text(label, { width: USABLE_WIDTH });
  doc.moveDown(0.3);
}

function field(doc: PDFKit.PDFDocument, label: string, value: string): void {
  doc
    .fontSize(10)
    .font("Helvetica-Bold")
    .text(`${label}: `, { continued: true, width: USABLE_WIDTH });
  doc.font("Helvetica").text(value, { width: USABLE_WIDTH });
  doc.moveDown(0.2);
}

function rule(doc: PDFKit.PDFDocument): void {
  doc
    .moveTo(MARGIN, doc.y)
    .lineTo(PAGE_WIDTH - MARGIN, doc.y)
    .strokeColor("#aaaaaa")
    .stroke()
    .strokeColor("#000000");
}

function formatDate(d: Date): string {
  return d.toLocaleDateString("en-US", {
    year: "numeric",
    month: "long",
    day: "numeric",
  });
}
