// Detailed Written Order (DWO) / CMN cover PDF generator.
//
// The SWO generator (lib/swo-pdf.ts) renders the CMS-standardized
// Standard Written Order from a prescription. But the `dwo_documents`
// table also tracks the older order families a supplier still needs on
// file for some payers/items — the Detailed Written Order and the
// CMN-484 (oxygen) / CMN-843 covers — and there was no way to RENDER
// those: the row only carried tracking metadata (form_type, family,
// signed/expires dates, signing provider). A CSR/biller had to produce
// the document by hand outside the app.
//
// This renders a clean, signable cover/order PDF from a `dwo_documents`
// row + the patient + (optional) signing provider. It deliberately does
// NOT try to reproduce the full CMS-484 clinical questionnaire (that
// needs the structured Q&A in cmn_documents and is a separate build) —
// it produces the order/cover with the beneficiary, item family, order
// + expiry dates, ordering practitioner, and a signature line, which is
// what the tracking row models and what most "we need the DWO on file"
// requests are asking for.
//
// PHI posture: the PDF contains PHI; the route streams it to the
// authenticated admin and audits the access. Bytes never hit the logger.

import PDFDocument from "pdfkit";
import type PDFKit from "pdfkit";

const MARGIN = 72;
const PAGE_WIDTH = 612;
const USABLE_WIDTH = PAGE_WIDTH - MARGIN * 2;

export type DwoFormType = "dwo" | "cmn_484" | "cmn_843" | "swo";
export type DwoHcpcsFamily =
  | "pap"
  | "rad"
  | "oxygen"
  | "hospital_bed"
  | "wheelchair"
  | "other";

export interface DwoPatient {
  legalFirstName: string;
  legalLastName: string;
  dateOfBirth: string;
  address: {
    line1?: string;
    line2?: string;
    city?: string;
    state?: string;
    postalCode?: string;
  } | null;
}

export interface DwoProvider {
  legalName: string;
  npi: string;
  practiceName: string | null;
  phoneE164: string | null;
  faxE164: string | null;
}

export interface DwoPdfInput {
  formType: DwoFormType;
  hcpcsFamily: DwoHcpcsFamily;
  /** YYYY-MM-DD. */
  signedOn: string;
  /** YYYY-MM-DD. */
  expiresOn: string;
  notes: string | null;
  patient: DwoPatient;
  /** null when the row has no signing_provider_id linked yet. */
  provider: DwoProvider | null;
  /** Passed in (not derived) so tests are deterministic. */
  generatedOn: Date;
  supplierName: string;
}

/** Human title for the order family. Pure — unit-tested. */
export function dwoFormTitle(formType: DwoFormType): string {
  switch (formType) {
    case "dwo":
      return "Detailed Written Order";
    case "cmn_484":
      return "Certificate of Medical Necessity (CMS-484)";
    case "cmn_843":
      return "Certificate of Medical Necessity (CMS-843)";
    case "swo":
      return "Standard Written Order";
  }
}

/** Human label for the HCPCS family. Pure — unit-tested. */
export function describeHcpcsFamily(family: DwoHcpcsFamily): string {
  switch (family) {
    case "pap":
      return "Positive airway pressure (CPAP/APAP)";
    case "rad":
      return "Respiratory assist device (BiPAP)";
    case "oxygen":
      return "Home oxygen therapy";
    case "hospital_bed":
      return "Hospital bed & accessories";
    case "wheelchair":
      return "Wheelchair / mobility";
    case "other":
      return "Other DMEPOS item";
  }
}

export interface DwoValidationError {
  field: string;
  message: string;
}

/** Validate the minimum fields needed to render. Pure — unit-tested. */
export function validateDwoInput(input: DwoPdfInput): DwoValidationError[] {
  const errors: DwoValidationError[] = [];
  if (!input.patient.legalFirstName || !input.patient.legalLastName) {
    errors.push({
      field: "patient",
      message: "Patient legal name is required.",
    });
  }
  if (!input.patient.dateOfBirth) {
    errors.push({
      field: "patient.dateOfBirth",
      message: "Patient date of birth is required.",
    });
  }
  if (
    input.provider &&
    input.provider.npi &&
    !/^\d{10}$/.test(input.provider.npi)
  ) {
    errors.push({
      field: "provider.npi",
      message: "Provider NPI must be 10 digits when present.",
    });
  }
  return errors;
}

/** Render the DWO/CMN cover PDF to a Buffer (same pattern as appeal-pdf). */
export async function renderDwoPdf(input: DwoPdfInput): Promise<Buffer> {
  const doc = new PDFDocument({ size: "LETTER", margin: MARGIN });
  const chunks: Buffer[] = [];
  return new Promise<Buffer>((resolve, reject) => {
    doc.on("data", (c: Buffer) => chunks.push(c));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);
    try {
      drawDwo(doc, input);
      doc.end();
    } catch (err) {
      reject(err);
    }
  });
}

