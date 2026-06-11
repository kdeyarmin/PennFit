// Good Faith Estimate (GFE) PDF generator.
//
// Required under the No Surprises Act (45 CFR §149.610) for any
// scheduled DME item sold to an uninsured or self-pay patient. The
// patient MUST receive a written GFE before the service is rendered.
//
// HHS retention requirement: 3 years.
//
// PHI posture: the GFE contains the patient's name, address, and
// the items they're being billed for. Same posture as the HCFA-1500
// renderer — stream to the requester, persist the PDF to object
// storage with a retention-swept lifecycle, log only counts.

import PDFDocument from "pdfkit";
import type PDFKit from "pdfkit";

export interface GfeInput {
  recipientName: string;
  recipientEmail: string;
  recipientAddress?: {
    line1: string;
    line2?: string;
    city: string;
    state: string;
    zip: string;
  };
  items: GfeItem[];
  /** Optional service date the patient is being quoted for. */
  expectedServiceDate?: string | null;
  /** Print-time disclaimer text. The caller passes the version that
   *  was active at GFE generation so a later template change doesn't
   *  rewrite what we showed the patient. */
  disclaimerText: string;
  /** DME organization identity (legal name, NPI, address, phone). */
  dmeOrganization: {
    legalName: string;
    npi: string;
    addressLine1: string;
    city: string;
    state: string;
    zip: string;
    phoneE164: string;
    billingEmail: string;
  };
}

export interface GfeItem {
  description: string;
  hcpcsCode?: string | null;
  quantity: number;
  unitPriceCents: number;
}

export interface GfeRenderResult {
  pdf: Buffer;
  totalCents: number;
}

const DEFAULT_DISCLAIMER = [
  "This Good Faith Estimate shows the costs of items and services that are",
  "reasonably expected for your health care needs for an item or service. The",
  "estimate is based on information known at the time the estimate was",
  "created.",
  "",
  "The Good Faith Estimate does not include any unknown or unexpected costs",
  "that may arise during treatment. You could be charged more if complications",
  "or special circumstances occur. If this happens, federal law allows you to",
  "dispute (appeal) the bill.",
  "",
  "If you are billed at least $400 more than this Good Faith Estimate, you",
  "have the right to dispute the bill through the federal patient-provider",
  "dispute resolution (PPDR) process.",
  "",
  "You may contact the health care provider or facility listed to let them",
  "know the billed charges are higher than the Good Faith Estimate. You can",
  "ask them to update the bill to match the Good Faith Estimate, ask to",
  "negotiate the bill, or ask if there is financial assistance available.",
  "",
  "You may also start a dispute resolution process with the U.S. Department",
  "of Health and Human Services (HHS). If you choose to use the dispute",
  "resolution process, you must start the dispute process within 120 calendar",
  "days (about 4 months) of the date on the original bill.",
  "",
  "For questions or more information about your right to a Good Faith",
  "Estimate or the dispute process, visit www.cms.gov/nosurprises or call",
  "1-800-985-3059.",
  "",
  "This Good Faith Estimate is not a contract. It does not require you to",
  "obtain the items or services listed from this provider.",
  "",
  "Keep a copy of this Good Faith Estimate in a safe place or take pictures",
  "of it. You may need it if you are billed a higher amount.",
].join("\n");

export const DEFAULT_GFE_DISCLAIMER = DEFAULT_DISCLAIMER;

export async function renderGfePdf(input: GfeInput): Promise<GfeRenderResult> {
  const doc = new PDFDocument({
    size: "LETTER",
    margins: { top: 54, bottom: 54, left: 54, right: 54 },
  });
  const chunks: Buffer[] = [];
  return new Promise((resolve, reject) => {
    doc.on("data", (c: Buffer) => chunks.push(c));
    doc.on("end", () => {
      const totalCents = input.items.reduce(
        (s, i) => s + i.unitPriceCents * i.quantity,
        0,
      );
      resolve({ pdf: Buffer.concat(chunks), totalCents });
    });
    doc.on("error", reject);
    try {
      drawGfe(doc, input);
      doc.end();
    } catch (err) {
      reject(err);
    }
  });
}

