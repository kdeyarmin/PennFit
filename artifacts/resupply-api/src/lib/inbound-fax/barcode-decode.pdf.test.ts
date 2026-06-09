// End-to-end PDF fast-path test. Generates a PDF carrying the REAL
// signature-tracking stamp (the same `drawSignatureTrackingStamp` the
// outbound prescription/manual-document renderers use), rasterizes it with
// the WASM PDFium rasterizer, and decodes the tracking code — exercising
// the whole rasterize → scan → decode pipeline a returned-fax PDF hits.
//
// This validates the plumbing + the clean (crisp vector) case. Real
// returned faxes are degraded ~200dpi scans; those that don't decode here
// fall through to the vision scan, which this test does not cover.

import { describe, it, expect } from "vitest";
import PDFDocument from "pdfkit";

import { drawSignatureTrackingStamp } from "../barcode/tracking-stamp";
import { tryDecodeTrackingBarcode } from "./barcode-decode";

/** Render a US-Letter PDF with the signature-tracking stamp top-right. */
function makeStampedPdf(code: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: "letter", margin: 72 });
    const chunks: Buffer[] = [];
    doc.on("data", (c: Buffer) => chunks.push(c));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);
    drawSignatureTrackingStamp(doc, code);
    doc.fontSize(12).text("Signed prescription — test document body.", 72, 200);
    doc.end();
  });
}

describe("tryDecodeTrackingBarcode — PDF rasterization", () => {
  it("decodes the tracking code off a stamped PDF (Telnyx's default format)", async () => {
    const pdf = await makeStampedPdf("PFS-7F3K2Q9X");
    const code = await tryDecodeTrackingBarcode({
      bytes: pdf,
      contentType: "application/pdf",
    });
    expect(code).toBe("PFS-7F3K2Q9X");
  }, 20_000);

  it("returns null for a PDF with no PennFit stamp", async () => {
    const doc = new PDFDocument({ size: "letter", margin: 72 });
    const chunks: Buffer[] = [];
    const pdf: Buffer = await new Promise((resolve, reject) => {
      doc.on("data", (c: Buffer) => chunks.push(c));
      doc.on("end", () => resolve(Buffer.concat(chunks)));
      doc.on("error", reject);
      doc.fontSize(12).text("A fax with no tracking barcode at all.", 72, 200);
      doc.end();
    });
    const code = await tryDecodeTrackingBarcode({
      bytes: pdf,
      contentType: "application/pdf",
    });
    expect(code).toBeNull();
  }, 20_000);
});
