// Audit-packet assembler — merge an ordered list of parts (generated pdfkit
// pages + stored chart documents) into ONE PDF, fidelity-preserving.
//
// Generated summary pages come in as already-rendered pdfkit Buffers; stored
// chart documents come in as raw object-storage bytes (PDF or image). We use
// pdf-lib's copyPages (same approach as referral-review/split-pdf.ts) so a
// stored PDF's vector/text is preserved rather than rasterised, and embedJpg/
// embedPng for image attachments (insurance cards, POD photos), one image per
// Letter page. Unsupported/corrupt parts are skipped and reported, never fatal
// — an auditor packet must still build if one attachment won't decode.

import { PDFDocument } from "pdf-lib";

const LETTER_WIDTH = 612;
const LETTER_HEIGHT = 792;
const IMAGE_MARGIN = 36;

export type PacketPart =
  | { kind: "pdf"; label: string; bytes: Buffer }
  | { kind: "image"; label: string; bytes: Buffer; contentType: string };

export interface SkippedPart {
  label: string;
  reason: "unsupported_image" | "decode_failed";
}

export interface AssembleResult {
  pdf: Buffer;
  pageCount: number;
  skipped: SkippedPart[];
}

function isJpeg(contentType: string): boolean {
  const t = contentType.toLowerCase();
  return t.includes("jpeg") || t.includes("jpg");
}

function isPng(contentType: string): boolean {
  return contentType.toLowerCase().includes("png");
}

/**
 * Merge parts in the given order into a single PDF. Pure with respect to I/O
 * (all bytes are passed in). Returns the combined PDF, its page count, and any
 * parts that had to be skipped (with a reason) so the caller can surface them.
 */
export async function assemblePacket(
  parts: readonly PacketPart[],
): Promise<AssembleResult> {
  const out = await PDFDocument.create();
  const skipped: SkippedPart[] = [];

  for (const part of parts) {
    if (part.kind === "pdf") {
      try {
        const src = await PDFDocument.load(part.bytes, {
          ignoreEncryption: true,
        });
        const pages = await out.copyPages(src, src.getPageIndices());
        for (const page of pages) out.addPage(page);
      } catch {
        skipped.push({ label: part.label, reason: "decode_failed" });
      }
      continue;
    }

    // Image part — embed one image on a Letter page, scaled to fit.
    if (!isJpeg(part.contentType) && !isPng(part.contentType)) {
      // pdf-lib only embeds JPEG/PNG; HEIC/WebP would need pre-conversion.
      skipped.push({ label: part.label, reason: "unsupported_image" });
      continue;
    }
    try {
      const image = isJpeg(part.contentType)
        ? await out.embedJpg(part.bytes)
        : await out.embedPng(part.bytes);
      const page = out.addPage([LETTER_WIDTH, LETTER_HEIGHT]);
      const maxW = LETTER_WIDTH - IMAGE_MARGIN * 2;
      const maxH = LETTER_HEIGHT - IMAGE_MARGIN * 2;
      const scale = Math.min(maxW / image.width, maxH / image.height, 1);
      const w = image.width * scale;
      const h = image.height * scale;
      page.drawImage(image, {
        x: (LETTER_WIDTH - w) / 2,
        y: (LETTER_HEIGHT - h) / 2,
        width: w,
        height: h,
      });
    } catch {
      skipped.push({ label: part.label, reason: "decode_failed" });
    }
  }

  const bytes = await out.save();
  return {
    pdf: Buffer.from(bytes),
    pageCount: out.getPageCount(),
    skipped,
  };
}
