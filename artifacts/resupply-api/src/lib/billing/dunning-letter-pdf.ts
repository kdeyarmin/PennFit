// Dunning final-notice letter batch PDF.
//
// The dunning ladder's `final_notice` step includes a `letter` channel that
// the worker can't send electronically. This renders a print batch — one
// final-notice letter per page, on the practice letterhead — that staff can
// fold and mail. Mirrors the statement mail-queue batch (renderStatementsBatch
// Pdf): one PDFDocument, a fresh page per letter, the CONFIDENTIAL banner
// re-stamped on every page.
//
// PHI: letters carry patient name + balance. Bytes are streamed/attached,
// never logged.

import PDFDocument from "pdfkit";
import type PDFKit from "pdfkit";

const MARGIN = 72;
const PAGE_WIDTH = 612;
const USABLE_WIDTH = PAGE_WIDTH - MARGIN * 2;

export interface DunningLetterCompany {
  legalName: string;
  addressLines: string[];
  phone?: string | null;
}

export interface DunningLetter {
  patientName: string;
  addressLines: string[];
  balanceCents: number;
  /** Optional "please remit by" date (YYYY-MM-DD). */
  payByDate?: string | null;
}

export interface DunningLettersBatchInput {
  company: DunningLetterCompany;
  letters: DunningLetter[];
  /** Passed in (not derived) for deterministic tests. */
  generatedOn: Date;
}

function usd(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

function fmtDate(d: Date): string {
  return d.toLocaleDateString("en-US", {
    year: "numeric",
    month: "long",
    day: "numeric",
  });
}

/** Render the batch to a Buffer. Throws on an empty batch. */
export async function renderDunningLettersBatchPdf(
  input: DunningLettersBatchInput,
): Promise<{ pdf: Buffer; letterCount: number }> {
  if (input.letters.length === 0) {
    throw new Error("Cannot render an empty dunning-letter batch");
  }
  const doc = new PDFDocument({ size: "LETTER", margin: MARGIN });
  doc.on("pageAdded", () => banner(doc));
  const chunks: Buffer[] = [];
  return new Promise((resolve, reject) => {
    doc.on("data", (c: Buffer) => chunks.push(c));
    doc.on("end", () =>
      resolve({
        pdf: Buffer.concat(chunks),
        letterCount: input.letters.length,
      }),
    );
    doc.on("error", reject);
    try {
      input.letters.forEach((letter, i) => {
        if (i > 0) doc.addPage();
        else banner(doc);
        drawLetter(doc, input.company, letter, input.generatedOn);
      });
      doc.end();
    } catch (err) {
      reject(err);
    }
  });
}

function banner(doc: PDFKit.PDFDocument): void {
  doc
    .fontSize(8)
    .font("Helvetica-Bold")
    .fillColor("#cc0000")
    .text("CONFIDENTIAL — BILLING NOTICE", MARGIN, MARGIN, {
      width: USABLE_WIDTH,
      align: "center",
    })
    .fillColor("#000000");
  doc.moveDown(1);
}

function drawLetter(
  doc: PDFKit.PDFDocument,
  company: DunningLetterCompany,
  letter: DunningLetter,
  generatedOn: Date,
): void {
  // Letterhead.
  doc.fontSize(16).font("Helvetica-Bold").text(company.legalName, {
    width: USABLE_WIDTH,
  });
  doc.fontSize(10).font("Helvetica").fillColor("#555555");
  for (const line of company.addressLines) {
    doc.text(line, { width: USABLE_WIDTH });
  }
  if (company.phone) doc.text(company.phone, { width: USABLE_WIDTH });
  doc.fillColor("#000000");
  doc.moveDown(1);

  doc.fontSize(11).font("Helvetica").text(fmtDate(generatedOn), {
    width: USABLE_WIDTH,
  });
  doc.moveDown(0.8);

  // Recipient block.
  doc.font("Helvetica-Bold").text(letter.patientName, { width: USABLE_WIDTH });
  doc.font("Helvetica");
  for (const line of letter.addressLines) {
    doc.text(line, { width: USABLE_WIDTH });
  }
  doc.moveDown(1);

  doc
    .font("Helvetica-Bold")
    .text("RE: Final Notice — Past-Due Balance", { width: USABLE_WIDTH })
    .font("Helvetica");
  doc.moveDown(0.8);

  const payBy = letter.payByDate ? ` by ${letter.payByDate}` : "";
  doc
    .fontSize(11)
    .text(
      `Our records show an outstanding balance of ${usd(letter.balanceCents)} on your account. ` +
        "Previous statements and reminders have gone unpaid. This is a final notice: if the balance " +
        `is not paid${payBy}, your account may be referred to a collections agency.`,
      { width: USABLE_WIDTH, lineGap: 3 },
    );
  doc.moveDown(0.6);
  doc.text(
    "If you have already paid, or believe this notice is in error, or would like to arrange a " +
      "payment plan, please contact our billing team right away.",
    { width: USABLE_WIDTH, lineGap: 3 },
  );
  doc.moveDown(1.2);
  doc.text("Sincerely,", { width: USABLE_WIDTH });
  doc.moveDown(0.4);
  doc.text(`${company.legalName} — Billing Department`, {
    width: USABLE_WIDTH,
  });
}
