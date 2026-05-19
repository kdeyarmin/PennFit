// Patient billing statement PDF generator.
//
// Renders a 1-page summary statement listing each claim with a
// non-zero patient_responsibility_cents balance, the payer / DOS /
// billed / paid / patient-owes columns, and a payment-due total.
//
// PHI posture: same as the HCFA-1500 and GFE renderers — stream the
// bytes to the requester, persist the PDF to object storage with the
// existing retention sweep, log only counts.

import PDFDocument from "pdfkit";
import type PDFKit from "pdfkit";

export interface StatementInput {
  patient: {
    name: string;
    address?: {
      line1: string;
      line2?: string;
      city: string;
      state: string;
      zip: string;
    };
    email?: string | null;
  };
  dmeOrganization: {
    legalName: string;
    addressLine1: string;
    city: string;
    state: string;
    zip: string;
    phoneE164: string;
    billingEmail: string;
  };
  lineItems: Array<{
    claimId: string;
    payerName: string;
    dateOfService: string;
    billedCents: number;
    paidCents: number;
    patientResponsibilityCents: number;
  }>;
  /** Optional "pay by" date for the statement. */
  payByDate?: string | null;
  /** Optional online-payment URL. */
  paymentUrl?: string | null;
}

export interface StatementResult {
  pdf: Buffer;
  totalPatientResponsibilityCents: number;
}

export async function renderStatementPdf(
  input: StatementInput,
): Promise<StatementResult> {
  const doc = new PDFDocument({
    size: "LETTER",
    margins: { top: 54, bottom: 54, left: 54, right: 54 },
  });
  const chunks: Buffer[] = [];
  return new Promise((resolve, reject) => {
    doc.on("data", (c: Buffer) => chunks.push(c));
    doc.on("end", () => {
      const total = input.lineItems.reduce(
        (s, l) => s + l.patientResponsibilityCents,
        0,
      );
      resolve({
        pdf: Buffer.concat(chunks),
        totalPatientResponsibilityCents: total,
      });
    });
    doc.on("error", reject);
    try {
      drawStatement(doc, input);
      doc.end();
    } catch (err) {
      reject(err);
    }
  });
}

function drawStatement(
  doc: PDFKit.PDFDocument,
  input: StatementInput,
): void {
  doc
    .font("Helvetica-Bold")
    .fontSize(18)
    .text("Patient Billing Statement", { align: "center" });
  doc.moveDown(1.5);

  // Issuer block
  doc.font("Helvetica-Bold").fontSize(11).text("From");
  doc
    .font("Helvetica")
    .fontSize(10)
    .text(input.dmeOrganization.legalName)
    .text(input.dmeOrganization.addressLine1)
    .text(
      `${input.dmeOrganization.city}, ${input.dmeOrganization.state} ${input.dmeOrganization.zip}`,
    )
    .text(`Phone: ${input.dmeOrganization.phoneE164}`)
    .text(`Email: ${input.dmeOrganization.billingEmail}`);
  doc.moveDown(1);

  // Patient block
  doc.font("Helvetica-Bold").fontSize(11).text("To");
  doc.font("Helvetica").fontSize(10).text(input.patient.name);
  if (input.patient.address) {
    doc.text(input.patient.address.line1);
    if (input.patient.address.line2) doc.text(input.patient.address.line2);
    doc.text(
      `${input.patient.address.city}, ${input.patient.address.state} ${input.patient.address.zip}`,
    );
  }
  if (input.patient.email) doc.text(input.patient.email);
  doc.moveDown(1);
  doc.fontSize(10).text(`Statement Date: ${new Date().toISOString().slice(0, 10)}`);
  if (input.payByDate) {
    doc.font("Helvetica-Bold").text(`Pay By: ${input.payByDate}`);
  }
  doc.font("Helvetica").moveDown(1);

  // Item table
  doc.font("Helvetica-Bold").fontSize(11).text("Balance Detail");
  doc.moveDown(0.3);
  const tableTop = doc.y;
  const colDate = 54;
  const colPayer = 140;
  const colBilled = 330;
  const colPaid = 400;
  const colOwed = 470;
  doc.font("Helvetica-Bold").fontSize(9);
  doc.text("Date of Service", colDate, tableTop);
  doc.text("Payer", colPayer, tableTop);
  doc.text("Billed", colBilled, tableTop);
  doc.text("Paid", colPaid, tableTop);
  doc.text("You Owe", colOwed, tableTop);
  doc.font("Helvetica");
  let y = tableTop + 14;
  let total = 0;
  for (const item of input.lineItems) {
    total += item.patientResponsibilityCents;
    doc.fontSize(9);
    doc.text(item.dateOfService, colDate, y);
    doc.text(item.payerName.slice(0, 30), colPayer, y, { width: 180 });
    doc.text(money(item.billedCents), colBilled, y);
    doc.text(money(item.paidCents), colPaid, y);
    doc.text(money(item.patientResponsibilityCents), colOwed, y);
    y += 18;
  }
  y += 8;
  doc.moveTo(colDate, y).lineTo(540, y).stroke();
  y += 8;
  doc.font("Helvetica-Bold").fontSize(12).text("TOTAL DUE", colPaid, y);
  doc.text(money(total), colOwed, y);
  doc.font("Helvetica");
  doc.moveDown(2);

  if (input.paymentUrl) {
    doc.fontSize(10).text(`Pay online: ${input.paymentUrl}`);
  }
  doc.moveDown(1);
  doc.fontSize(8).fillColor("#444").text(
    "Questions? Contact us at the phone or email above. " +
      "If you have insurance updates that may apply to these dates of service, " +
      "please share them with our billing team and we will re-bill on your behalf.",
    { align: "left" },
  );
}

function money(cents: number): string {
  const d = Math.floor(cents / 100);
  const c = cents % 100;
  return `$${d}.${c.toString().padStart(2, "0")}`;
}
