// CMN / DIF clinical-questionnaire PDF generator (DME accuracy item A5).
//
// dwo-pdf.ts renders the DWO/CMN *cover* (beneficiary, item family, order
// + expiry dates, signature line) but deliberately NOT the answered
// clinical questionnaire. This renders that questionnaire from a
// `cmn_documents` row: the form's question set (from the CMN_FORMS
// catalog) paired with the stored `answers`, plus the beneficiary,
// ordering physician, certification dates, and a physician attestation +
// signature line — i.e. the CMS-484 / 846 / 848 / DIF form a payer that
// still requires a CMN is asking for.
//
// Pure render (generatedOn passed in) so it's deterministic + unit-tested.
// PHI posture: the bytes carry PHI; the route streams them to the
// authenticated admin and audits the access. Bytes never hit the logger.

import PDFDocument from "pdfkit";
import type PDFKit from "pdfkit";

import { CMN_FORMS, type CmnFormDef } from "./cmn-forms";

const MARGIN = 72;
const PAGE_WIDTH = 612;
const USABLE_WIDTH = PAGE_WIDTH - MARGIN * 2;

export interface CmnPdfPatient {
  legalFirstName: string;
  legalLastName: string;
  dateOfBirth: string;
  address: {
    line1?: string;
    line2?: string;
    city?: string;
    state?: string;
    zip?: string;
    postalCode?: string;
    postal_code?: string;
  } | null;
}

export interface CmnPdfInput {
  formType: string;
  hcpcsCode: string;
  status: string;
  answers: Record<string, unknown> | null;
  physicianName: string | null;
  physicianNpi: string | null;
  /** YYYY-MM-DD or null. */
  initialDate: string | null;
  recertDate: string | null;
  lengthOfNeedMonths: number | null;
  patient: CmnPdfPatient;
  supplierName: string;
  /** Passed in (not derived) so tests are deterministic. */
  generatedOn: Date;
}

/** True when the form type is one this renderer knows. */
export function canRenderCmn(formType: string): boolean {
  return formType in CMN_FORMS;
}

export async function renderCmnPdf(input: CmnPdfInput): Promise<Buffer> {
  const def = CMN_FORMS[input.formType];
  if (!def) {
    throw new Error(`renderCmnPdf: unknown form type ${input.formType}`);
  }
  const doc = new PDFDocument({ size: "LETTER", margin: MARGIN });
  const chunks: Buffer[] = [];
  return new Promise<Buffer>((resolve, reject) => {
    doc.on("data", (c: Buffer) => chunks.push(c));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);
    try {
      drawCmn(doc, input, def);
      doc.end();
    } catch (err) {
      reject(err);
    }
  });
}

function drawCmn(
  doc: PDFKit.PDFDocument,
  input: CmnPdfInput,
  def: CmnFormDef,
): void {
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

  doc.fontSize(18).font("Helvetica-Bold").text(def.label, {
    align: "center",
    width: USABLE_WIDTH,
  });
  doc
    .fontSize(10)
    .font("Helvetica")
    .fillColor("#555555")
    .text(
      `${input.supplierName} · Certificate of Medical Necessity${
        input.status ? ` · ${input.status}` : ""
      }`,
      { align: "center", width: USABLE_WIDTH },
    )
    .fillColor("#000000");
  doc.moveDown(1);

  field(doc, "Generated", formatDate(input.generatedOn));
  field(doc, "HCPCS", input.hcpcsCode);
  if (input.initialDate) {
    field(doc, "Initial date", formatIsoDate(input.initialDate));
  }
  if (input.recertDate) {
    field(doc, "Recertification date", formatIsoDate(input.recertDate));
  }
  if (input.lengthOfNeedMonths != null) {
    field(
      doc,
      "Length of need",
      input.lengthOfNeedMonths === 99
        ? "Lifetime (99 months)"
        : `${input.lengthOfNeedMonths} month(s)`,
    );
  }
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
  const addr = formatAddress(input.patient.address);
  if (addr) field(doc, "Address", addr);
  doc.moveDown(0.6);
  rule(doc);
  doc.moveDown(0.8);

  header(doc, "Section B — Clinical questionnaire");
  const answers = input.answers ?? {};
  for (const q of def.questions) {
    const raw = answers[q.key];
    const answer = formatAnswer(raw);
    doc
      .fontSize(10)
      .font("Helvetica-Bold")
      .text(`${q.label}`, { width: USABLE_WIDTH });
    if (answer) {
      doc.font("Helvetica").text(answer, { width: USABLE_WIDTH, indent: 12 });
    } else {
      // Unanswered → a blank rule the physician/clinician can fill in.
      doc
        .font("Helvetica")
        .fillColor("#999999")
        .text("____________________________________________", {
          width: USABLE_WIDTH,
          indent: 12,
        })
        .fillColor("#000000");
    }
    doc.moveDown(0.4);
  }
  doc.moveDown(0.4);
  rule(doc);
  doc.moveDown(0.8);

  header(doc, "Section A — Ordering physician");
  if (input.physicianName) field(doc, "Name", input.physicianName);
  if (input.physicianNpi) field(doc, "NPI", input.physicianNpi);
  if (!input.physicianName && !input.physicianNpi) {
    doc
      .fontSize(10)
      .font("Helvetica-Oblique")
      .fillColor("#555555")
      .text("No ordering physician recorded on this CMN.", {
        width: USABLE_WIDTH,
      })
      .fillColor("#000000");
  }
  doc.moveDown(1);

  doc
    .fontSize(9)
    .font("Helvetica-Oblique")
    .fillColor("#555555")
    .text(
      "Physician attestation: I certify that the medical necessity information above is " +
        "true, accurate, and complete to the best of my knowledge, and that I am the " +
        "treating physician identified in Section A.",
      { width: USABLE_WIDTH },
    )
    .fillColor("#000000");
  doc.moveDown(1);
  doc.fontSize(10).font("Helvetica");
  doc.text("Physician signature: ____________________________________", {
    width: USABLE_WIDTH,
  });
  doc.moveDown(0.4);
  doc.text("Date: __________________", { width: USABLE_WIDTH });

  const footerY = 730;
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

function formatAnswer(raw: unknown): string {
  if (raw === null || raw === undefined) return "";
  if (typeof raw === "boolean") return raw ? "Yes" : "No";
  if (typeof raw === "number") return Number.isFinite(raw) ? String(raw) : "";
  if (typeof raw === "string") return raw.trim();
  return String(raw);
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

function formatAddress(a: CmnPdfPatient["address"]): string | null {
  if (!a) return null;
  const zip = a.zip ?? a.postalCode ?? a.postal_code;
  const parts: string[] = [];
  if (a.line1) parts.push(a.line1);
  if (a.line2) parts.push(a.line2);
  const cityState = [a.city, a.state].filter(Boolean).join(", ");
  const tail = [cityState, zip].filter(Boolean).join(" ");
  if (tail) parts.push(tail);
  return parts.length > 0 ? parts.join("\n") : null;
}
