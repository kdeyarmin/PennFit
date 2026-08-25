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
  patientHelpDocs,
  providerHelpDocs,
  staffHelpDocs,
  type HelpDoc,
  type HelpDocSection,
} from "./content";
import { loadCustomerServiceManual } from "./manual";
import { staffRoleProfile } from "./roles";

const PAGE_WIDTH = 504; // LETTER (612) minus 54pt margins each side
const PDF_CONTENT_TYPE = "application/pdf";

// key + version + tenant name → rendered PDF bytes. The tenant name is
// part of the key because the copy is branded to it — without that, the
// first tenant to request a guide would poison the cache for every
// other tenant.
const renderedCache = new Map<string, Buffer>();

/**
 * An invite attachment plus the one-line explanation of what it is.
 * The invite email lists these so a new hire opening three PDFs knows
 * which is which; structurally an `EmailAttachment`, so it can be
 * handed to the email sender unchanged (the sender maps
 * content/filename/contentType and ignores the rest).
 */
export interface InviteHelpAttachment extends EmailAttachment {
  description: string;
}

/** What the pre-rendered Customer Service Manual is, for the email's
 *  attachment list. */
const CUSTOMER_SERVICE_MANUAL_DESCRIPTION =
  "The full operations manual for the service desk: the day-to-day procedures behind the console.";

/** Audience descriptor for {@link buildInviteHelpAttachments}. */
export type HelpDocAudience =
  | { kind: "patient" }
  | { kind: "provider" }
  | { kind: "staff"; role: AdminRole };

function docsFor(
  audience: HelpDocAudience,
  company: string,
): ReadonlyArray<HelpDoc> {
  switch (audience.kind) {
    case "patient":
      return patientHelpDocs(company);
    case "provider":
      return providerHelpDocs(company);
    case "staff":
      return staffHelpDocs(audience.role, company);
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
  /** The inviting tenant's own company name — these PDFs carry it. */
  company: string,
): Promise<InviteHelpAttachment[]> {
  const docs = docsFor(audience, company);
  const attachments: InviteHelpAttachment[] = [];
  for (const doc of docs) {
    const content = await renderHelpDocPdf(doc, company);
    attachments.push({
      content,
      filename: doc.filename,
      contentType: PDF_CONTENT_TYPE,
      description: doc.description,
    });
  }
  // Staff invites in a customer-service job (the service desk itself,
  // and the roles that supervise it) additionally carry the full
  // Customer Service Manual. A biller or an RT does NOT: it used to go
  // to every staff invite regardless of role, so their welcome email
  // arrived with a customer-service manual and nothing about their own
  // job. Their role handbook covers that, and the complete
  // role-organised User Manual is on the console's Support page for
  // everyone. Best-effort: when the PDF isn't on disk the invite ships
  // with the rendered guides only.
  if (audience.kind === "staff") {
    const { customerServiceManual } = staffRoleProfile(audience.role);
    if (customerServiceManual) {
      const manual = await loadCustomerServiceManual();
      if (manual) {
        attachments.push({
          ...manual,
          description: CUSTOMER_SERVICE_MANUAL_DESCRIPTION,
        });
      }
    }
  }
  return attachments;
}

async function renderHelpDocPdf(
  doc: HelpDoc,
  company: string,
): Promise<Buffer> {
  const cacheKey = `${doc.key}@${HELP_DOC_VERSION}#${company}`;
  const cached = renderedCache.get(cacheKey);
  if (cached) return cached;
  const rendered = await renderToBuffer(doc, company);
  renderedCache.set(cacheKey, rendered);
  return rendered;
}

function renderToBuffer(doc: HelpDoc, company: string): Promise<Buffer> {
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
      drawHelpDoc(pdf, doc, company);
      pdf.end();
    } catch (err) {
      reject(err);
    }
  });
}

function drawHelpDoc(
  pdf: PDFKit.PDFDocument,
  doc: HelpDoc,
  company: string,
): void {
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
      `${company} • This guide is for general help only and contains no personal health information. (rev ${HELP_DOC_VERSION})`,
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
  const steps = section.steps ?? [];
  steps.forEach((step, i) => {
    pdf
      .font("Helvetica")
      .fontSize(10)
      .fillColor("#1f2937")
      .text(`${i + 1}.  ${step}`, {
        indent: 10,
        lineGap: 2,
        width: PAGE_WIDTH,
      });
    pdf.moveDown(0.2);
  });
  pdf.fillColor("#000000");
}

/** Test seam — clear the rendered-bytes cache between specs. */
export function __clearHelpDocCache(): void {
  renderedCache.clear();
}