function drawGfe(doc: PDFKit.PDFDocument, input: GfeInput): void {
  // ── Header ──
  doc
    .font("Helvetica-Bold")
    .fontSize(18)
    .text("Good Faith Estimate", { align: "center" });
  doc
    .font("Helvetica")
    .fontSize(10)
    .text("Required under the No Surprises Act (45 CFR §149.610)", {
      align: "center",
    });
  doc.moveDown(1.5);

  // ── Issuer block ──
  doc.font("Helvetica-Bold").fontSize(11).text("Issued by");
  doc
    .font("Helvetica")
    .fontSize(10)
    .text(input.dmeOrganization.legalName)
    .text(input.dmeOrganization.addressLine1)
    .text(
      `${input.dmeOrganization.city}, ${input.dmeOrganization.state} ${input.dmeOrganization.zip}`,
    )
    .text(`Phone: ${input.dmeOrganization.phoneE164}`)
    .text(`NPI: ${input.dmeOrganization.npi}`)
    .text(`Billing: ${input.dmeOrganization.billingEmail}`);
  doc.moveDown(1);

  // ── Recipient block ──
  doc.font("Helvetica-Bold").fontSize(11).text("Issued to");
  doc.font("Helvetica").fontSize(10).text(input.recipientName);
  if (input.recipientAddress) {
    doc.text(input.recipientAddress.line1);
    if (input.recipientAddress.line2) doc.text(input.recipientAddress.line2);
    doc.text(
      `${input.recipientAddress.city}, ${input.recipientAddress.state} ${input.recipientAddress.zip}`,
    );
  }
  doc.text(input.recipientEmail);
  doc.moveDown(0.5);
  doc.text(
    `Generated on ${new Date().toISOString().slice(0, 10)}` +
      (input.expectedServiceDate
        ? `   Expected service date: ${input.expectedServiceDate}`
        : ""),
  );
  doc.moveDown(1);

  // ── Items table ──
  doc.font("Helvetica-Bold").fontSize(11).text("Estimated Charges");
  doc.moveDown(0.3);
  const tableTop = doc.y;
  const colDescX = 54;
  const colHcpcsX = 320;
  const colQtyX = 390;
  const colUnitX = 430;
  const colLineX = 500;
  const rowH = 18;

  doc.font("Helvetica-Bold").fontSize(9);
  doc.text("Description", colDescX, tableTop);
  doc.text("HCPCS", colHcpcsX, tableTop);
  doc.text("Qty", colQtyX, tableTop);
  doc.text("Unit", colUnitX, tableTop);
  doc.text("Line $", colLineX, tableTop);
  doc.font("Helvetica");
  let y = tableTop + 14;
  let total = 0;
  for (const item of input.items) {
    const line = item.unitPriceCents * item.quantity;
    total += line;
    doc.fontSize(9).text(item.description.slice(0, 50), colDescX, y, {
      width: 250,
    });
    doc.text(item.hcpcsCode ?? "-", colHcpcsX, y);
    doc.text(String(item.quantity), colQtyX, y);
    doc.text(formatMoney(item.unitPriceCents), colUnitX, y);
    doc.text(formatMoney(line), colLineX, y);
    y += rowH;
  }
  // Total
  y += 6;
  doc.moveTo(colDescX, y).lineTo(550, y).stroke();
  y += 6;
  doc.font("Helvetica-Bold").fontSize(11).text("TOTAL", colUnitX, y);
  doc.text(formatMoney(total), colLineX, y);
  doc.font("Helvetica");

  // ── Disclaimer ──
  doc.addPage();
  doc.font("Helvetica-Bold").fontSize(12).text("Your Rights and Protections", {
    align: "left",
  });
  doc.moveDown(0.5);
  doc.font("Helvetica").fontSize(9).text(input.disclaimerText, {
    align: "left",
    lineGap: 2,
  });
}

function formatMoney(cents: number): string {
  // Negative-amount safe — see statement-pdf.ts:money() for the
  // rationale. A discount line that's typed as negative cents
  // shouldn't render as "$-2.-50" on a Good Faith Estimate PDF.
  const sign = cents < 0 ? "-" : "";
  const abs = Math.abs(cents);
  const d = Math.floor(abs / 100);
  const c = abs % 100;
  return `${sign}$${d}.${c.toString().padStart(2, "0")}`;
}
