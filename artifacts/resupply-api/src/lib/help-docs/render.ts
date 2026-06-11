// Render invite help documents to PDF email attachments.
//
// The copy in `content.ts` is static and identical for every recipient
// of a given user type (it carries no PHI), so the rendered PDF bytes
// are memoized per document key + version. The first invite of each
// user type pays the render cost; the rest reuse the cached buffer.
//
// Rendering is best-effort: callers wrap `buildInviteHelpAttachments`
// so a PDF failure logs and the invite still goes out without the
// attachment — an invite must never fail because a help doc didn't
// render.

import PDFDocument from "pdfkit";
import type PDFKit from "pdfkit";

import type { AdminRole } from "@workspace/resupply-db";
import type { EmailAttachment } from "@workspace/resupply-auth";

import {
  HELP_DOC_VERSION,
  PATIENT_HELP_DOCS,
  PROVIDER_HELP_DOCS,
  staffHelpDocs,
  type HelpDoc,
  type HelpDocSection,
} from "./content";
import { loadCustomerServiceManual } from "./manual";

const PAGE_WIDTH = 504; // LETTER (612) minus 54pt margins each side
const PDF_CONTENT_TYPE = "application/pdf";

// key + version → rendered PDF bytes. Static content, so this never
// grows beyond the handful of distinct help documents.
const renderedCache = new Map<string, Buffer>();

/** Audience descriptor for {@link buildInviteHelpAttachments}. */
export type HelpDocAudience =
  | { kind: "patient" }
  | { kind: "provider" }
  | { kind: "staff"; role: AdminRole };

function docsFor(audience: HelpDocAudience): ReadonlyArray<HelpDoc> {
  switch (audience.kind) {
    case "patient":
      return PATIENT_HELP_DOCS;
    case "provider":
      return PROVIDER_HELP_DOCS;
    case "staff":
      return staffHelpDocs(audience.role);
  }
}

/**
 * Build the email attachments (rendered help-document PDFs) for the
 * given user type. Each returned attachment is ready to hand to the
 * email sender. Rendering is cached per document, so repeated invites
 * are cheap.
 */
export async function buildInviteHelpAttachments(
  audience: HelpDocAudience,
): Promise<EmailAttachment[]> {
  const docs = docsFor(audience);
  const attachments: EmailAttachment[] = [];
  for (const doc of docs) {
    const content = await renderHelpDocPdf(doc);
    attachments.push({
      content,
      filename: doc.filename,
      contentType: PDF_CONTENT_TYPE,
    });
  }
  // Staff invites additionally carry the full Customer Service
  // Manual — the operations manual for the console the new hire is
  // joining. Best-effort: when the PDF isn't on disk the invite
  // ships with the rendered guides only.
  if (audience.kind === "staff") {
    const manual = await loadCustomerServiceManual();
    if (manual) attachments.push(manual);
  }
  return attachments;
}

async function renderHelpDocPdf(doc: HelpDoc): Promise<Buffer> {
  const cacheKey = `${doc.key}@${HELP_DOC_VERSION}`;
  const cached = renderedCache.get(cacheKey);
  if (cached) return cached;
  const rendered = await renderToBuffer(doc);
  renderedCache.set(cacheKey, rendered);
  return rendered;
}

function renderToBuffer(doc: HelpDoc): Promise<Buffer> {
  const pdf = new PDFDocument({
    size: "LETTER",
    margins: { top: 64, bottom: 56, left: 54, right: 54 },
    bufferPages: true,
  });
  const chunks: Buffer[] = [];
  return new Promise((resolve, reject) => {
    pdf.on("data", (c: Buffer) => chunks.push(c));
    pdf.on("end", () => resolve(Buffer.concat(chunks)));
    pdf.on("error", reject);
    try {
      drawHelpDoc(pdf, doc);
      pdf.end();
    } catch (err) {
      reject(err);
    }
  });
}

function drawHelpDoc(pdf: PDFKit.PDFDocument, doc: HelpDoc): void {
  // ── Header ──
  pdf.font("Helvetica-Bold").fontSize(18).fillColor("#0f172a").text(doc.title);
  pdf.moveDown(0.3);
  pdf
    .font("Helvetica")
    .fontSize(11)
    .fillColor("#475569")
    .text(doc.subtitle, { width: PAGE_WIDTH, lineGap: 2 });
  pdf.moveDown(0.8);

  for (const section of doc.sections) {
    drawSection(pdf, section);
  }

  // ── Footer note ──
  pdf.moveDown(1);
  pdf
    .font("Helvetica-Oblique")
    .fontSize(8)
    .fillColor("#94a3b8")
    .text(
      `PennPaps • This guide is for general help only and contains no personal health information. (rev ${HELP_DOC_VERSION})`,
      { width: PAGE_WIDTH },
    );
  pdf.fillColor("#000000");
}

function drawSection(pdf: PDFKit.PDFDocument, section: HelpDocSection): void {
  if (section.heading) {
    pdf.moveDown(0.6);
    pdf
      .font("Helvetica-Bold")
      .fontSize(12)
      .fillColor("#0f172a")
      .text(section.heading);
    pdf.moveDown(0.3);
  }
  for (const p of section.paragraphs ?? []) {
    pdf
      .font("Helvetica")
      .fontSize(10)
      .fillColor("#1f2937")
      .text(p, { align: "left", lineGap: 2, width: PAGE_WIDTH });
    pdf.moveDown(0.5);
  }
  for (const b of section.bullets ?? []) {
    pdf
      .font("Helvetica")
      .fontSize(10)
      .fillColor("#1f2937")
      .text(`•  ${b}`, { indent: 10, lineGap: 2, width: PAGE_WIDTH });
    pdf.moveDown(0.2);
  }
  pdf.fillColor("#000000");
}

/** Test seam — clear the rendered-bytes cache between specs. */
export function __clearHelpDocCache(): void {
  renderedCache.clear();
}
