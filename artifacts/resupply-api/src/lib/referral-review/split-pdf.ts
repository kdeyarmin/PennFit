// Split a referral packet PDF into per-section PDFs.
//
// The Referral Reviewer's accept step files each classified section of
// the packet (sleep study, physician order, …) into the new patient's
// chart as its own named PDF. The page ranges come from the AI
// extraction but are human-reviewed before accept; this module just
// does the mechanical copy.
//
// pdf-lib (not pdfkit / pdfium): pdfkit only authors new documents and
// pdfium only rasterizes — neither can lift pages out of an existing
// PDF intact. pdf-lib copies the original page objects, so the split
// documents keep the fax's full fidelity (no re-rasterization).
//
// Pure module — no I/O, no PHI logging. Throws only on a corrupt
// source PDF; the caller maps that to a user-visible error.

import { PDFDocument } from "pdf-lib";

export interface PageRange {
  /** 1-based, inclusive. */
  pageStart: number;
  /** 1-based, inclusive. */
  pageEnd: number;
}

/**
 * Copy each requested page range out of `bytes` into its own PDF.
 * Ranges are clamped to the document's real page count (the model's
 * page map can be off-by-one on a miscounted packet); a range that
 * lies entirely outside the document yields the whole document
 * instead, so an accept never files an empty PDF.
 */
export async function splitPdfPages(
  bytes: Buffer,
  ranges: readonly PageRange[],
): Promise<Buffer[]> {
  // ignoreEncryption: fax PDFs are occasionally stamped with an empty
  // owner password by the sending machine; the pages are still readable.
  const source = await PDFDocument.load(bytes, { ignoreEncryption: true });
  const pageCount = source.getPageCount();

  const out: Buffer[] = [];
  for (const range of ranges) {
    const start = Math.max(1, Math.min(range.pageStart, pageCount));
    const end = Math.max(start, Math.min(range.pageEnd, pageCount));
    const valid = range.pageStart <= pageCount;
    const indices = valid
      ? Array.from({ length: end - start + 1 }, (_, i) => start - 1 + i)
      : Array.from({ length: pageCount }, (_, i) => i);

    const doc = await PDFDocument.create();
    const pages = await doc.copyPages(source, indices);
    for (const page of pages) doc.addPage(page);
    out.push(Buffer.from(await doc.save()));
  }
  return out;
}

/**
 * Build a chart filename like "Sleep Study - Jane Doe.pdf". Strips
 * filesystem/header-hostile characters from the human parts; falls
 * back to "Referral document" / "Patient" when blank.
 */
export function buildSectionFilename(
  label: string,
  patientName: string,
): string {
  const clean = (s: string) =>
    s
      .replace(/[\\/:*?"<>|]/g, " ")
      // eslint-disable-next-line no-control-regex -- strip C0 control chars from header-bound filenames
      .replace(/[\x00-\x1f]/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  const safeLabel = clean(label) || "Referral document";
  const safeName = clean(patientName) || "Patient";
  return `${safeLabel} - ${safeName}.pdf`;
}
