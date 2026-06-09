// Signature-tracking stamp — the top-right barcode block printed on any
// document sent out for a provider signature.
//
// Renders, in the top margin so it never disturbs the flowing body:
//   • a small "SIGNATURE TRACKING" caption,
//   • the tracking code as a Code 128 barcode (machine-scannable on the
//     returned fax),
//   • the same code in plain text plus a one-line filing instruction (so
//     staff can key it in if the scan fails).
//
// Used by both the prescription-request renderer and the manual-document
// renderer so the returned-fax filing hook is identical across kinds.
// Pure layout — no I/O, no DB, no PHI (the tracking code is an opaque
// handle, not patient data).

import type PDFKit from "pdfkit";

import { code128ModuleCount, drawCode128, QUIET_ZONE_MODULES } from "./code128";

const PAGE_WIDTH = 612; // US Letter at 72 dpi
const MARGIN = 72;
const RIGHT_EDGE = PAGE_WIDTH - MARGIN;

const MODULE_WIDTH = 1; // points per narrow module
const BAR_HEIGHT = 22;
const BARCODE_TOP = 30; // inside the top margin, above any banner

/**
 * Draw the signature-tracking stamp anchored to the top-right of the
 * current page. Absolute-positioned, so it leaves pdfkit's text cursor
 * untouched and can be called before the rest of the layout. No-op when
 * `code` is empty so a document without a tracking row still renders.
 */
export function drawSignatureTrackingStamp(
  doc: PDFKit.PDFDocument,
  code: string | null | undefined,
): void {
  const trackingCode = (code ?? "").trim();
  if (!trackingCode) return;

  const totalModules =
    code128ModuleCount(trackingCode) + QUIET_ZONE_MODULES * 2;
  const barcodeWidth = totalModules * MODULE_WIDTH;
  // Right-align the whole stamp to the right margin.
  const left = RIGHT_EDGE - barcodeWidth;

  doc.save();

  // Caption above the bars.
  doc
    .fontSize(6.5)
    .font("Helvetica-Bold")
    .fillColor("#555555")
    .text("SIGNATURE TRACKING", left, BARCODE_TOP - 9, {
      width: barcodeWidth,
      align: "right",
      lineBreak: false,
    })
    .fillColor("#000000");

  drawCode128(doc, trackingCode, {
    x: left,
    y: BARCODE_TOP,
    height: BAR_HEIGHT,
    moduleWidth: MODULE_WIDTH,
  });

  // Human-readable code + filing instruction below the bars.
  const textTop = BARCODE_TOP + BAR_HEIGHT + 1;
  doc
    .fontSize(8)
    .font("Courier-Bold")
    .fillColor("#000000")
    .text(trackingCode, left, textTop, {
      width: barcodeWidth,
      align: "right",
      lineBreak: false,
    });
  doc
    .fontSize(5.5)
    .font("Helvetica")
    .fillColor("#777777")
    .text(
      "Scan or enter this code when returning the signed copy",
      left,
      textTop + 9,
      {
        width: barcodeWidth,
        align: "right",
        lineBreak: false,
      },
    )
    .fillColor("#000000");

  doc.restore();
}