function drawDwo(doc: PDFKit.PDFDocument, input: DwoPdfInput): void {
  doc
    .fontSize(9)
    .font("Helvetica-Bold")
    .fillColor("#cc0000")
    .text("CONFIDENTIAL — HIPAA PROTECTED HEALTH INFORMATION", MARGIN, MARGIN, {
      width: USABLE_WIDTH,
      align: "center",
    })
    .fillColor("#000000");
  doc.moveDown(0.5);
  rule(doc);
  doc.moveDown(0.8);

  doc.fontSize(18).font("Helvetica-Bold").text(dwoFormTitle(input.formType), {
    align: "center",
    width: USABLE_WIDTH,
  });
  doc
    .fontSize(10)
    .font("Helvetica")
    .fillColor("#555555")
    .text(`${input.supplierName} · DMEPOS order on file`, {
      align: "center",
      width: USABLE_WIDTH,
    })
    .fillColor("#000000");
  doc.moveDown(1.2);

  field(doc, "Order date", formatDate(input.generatedOn));
  field(doc, "Signed on", formatIsoDate(input.signedOn));
  field(doc, "Valid through", formatIsoDate(input.expiresOn));
  doc.moveDown(0.5);
  rule(doc);
  doc.moveDown(0.8);

  header(doc, "Beneficiary");
  field(
    doc,
    "Name",
    `${input.patient.legalLastName}, ${input.patient.legalFirstName}`,
  );
  field(doc, "Date of birth", formatIsoDate(input.patient.dateOfBirth));
  if (input.patient.address) {
    field(doc, "Address", formatAddress(input.patient.address));
  }
  doc.moveDown(0.6);
  rule(doc);
  doc.moveDown(0.8);

  header(doc, "Item ordered");
  field(doc, "Category", describeHcpcsFamily(input.hcpcsFamily));
  if (input.notes) field(doc, "Order detail", input.notes);
  doc.moveDown(0.6);
  rule(doc);
  doc.moveDown(0.8);

  header(doc, "Ordering practitioner");
  if (input.provider) {
    field(doc, "Name", input.provider.legalName);
    field(doc, "NPI", input.provider.npi);
    if (input.provider.practiceName) {
      field(doc, "Practice", input.provider.practiceName);
    }
    if (input.provider.phoneE164) field(doc, "Phone", input.provider.phoneE164);
    if (input.provider.faxE164) field(doc, "Fax", input.provider.faxE164);
  } else {
    doc
      .fontSize(10)
      .font("Helvetica-Oblique")
      .fillColor("#555555")
      .text("No ordering provider linked on this order.", {
        width: USABLE_WIDTH,
      })
      .fillColor("#000000");
  }
  doc.moveDown(1.6);

  doc.fontSize(10).font("Helvetica");
  doc.text("Practitioner signature: ____________________________________", {
    width: USABLE_WIDTH,
  });
  doc.moveDown(0.4);
  doc.text("Date: __________________", { width: USABLE_WIDTH });

  const footerY = 720;
  doc
    .moveTo(MARGIN, footerY)
    .lineTo(PAGE_WIDTH - MARGIN, footerY)
    .strokeColor("#aaaaaa")
    .stroke()
    .strokeColor("#000000");
  doc
    .fontSize(8)
    .font("Helvetica")
    .fillColor("#555555")
    .text(
      "This document contains protected health information governed by HIPAA. " +
        "Maintain in the supplier record per CMS DMEPOS documentation requirements.",
      MARGIN,
      footerY + 6,
      { width: USABLE_WIDTH, align: "center" },
    )
    .fillColor("#000000");
}

function header(doc: PDFKit.PDFDocument, label: string): void {
  doc.fontSize(11).font("Helvetica-Bold").text(label, { width: USABLE_WIDTH });
  doc.moveDown(0.3);
}

function field(doc: PDFKit.PDFDocument, label: string, value: string): void {
  doc
    .fontSize(10)
    .font("Helvetica-Bold")
    .text(`${label}: `, { continued: true, width: USABLE_WIDTH });
  doc.font("Helvetica").text(value, { width: USABLE_WIDTH });
  doc.moveDown(0.2);
}

function rule(doc: PDFKit.PDFDocument): void {
  doc
    .moveTo(MARGIN, doc.y)
    .lineTo(PAGE_WIDTH - MARGIN, doc.y)
    .strokeColor("#aaaaaa")
    .stroke()
    .strokeColor("#000000");
}

function formatDate(d: Date): string {
  return d.toLocaleDateString("en-US", {
    year: "numeric",
    month: "long",
    day: "numeric",
  });
}

function formatIsoDate(iso: string): string {
  const [y, m, d] = iso.split("-").map(Number);
  if (!y || !m || !d) return iso;
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString("en-US", {
    year: "numeric",
    month: "long",
    day: "numeric",
    timeZone: "UTC",
  });
}

function formatAddress(a: {
  line1?: string;
  line2?: string;
  city?: string;
  state?: string;
  postalCode?: string;
}): string {
  const parts: string[] = [];
  if (a.line1) parts.push(a.line1);
  if (a.line2) parts.push(a.line2);
  const cityState = [a.city, a.state].filter(Boolean).join(", ");
  const tail = [cityState, a.postalCode].filter(Boolean).join(" ");
  if (tail) parts.push(tail);
  return parts.join("\n");
}
