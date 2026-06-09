// Cover manifest for a hand-delivery signature batch.
//
// When a CSR prints every outstanding prescription-request packet for a
// provider / practice in one stack (see
// routes/admin/prescription-requests.ts -> needs-signature/pdf), this
// renders the first page: a checklist of every patient + packet in the
// batch so the person carrying the stack can tick them off as the
// physician signs, and so the office keeps a record of what was left
// with them.
//
// Side-effect-free: takes data + a pdfkit doc and writes layout
// commands. No DB, no network, no logging. The route adds a page break
// and renders each per-packet PDF (lib/prescription-request-pdf.ts)
// after this cover.

import type PDFKit from "pdfkit";

const MARGIN = 72;
const PAGE_WIDTH = 612;
const USABLE_WIDTH = PAGE_WIDTH - MARGIN * 2;

export interface SignatureBatchCoverItem {
  patientName: string;
  status: string;
  /** True when the packet could not be rendered and was left out of the stack. */
  excluded?: boolean;
  /** Short reason shown next to an excluded item. */
  excludedReason?: string;
}

export interface SignatureBatchCoverInput {
  /** Provider or practice the batch is for. */
  label: string;
  /** Count of renderable packets that follow this cover. */
  includedCount: number;
  items: SignatureBatchCoverItem[];
  generatedOn: Date;
}

/**
 * Render the batch cover page into the provided pdfkit document. The
 * caller pipes `doc`, calls this first, then `doc.addPage()` +
 * `renderPrescriptionRequest(doc, …)` for each included packet.
 */
export function renderSignatureBatchCover(
  doc: PDFKit.PDFDocument,
  input: SignatureBatchCoverInput,
): void {
  drawConfidentialBanner(doc);

  doc.fontSize(16).font("Helvetica-Bold").text("Prescription signature batch", {
    width: USABLE_WIDTH,
  });
  doc.moveDown(0.2);
  doc
    .fontSize(11)
    .font("Helvetica")
    .fillColor("#555555")
    .text("Hand-delivery checklist — please sign each enclosed order", {
      width: USABLE_WIDTH,
    })
    .fillColor("#000000");
  doc.moveDown(0.8);

  drawLabeledField(doc, "Provider / practice", input.label);
  drawLabeledField(
    doc,
    "Prepared",
    input.generatedOn.toLocaleDateString("en-US", {
      year: "numeric",
      month: "long",
      day: "numeric",
    }),
  );
  drawLabeledField(
    doc,
    "Orders enclosed for signature",
    String(input.includedCount),
  );
  doc.moveDown(0.5);
  drawRule(doc);
  doc.moveDown(0.6);

  // Checklist table: [✓] Patient — current status.
  const colCheck = MARGIN;
  const colPatient = MARGIN + 28;
  const colStatus = MARGIN + 320;

  doc.fontSize(10).font("Helvetica-Bold");
  const headerY = doc.y;
  doc.text("Signed", colCheck, headerY, { width: 26 });
  doc.text("Patient", colPatient, headerY, { width: 280 });
  doc.text("Status", colStatus, headerY, { width: 110 });
  doc.moveDown(0.3);
  doc
    .moveTo(MARGIN, doc.y)
    .lineTo(PAGE_WIDTH - MARGIN, doc.y)
    .strokeColor("#cccccc")
    .stroke()
    .strokeColor("#000000");
  doc.moveDown(0.3);

  doc.font("Helvetica").fontSize(10);
  for (const item of input.items) {
    const rowY = doc.y;
    // Empty checkbox glyph the physician's office ticks on signing.
    doc.text(item.excluded ? "—" : "☐", colCheck, rowY, { width: 26 });
    doc.text(item.patientName, colPatient, rowY, { width: 280 });
    const statusText = item.excluded
      ? `excluded${item.excludedReason ? ` — ${item.excludedReason}` : ""}`
      : humanizeStatus(item.status);
    doc
      .fillColor(item.excluded ? "#999999" : "#000000")
      .text(statusText, colStatus, rowY, { width: 130 })
      .fillColor("#000000");
    doc.moveDown(0.5);
  }
  doc.x = MARGIN;

  if (input.items.length === 0) {
    doc
      .font("Helvetica-Oblique")
      .fillColor("#555555")
      .text("No outstanding orders need a signature for this selection.", {
        width: USABLE_WIDTH,
      })
      .fillColor("#000000");
  }
}

function humanizeStatus(status: string): string {
  switch (status) {
    case "draft":
      return "not yet sent";
    case "sent_fax":
      return "faxed — awaiting return";
    case "delivered":
      return "delivered — awaiting return";
    case "failed":
      return "fax failed";
    default:
      return status.replace(/_/g, " ");
  }
}

function drawConfidentialBanner(doc: PDFKit.PDFDocument): void {
  doc
    .fontSize(9)
    .font("Helvetica-Bold")
    .fillColor("#cc0000")
    .text("CONFIDENTIAL — HIPAA PROTECTED HEALTH INFORMATION", MARGIN, MARGIN, {
      width: USABLE_WIDTH,
      align: "center",
    })
    .fillColor("#000000");
  doc.moveDown(0.4);
  doc
    .moveTo(MARGIN, doc.y)
    .lineTo(PAGE_WIDTH - MARGIN, doc.y)
    .stroke();
  doc.moveDown(0.8);
}

function drawLabeledField(
  doc: PDFKit.PDFDocument,
  label: string,
  value: string,
): void {
  doc.fontSize(10).font("Helvetica-Bold").text(`${label}: `, {
    continued: true,
    width: USABLE_WIDTH,
  });
  doc.font("Helvetica").text(value, { width: USABLE_WIDTH });
  doc.moveDown(0.15);
}

function drawRule(doc: PDFKit.PDFDocument): void {
  doc
    .moveTo(MARGIN, doc.y)
    .lineTo(PAGE_WIDTH - MARGIN, doc.y)
    .strokeColor("#cccccc")
    .stroke()
    .strokeColor("#000000");
}
