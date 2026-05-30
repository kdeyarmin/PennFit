// Appeal letter PDF generator.
//
// Renders a 1-page formal appeal letter using the body text the CSR
// supplies (typically composed from the AI denial analyzer's
// `appeal_letter_sketch`). Issuer + addressee blocks come from the
// DME organization + payer profile rows.
//
// PHI posture: the body text MAY contain PHI by design. Same stream-
// to-requester + object-storage retention sweep posture as the
// other PDFs.

import PDFDocument from "pdfkit";
import type PDFKit from "pdfkit";

export interface AppealInput {
  payerName: string;
  payerAddressLines?: string[];
  claimNumber: string | null;
  patientName: string;
  patientMemberId: string;
  dateOfService: string;
  denialReason: string | null;
  /** The appeal body — paragraph-form prose, plain text. */
  letterBody: string;
  /** Signer block — name + title from dme_organization. */
  signerName: string;
  signerTitle: string;
  dmeOrganization: {
    legalName: string;
    addressLine1: string;
    city: string;
    state: string;
    zip: string;
    phoneE164: string;
    billingEmail: string;
  };
}

export async function renderAppealPdf(input: AppealInput): Promise<Buffer> {
  const doc = new PDFDocument({
    size: "LETTER",
    margins: { top: 90, bottom: 72, left: 72, right: 72 },
  });
  // CONFIDENTIAL banner on every page (45 CFR 164.502).
  doc.on("pageAdded", () => drawConfidentialBanner(doc));
  const chunks: Buffer[] = [];
  return new Promise((resolve, reject) => {
    doc.on("data", (c: Buffer) => chunks.push(c));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);
    try {
      drawConfidentialBanner(doc);
      drawAppeal(doc, input);
      doc.end();
    } catch (err) {
      reject(err);
    }
  });
}

function drawConfidentialBanner(doc: PDFKit.PDFDocument): void {
  const saved = { x: doc.x, y: doc.y };
  doc
    .font("Helvetica-Bold")
    .fontSize(8)
    .fillColor("#7c2d12")
    .text(
      "CONFIDENTIAL — PROTECTED HEALTH INFORMATION — Disclosure restricted under 45 CFR 164.502",
      54,
      36,
      { align: "center", width: 504 },
    );
  doc.fillColor("black").font("Helvetica").fontSize(10);
  doc.x = saved.x;
  doc.y = saved.y === 36 ? 90 : saved.y;
}

function drawAppeal(doc: PDFKit.PDFDocument, input: AppealInput): void {
  // Letterhead.
  doc.font("Helvetica-Bold").fontSize(14).text(input.dmeOrganization.legalName);
  doc
    .font("Helvetica")
    .fontSize(10)
    .text(input.dmeOrganization.addressLine1)
    .text(
      `${input.dmeOrganization.city}, ${input.dmeOrganization.state} ${input.dmeOrganization.zip}`,
    )
    .text(input.dmeOrganization.phoneE164)
    .text(input.dmeOrganization.billingEmail);
  doc.moveDown(1.5);

  doc.fontSize(10).text(new Date().toISOString().slice(0, 10));
  doc.moveDown(0.5);

  // Addressee.
  doc.fontSize(11).text(input.payerName);
  if (input.payerAddressLines) {
    for (const line of input.payerAddressLines) doc.text(line);
  }
  doc.moveDown(1);

  doc.font("Helvetica-Bold").text(`RE: Appeal — Claim Reference`);
  doc
    .font("Helvetica")
    .fontSize(10)
    .text(`Patient: ${input.patientName}`)
    .text(`Member ID: ${input.patientMemberId}`)
    .text(`Date of Service: ${input.dateOfService}`)
    .text(`Claim Number: ${input.claimNumber ?? "(pending payer assignment)"}`)
    .text(`Denial Reason: ${input.denialReason ?? "(see attached EOB)"}`);
  doc.moveDown(1);

  // Body.
  doc.font("Helvetica").fontSize(11).text(input.letterBody, {
    align: "left",
    lineGap: 3,
  });
  doc.moveDown(2);

  // Signer block.
  doc.text("Sincerely,");
  doc.moveDown(2);
  doc.text(input.signerName);
  doc.text(input.signerTitle);
  doc.text(input.dmeOrganization.legalName);
}
