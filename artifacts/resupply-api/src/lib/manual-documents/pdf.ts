// Manual-document PDF renderer.
//
// Renders a staff-authored manual document (see catalog.ts) to a clean,
// printable/faxable PDF. The same renderer is used by the admin
// download route, the email-attachment path, the fax media path, and
// the chart-attachment path so every channel produces identical bytes.
//
// PHI posture: the PDF can contain PHI (the author types it in). The
// banner + HIPAA footer render for clinical document kinds (catalog
// `phi: true`). Bytes are streamed/attached, never logged.
//
// Same PDFKit pattern as lib/billing/dwo-pdf.ts.

import PDFDocument from "pdfkit";
import type PDFKit from "pdfkit";

import { drawSignatureTrackingStamp } from "../barcode/tracking-stamp";
import {
  getManualDocumentTypeDef,
  normalizeManualDocumentFields,
  type ManualDocumentType,
} from "./catalog";

const MARGIN = 72;
const PAGE_WIDTH = 612;
const USABLE_WIDTH = PAGE_WIDTH - MARGIN * 2;

export interface ManualDocumentPdfInput {
  documentType: ManualDocumentType;
  title: string;
  recipient: {
    name?: string | null;
    address?: string | null;
    email?: string | null;
    fax?: string | null;
  };
  /** Raw typed fields (key→value); normalized against the catalog here. */
  fields: Record<string, unknown> | null;
  body?: string | null;
  /** Practice / supplier name for the letterhead. */
  supplierName: string;
  /** Passed in (not derived) so tests are deterministic. */
  generatedOn: Date;
  /**
   * Signature-tracking code (migration 0253). When set, printed as a
   * Code 128 barcode top-right so a signed copy faxed back can be scanned
   * and filed. Only signable document kinds carry one.
   */
  trackingCode?: string | null;
}

/** Render the manual document to a Buffer (same pattern as dwo-pdf). */
export async function renderManualDocumentPdf(
  input: ManualDocumentPdfInput,
): Promise<Buffer> {
  const doc = new PDFDocument({ size: "LETTER", margin: MARGIN });
  const chunks: Buffer[] = [];
  return new Promise<Buffer>((resolve, reject) => {
    doc.on("data", (c: Buffer) => chunks.push(c));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);
    try {
      drawManualDocument(doc, input);
      doc.end();
    } catch (err) {
      reject(err);
    }
  });
}

/**
 * Draw one manual document into an existing PDFKit doc, starting at the
 * current page. Exported so the packet renderer (packet-pdf.ts) can draw
 * several documents into a single combined PDF — each on a fresh page —
 * without re-implementing the per-document layout.
 */
export function drawManualDocument(
  doc: PDFKit.PDFDocument,
  input: ManualDocumentPdfInput,
): void {
  const def = getManualDocumentTypeDef(input.documentType);

  // Top-right signature-tracking barcode (absolute-positioned in the top
  // margin; no-op when there's no code).
  drawSignatureTrackingStamp(doc, input.trackingCode);

  if (def.phi) {
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
    .text(`${def.label} · ${formatDate(input.generatedOn)}`, {
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

  // ── Structured typed fields (only the filled ones) ──────────────
  const values = normalizeManualDocumentFields(
    input.documentType,
    input.fields,
  );
  const filled = def.fields.filter((f) => values[f.key]);
  if (filled.length > 0) {
    header(doc, "Details");
    for (const f of filled) {
      const value = values[f.key]!;
      if (f.kind === "textarea") {
        doc
          .fontSize(10)
          .font("Helvetica-Bold")
          .text(`${f.label}:`, { width: USABLE_WIDTH });
        doc.font("Helvetica").text(value, { width: USABLE_WIDTH, lineGap: 2 });
        doc.moveDown(0.4);
      } else {
        field(doc, f.label, value);
      }
    }
    doc.moveDown(0.6);
  }

  // ── Free-form body ──────────────────────────────────────────────
  const body = (input.body ?? "").trim();
  if (body) {
    if (filled.length > 0) {
      rule(doc);
      doc.moveDown(0.8);
    }
    doc
      .fontSize(11)
      .font("Helvetica")
      .text(body, { width: USABLE_WIDTH, lineGap: 4 });
    doc.moveDown(1);
  }

  // ── Signature line ──────────────────────────────────────────────
  if (def.requiresSignature) {
    doc.moveDown(1.2);
    doc
      .fontSize(10)
      .font("Helvetica")
      .text("Signature: ____________________________________", {
        width: USABLE_WIDTH,
      });
    doc.moveDown(0.4);
    doc.text("Date: __________________", { width: USABLE_WIDTH });
  }

  // ── Footer ──────────────────────────────────────────────────────
  if (def.phi) {
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
        "This document contains protected health information governed by " +
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
